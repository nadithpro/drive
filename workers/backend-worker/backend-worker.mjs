import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { randomUUID } from "node:crypto"

const serverUrl = String(process.env.SERVER_URL || "").replace(/\/+$/, "")
const token = String(process.env.TOKEN || "")
const agentId = String(process.env.AGENT_ID || "")
const migrationId = String(process.env.DRIVE_MIGRATION_ID || "")
const generation = Number(process.env.DRIVE_WORKER_GENERATION || 0)
const instanceId = String(process.env.WORKER_INSTANCE_ID || process.env.GITHUB_RUN_ID || randomUUID())
const maxRuntimeSeconds = Math.max(60, Number(process.env.MAX_RUNTIME_SECONDS || 21300))
const deadline = Date.now() + maxRuntimeSeconds * 1000
const pageSize = Math.max(100, Math.min(1000, Number(process.env.SCAN_PAGE_SIZE || 1000)))
const s3Clients = new Map()

if (!serverUrl || !token || !agentId || !migrationId || !Number.isInteger(generation) || generation < 1) {
  throw new Error("Backend Worker dispatch is missing its authenticated migration configuration")
}

async function post(path, body) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token, agentId, migrationId, generation, instanceId }),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || `Migration Orchestrator returned HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return payload
}

function makeClient(account, jurisdiction) {
  const jurisdictionPart = jurisdiction && jurisdiction !== "default" ? `.${jurisdiction}` : ""
  const endpoint = `https://${account.cloudflareAccountId}${jurisdictionPart}.r2.cloudflarestorage.com`
  const key = `${endpoint}:${account.accessKeyId}`
  if (s3Clients.has(key)) return s3Clients.get(key)
  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey },
  })
  s3Clients.set(key, client)
  return client
}

async function runTask(task) {
  const account = task.phase === "destination" ? task.targetAccount : task.sourceAccount
  const bucket = task.phase === "destination" ? task.targetBucket : task.sourceBucket
  const client = makeClient(account, task.jurisdiction)
  let heartbeatError = null
  const heartbeat = setInterval(() => {
    void post(`/workers/${encodeURIComponent(agentId)}/backend-heartbeat`, {
      taskId: task.id,
      leaseToken: task.leaseToken,
      verificationItemId: task.verificationItemId || null,
      phase: task.phase,
    }).catch((error) => { heartbeatError = error })
  }, 20_000)
  try {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: pageSize,
      ContinuationToken: task.cursor || undefined,
      Prefix: task.prefix || undefined,
    }), { abortSignal: AbortSignal.timeout(60_000) })
    if (heartbeatError) throw heartbeatError
    const objects = (result.Contents || []).map((object) => ({
      key: String(object.Key || ""),
      size: Math.max(0, Number(object.Size) || 0),
      etag: object.ETag ? String(object.ETag) : null,
      lastModified: object.LastModified?.toISOString() || null,
      isDirectoryMarker: String(object.Key || "").endsWith("/") && Number(object.Size || 0) === 0,
    })).filter((object) => object.key)
    if (result.IsTruncated && (!result.NextContinuationToken || result.NextContinuationToken === task.cursor)) {
      throw new Error("R2 returned a truncated listing without a forward continuation token")
    }
    await post(`/workers/${encodeURIComponent(agentId)}/backend-page`, {
      taskId: task.id,
      leaseToken: task.leaseToken,
      verificationItemId: task.verificationItemId || null,
      phase: task.phase,
      objects,
      cursor: result.NextContinuationToken || null,
      truncated: result.IsTruncated === true,
      lastKey: objects.at(-1)?.key || task.lastKey || null,
    })
  } finally {
    clearInterval(heartbeat)
  }
}

await post(`/workers/${encodeURIComponent(agentId)}/bootstrap`, { workerType: "backend", migrationId, generation })
let failed = false
let idleClaims = 0
try {
  while (Date.now() < deadline) {
    const claimed = await post(`/workers/${encodeURIComponent(agentId)}/backend-claim`, {})
    if (claimed.migrationComplete || claimed.generationSuperseded) break
    if (!claimed.task) {
      idleClaims += 1
      if (idleClaims >= 12) break
      await new Promise((resolve) => setTimeout(resolve, Math.max(2_000, Number(claimed.retryAfterMs || 10_000))))
      continue
    }
    idleClaims = 0
    try {
      await runTask(claimed.task)
    } catch (error) {
      if (error?.status === 409) break
      await post(`/workers/${encodeURIComponent(agentId)}/backend-fail`, {
        taskId: claimed.task.id,
        leaseToken: claimed.task.leaseToken,
        verificationItemId: claimed.task.verificationItemId || null,
        phase: claimed.task.phase,
        error: String(error?.message || error).slice(0, 2000),
        errorCode: String(error?.code || error?.name || "").slice(0, 100),
        errorStatus: Number(error?.$metadata?.httpStatusCode || error?.status || 0),
      }).catch(() => undefined)
      if (error?.status >= 400 && error?.status < 500) throw error
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
} catch (error) {
  failed = true
  throw error
} finally {
  await post(`/workers/${encodeURIComponent(agentId)}/backend-finish`, { failed, summary: failed ? "Backend Worker run failed; unfinished pages remain resumable" : "Backend Worker run finished; unfinished scans remain resumable" }).catch(() => undefined)
  for (const client of s3Clients.values()) client.destroy()
}
