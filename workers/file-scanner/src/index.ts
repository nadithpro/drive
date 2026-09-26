import { Client } from "pg"
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { DOMParser } from "@xmldom/xmldom"

if (!(globalThis as { DOMParser?: unknown }).DOMParser) (globalThis as { DOMParser?: unknown }).DOMParser = DOMParser
if (!(globalThis as { Node?: unknown }).Node) (globalThis as { Node?: unknown }).Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }

type ScanMessage = { reason: "continue" }
type Env = { POSTGRES_URL?: string; FILE_SCANNER_SECRET?: string; PANEL_URL?: string; DISABLE_POSTGRES_SSL?: string; FILE_SCAN_QUEUE: Queue<ScanMessage> }
type Row = Record<string, any>
type ClaimedTask = { kind: "migration" | "generic"; task: Row }
type ClaimedCycle = { ok: true; owner: string; tasks: ClaimedTask[] } | { ok: true; skipped: string } | { ok: true; idle: true }
const BUILD = 21
const MAX_SECRET_LENGTH = 512
// Workers Free allows only 10 ms of CPU per invocation. Keep each invocation
// deliberately small; queue continuations immediately schedule the next
// durable page, so large buckets still drain without oversized JSON/SQL work.
const SCAN_CONCURRENCY = 1
const DATABASE_RETRY_DELAYS_MS = [250, 1_000, 3_000]
const DATABASE_RETRY_DELAYS_WITH_FINAL_BACKOFF_MS = [...DATABASE_RETRY_DELAYS_MS, 8_000]
const DATABASE_QUERY_TIMEOUT_MS = 45_000
const R2_REQUEST_TIMEOUT_MS = 30_000
const SCANNER_STATE_LEASE_MS = 150_000
const SCANNER_HEARTBEAT_MS = 30_000
const TASK_HEARTBEAT_MS = 20_000
const MIN_PAGE_SIZE = 50
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250
let adaptivePageSize = DEFAULT_PAGE_SIZE
function isTransientScanError(error: unknown) {
  const value = error && typeof error === "object" ? error as { message?: unknown; name?: unknown; code?: unknown; status?: unknown; $metadata?: { httpStatusCode?: unknown } } : {}
  const message = `${String(value.name || "")} ${String(value.message || error || "")}`
  const code = String(value.code || "").toUpperCase()
  const status = Number(value.$metadata?.httpStatusCode || value.status || 0)
  return /connection terminated unexpectedly|connection reset|connection closed|server closed the connection unexpectedly|client has encountered a connection error|not queryable|socket hang up|econn(?:reset|refused)|etimedout|eai_again|enotfound|enetunreach|epipe|fetch failed|time(?:out|d out)|temporar(?:y|ily) unavailable|too many (?:requests|connections|clients)|slow down|throttl|\bHTTP (?:408|425|429|500|502|503|504)\b|\b(?:57P01|57P03|53300|08000|08001|08003|08004|08006|08007|40001|40P01)\b/i.test(message)
    || /^(?:57P01|57P03|53300|08000|08001|08003|08004|08006|08007|40001|40P01)$/.test(code)
    || [408, 425, 429].includes(status) || status >= 500
}
let authCache: { value: string[]; expiresAt: number } | null = null
let schemaReady: Promise<void> | null = null

function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store, max-age=0" } }) }
function safeEqual(a: string, b: string) {
  if (a.length > MAX_SECRET_LENGTH || b.length > MAX_SECRET_LENGTH) return false
  let different = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) different |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return different === 0
}
async function authorized(request: Request, env: Env) {
  const value = request.headers.get("authorization") || ""
  if (!value.toLowerCase().startsWith("bearer ")) return false
  const supplied = value.slice(7).trim()
  if (authCache && authCache.expiresAt > Date.now()) return authCache.value.some((value) => safeEqual(supplied, value))
  return database(env, async (db) => {
    const expected = String(env.FILE_SCANNER_SECRET || "")
    const stored = String((await db.query(`select value->>'fileScannerSecret' secret from drive_app_settings where key='migration-orchestrator' limit 1`)).rows[0]?.secret || "")
    if (!safeEqual(expected, stored)) return false
    if (expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH) authCache = { value: [expected], expiresAt: Date.now() + 30_000 }
    return expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH && safeEqual(supplied, expected)
  }).catch(() => false)
}
async function database<T>(env: Env, operation: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = String(env.POSTGRES_URL || "").trim()
  if (!connectionString) throw new Error("POSTGRES_URL is not configured")
  const hostname = new URL(connectionString).hostname
  const sslMode = new URL(connectionString).searchParams.get("sslmode")?.trim().toLowerCase()
  const disableSsl = ["1", "true"].includes(String(env.DISABLE_POSTGRES_SSL || "").toLowerCase()) || sslMode === "disable"
  const client = new Client({ connectionString, ssl: disableSsl || ["localhost", "127.0.0.1"].includes(hostname) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8_000, query_timeout: DATABASE_QUERY_TIMEOUT_MS, statement_timeout: DATABASE_QUERY_TIMEOUT_MS })
  await client.connect()
  try { return await operation(client) } finally { await client.end().catch(() => undefined) }
}
async function ensureSchema(db: Client) {
  schemaReady ??= db.query(`
    create table if not exists drive_file_scanner_state (
      id boolean primary key default true check(id),status text not null default 'idle',last_started_at timestamptz,last_completed_at timestamptz,
      last_error text,last_result jsonb not null default '{}'::jsonb,cycle_count bigint not null default 0,updated_at timestamptz not null default now()
    );
    alter table if exists drive_migration_verification_state add column if not exists attempt_generation integer;
    create index if not exists drive_migration_verification_state_queue_idx on drive_migration_verification_state(status,updated_at);
  `).then(() => undefined).catch((error) => {
    schemaReady = null
    throw error
  })
  await schemaReady
}
async function databaseTaskWithRetry<T>(env: Env, operation: (client: Client) => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= DATABASE_RETRY_DELAYS_WITH_FINAL_BACKOFF_MS.length; attempt += 1) {
    try {
      // A fresh client is required after a dropped PostgreSQL connection;
      // pg clients are not recoverable once they report "not queryable".
      return await database(env, operation)
    } catch (error) {
      lastError = error
      if (!isTransientScanError(error) || attempt === DATABASE_RETRY_DELAYS_WITH_FINAL_BACKOFF_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, DATABASE_RETRY_DELAYS_WITH_FINAL_BACKOFF_MS[attempt]))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
// R2 accepts up to 1,000 keys, but that payload is too CPU-heavy for Workers
// Free once it is parsed, serialized, and persisted through jsonb_recordset.
// Smaller pages are independently committed and resumed by their cursor.
function pageSize(_env: Env) { return adaptivePageSize }
function tunePageSize(elapsedMs: number, succeeded: boolean) {
  if (!succeeded) {
    adaptivePageSize = Math.max(MIN_PAGE_SIZE, Math.floor(adaptivePageSize / 2))
    return
  }
  // Grow only when the complete R2-list plus DB-commit round trip is quick.
  // This maximizes throughput without returning to the free-plan CPU cliff.
  if (elapsedMs < 3_000) adaptivePageSize = Math.min(MAX_PAGE_SIZE, adaptivePageSize + 25)
  else if (elapsedMs > 8_000) adaptivePageSize = Math.max(MIN_PAGE_SIZE, adaptivePageSize - 25)
}
async function listObjects(env: Env, account: Row, bucket: string, cursor: string | null, jurisdiction: string | null, prefix: string | null = null) {
  if (!account.cloudflare_account_id || !account.r2_access_key_id || !account.r2_secret_access_key) throw new Error("R2 S3 account credentials are missing")
  const jurisdictionPart = jurisdiction && jurisdiction !== "default" ? `.${jurisdiction.toLowerCase()}` : ""
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${account.cloudflare_account_id}${jurisdictionPart}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: account.r2_access_key_id, secretAccessKey: account.r2_secret_access_key },
  })
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: pageSize(env), ContinuationToken: cursor || undefined, Prefix: prefix || undefined }), { abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) })
  const objects = (result.Contents || []).map((object) => ({
    key: String(object.Key || ""), size: Math.max(0, Number(object.Size) || 0), etag: object.ETag ? String(object.ETag) : null,
    last_modified: object.LastModified?.toISOString() || null, is_dir_marker: String(object.Key || "").endsWith("/") && Number(object.Size || 0) === 0,
  })).filter((object) => object.key)
  return { objects, truncated: result.IsTruncated === true, cursor: result.NextContinuationToken || null }
}

async function claim(db: Client, owner: string): Promise<Row | null> {
  let result
  try {
    result = await db.query(`
    with candidate as (
      select v.migration_item_id,i.source_bucket,i.target_bucket,i.source_jurisdiction,coalesce(target_settings.jurisdiction,i.source_jurisdiction,'default') target_jurisdiction,m.source_account_id,m.target_account_id,
        nullif(m.options->>'pathPrefix','') scan_prefix,m.options->>'executionMode' execution_mode,
        coalesce((m.options->>'overwrite')::boolean,true) overwrite,
        jsonb_build_object('cloudflare_account_id',sa.cloudflare_account_id,'r2_access_key_id',sa.r2_access_key_id,'r2_secret_access_key',sa.r2_secret_access_key) source_account,
        jsonb_build_object('cloudflare_account_id',ta.cloudflare_account_id,'r2_access_key_id',ta.r2_access_key_id,'r2_secret_access_key',ta.r2_secret_access_key) target_account
      from drive_migration_verification_state v join drive_migrations m on m.id=v.migration_id
        join drive_migration_items i on i.id=v.migration_item_id
        join drive_accounts sa on sa.id=m.source_account_id join drive_accounts ta on ta.id=m.target_account_id
        left join drive_bucket_settings_snapshots target_settings on target_settings.account_id=m.target_account_id and target_settings.bucket_name=i.target_bucket
      -- Verify a bucket only after its own inventory and transfer jobs finish.
      -- Unfinished transfers in other buckets do not block this bucket.
      where m.status in('running','verifying')
        and (m.options->>'executionMode' is distinct from 'migration_workers' or (
          i.progress->'migrationInventory'->>'status'='completed'
          and i.progress->'migrationQueue'->>'status'='completed'
          and not exists(select 1 from drive_repair_jobs j where j.migration_id=m.id
            and j.work_key like format('migration:%s:generation:%s:inventory:%%',m.id,greatest(1,coalesce(nullif(m.options->>'workerGeneration','')::int,1)))
            and j.payload->'itemIds'->>0=i.id::text
            and j.status<>'completed')
        ))
        and ((v.status='pending' and (v.attempt_count=0 or v.updated_at<=now()-make_interval(mins=>least(30,power(2,least(v.attempt_count,5))::int))))
          or (v.status='running' and (v.lease_expires_at is null or v.lease_expires_at<now())))
      order by v.updated_at for update of v skip locked limit 1
    )
    update drive_migration_verification_state v set status='running',lease_owner=$1,lease_expires_at=now()+interval '90 seconds',
      attempt_count=case when v.attempt_generation is distinct from v.generation then 0 else v.attempt_count end,
      attempt_generation=v.generation,last_error=case when v.attempt_generation is distinct from v.generation then null else v.last_error end,updated_at=now()
    from candidate c where v.migration_item_id=c.migration_item_id
    returning v.*,c.source_bucket,c.target_bucket,c.source_jurisdiction,c.target_jurisdiction,c.source_account_id,c.target_account_id,c.source_account,c.target_account,c.execution_mode,c.overwrite
    `, [owner])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`File Scanner verification claim failed: ${message}`)
  }
  return result.rows[0] || null
}
async function claimGenericScan(db: Client, owner: string): Promise<Row | null> {
  const result = await db.query(`
    with candidate as (
      select s.id,s.account_id,s.bucket_name,s.prefix,s.cursor,a.cloudflare_account_id,a.r2_access_key_id,a.r2_secret_access_key,coalesce(bs.jurisdiction,'default') jurisdiction
      from drive_bucket_scans s join drive_accounts a on a.id=s.account_id
      left join drive_bucket_settings_snapshots bs on bs.account_id=s.account_id and bs.bucket_name=s.bucket_name
      where (
          (s.status='pending' and (s.attempt_count=0 or s.updated_at<=now()-make_interval(mins=>least(30,power(2,least(s.attempt_count,5))::int))))
          or (s.status='running' and (s.lease_expires_at is null or s.lease_expires_at<now()))
        )
        and (s.migration_id is null or exists(select 1 from drive_migrations m where m.id=s.migration_id and m.status in('running','verifying')))
        and not exists (
          select 1 from drive_migration_verification_state v
          where v.source_scan_id=s.id or v.destination_scan_id=s.id
        )
      order by s.updated_at for update of s skip locked limit 1
    )
    update drive_bucket_scans s set status='running',lease_owner=$1,lease_expires_at=now()+interval '90 seconds',started_at=coalesce(started_at,now()),updated_at=now()
    from candidate c where s.id=c.id
    returning s.*,c.cloudflare_account_id,c.r2_access_key_id,c.r2_secret_access_key,c.jurisdiction
  `, [owner])
  return result.rows[0] || null
}
async function ensureScan(db: Client, task: Row, phase: "source" | "destination") {
  const column = phase === "source" ? "source_scan_id" : "destination_scan_id"
  if (task[column]) return task[column]
  const id = crypto.randomUUID()
  const accountId = phase === "source" ? task.source_account_id : task.target_account_id
  const bucket = phase === "source" ? task.source_bucket : task.target_bucket
  const attached = await db.query(`
    with eligible as (
      select migration_item_id from drive_migration_verification_state
      where migration_item_id=$6 and generation=$7 and lease_owner=$8 for update
    ), created as (
      insert into drive_bucket_scans(id,account_id,bucket_name,kind,migration_id,migration_item_id,status,started_at,updated_at)
      select $1,$2,$3,$4,$5,$6,'running',now(),now() from eligible returning id
    ), attached as (
      update drive_migration_verification_state v set ${column}=c.id,updated_at=now()
      from created c where v.migration_item_id=$6 and v.generation=$7 and v.lease_owner=$8 returning c.id
    ) select id from attached
  `, [id, accountId, bucket, phase === "source" ? "source" : "dest", task.migration_id, task.migration_item_id, task.generation, task.lease_owner])
  if (!attached.rowCount) throw new Error("File Scanner task lease was lost")
  return attached.rows[0].id
}
async function persistMigrationPage(db: Client, scanId: string, task: Row, phase: "source" | "destination", page: Row) {
  const cursorColumn = phase === "source" ? "source_cursor" : "destination_cursor"
  const objectsColumn = phase === "source" ? "source_objects" : "destination_objects"
  const bytesColumn = phase === "source" ? "source_bytes" : "destination_bytes"
  const nextPhase = page.truncated ? phase : phase === "source" ? "destination" : "compare"
  const cursor = page.truncated ? page.cursor : null
  const objects = [...new Map((page.objects as Row[]).map((object) => [object.key, object])).values()]

  // Persist object rows, exact count/byte deltas, and the continuation cursor
  // in one transaction. If a Worker retries after a crash, the cursor and rows
  // are either both committed or neither is; conflict updates contribute only
  // the difference from the previously stored object.
  await db.query("begin")
  try {
    const saved = await db.query(`
      with lease as (
        select migration_item_id from drive_migration_verification_state
        where migration_item_id=$2::uuid and generation=$3::int and lease_owner=$4::text
        for update
      ), incoming as (
        select x.key,x.size,x.is_dir_marker,x.etag,x.last_modified
        from jsonb_to_recordset($5::jsonb) as x(key text,size bigint,is_dir_marker boolean,etag text,last_modified timestamptz)
      ), previous as (
        select o.key,o.size,o.is_dir_marker from drive_bucket_scan_objects o
        join incoming i on i.key=o.key where o.scan_id=$1::uuid
      ), delta as (
        select
          coalesce(sum((case when i.is_dir_marker then 0 else 1 end)-(case when p.key is not null and not p.is_dir_marker then 1 else 0 end)),0)::bigint object_delta,
          coalesce(sum((case when i.is_dir_marker then 0 else i.size end)-(case when p.key is not null and not p.is_dir_marker then p.size else 0 end)),0)::bigint byte_delta
        from incoming i left join previous p on p.key=i.key
      ), upserted as (
        insert into drive_bucket_scan_objects(scan_id,key,size,is_dir_marker,etag,last_modified)
        select $1::uuid,key,size,is_dir_marker,etag,last_modified from incoming
        on conflict(scan_id,key) do update set size=excluded.size,is_dir_marker=excluded.is_dir_marker,etag=excluded.etag,last_modified=excluded.last_modified
        returning key
      ), saved_scan as (
        update drive_bucket_scans s set
          objects=greatest(0,coalesce(s.objects,0)+d.object_delta),
          bytes=greatest(0,coalesce(s.bytes,0)+d.byte_delta),
          status=case when $6::boolean then 'running' else 'completed' end,
          error=null,
          last_key=$7::text,
          completed_at=case when $6::boolean then s.completed_at else now() end,
          updated_at=now()
        from delta d,(select count(*) from upserted) writes
        where s.id=$1::uuid and exists(select 1 from lease)
        returning s.id
      ), saved_state as (
        update drive_migration_verification_state v set
          ${cursorColumn}=$8::text,
          ${objectsColumn}=greatest(0,coalesce(v.${objectsColumn},0)+d.object_delta),
          ${bytesColumn}=greatest(0,coalesce(v.${bytesColumn},0)+d.byte_delta),
          phase=$9::text,status='pending',attempt_count=0,last_error=null,
          lease_owner=null,lease_expires_at=null,updated_at=now()
        from delta d,saved_scan s
        where v.migration_item_id=$2::uuid and v.generation=$3::int and v.lease_owner=$4::text
        returning v.migration_item_id
      )
      select exists(select 1 from saved_state) advanced from delta
    `, [scanId, task.migration_item_id, task.generation, task.lease_owner, JSON.stringify(objects), page.truncated, objects.at(-1)?.key || null, cursor, nextPhase])
    if (saved.rows[0]?.advanced !== true) throw new Error("File Scanner task lease was lost")
    await db.query("commit")
    return { pageObjects: objects.length, continued: page.truncated }
  } catch (error) {
    await db.query("rollback")
    throw error
  }
}
async function compare(db: Client, task: Row) {
  await db.query("begin")
  try {
    const locked = await db.query(`
      with guard as (
        select migration_item_id from drive_migration_verification_state
        where migration_item_id=$1::uuid and generation=$2::int and lease_owner=$3::text for update
      ), deleted as (
        delete from drive_bucket_verify_diffs d using guard g where d.migration_item_id=g.migration_item_id returning d.id
      ) select exists(select 1 from guard) acquired
    `, [task.migration_item_id, task.generation, task.lease_owner])
    if (locked.rows[0]?.acquired !== true) throw new Error("File Scanner task lease was lost")
    const completed = await db.query(`
      with source_diffs as (
        insert into drive_bucket_verify_diffs(id,migration_item_id,source_scan_id,dest_scan_id,kind,key,source_size,dest_size)
        select gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,case when d.key is null then 'missing' else 'size_mismatch' end,s.key,s.size,d.size
        from drive_bucket_scan_objects s left join drive_bucket_scan_objects d on d.scan_id=$3::uuid and d.key=s.key
        where s.scan_id=$2::uuid and not s.is_dir_marker and (
          d.key is null or ($8::boolean and (d.size<>s.size or
          (trim(both '"' from coalesce(s.etag,'')) ~ '^[0-9a-fA-F]{32}$' and trim(both '"' from coalesce(d.etag,'')) ~ '^[0-9a-fA-F]{32}$' and trim(both '"' from s.etag)<>trim(both '"' from d.etag)) or
          ($6='migration_workers' and not exists (
            select 1 from drive_repair_jobs j
            where j.migration_id=$7::uuid and j.status='completed'
              and j.payload->>'workerGeneration'=$4::text
              and j.payload->'itemIds'->>0=$1::text
              and j.payload->'inventoryObjects'->0->>'key'=s.key
              and trim(both '"' from coalesce(j.payload->'inventoryObjects'->0->>'etag',''))=trim(both '"' from coalesce(s.etag,''))
              and j.result->'items'->0->'integrityProofs'->0->>'key'=s.key
              and j.result->'items'->0->'integrityProofs'->0->>'verified'='true'
              and j.result->'items'->0->'integrityProofs'->0->>'sha256' ~ '^[0-9a-f]{64}$'
              and trim(both '"' from coalesce(j.result->'items'->0->'integrityProofs'->0->>'destinationEtag',''))=trim(both '"' from coalesce(d.etag,''))
          )))
        )) returning kind
      ), extra_diffs as (
        insert into drive_bucket_verify_diffs(id,migration_item_id,source_scan_id,dest_scan_id,kind,key,source_size,dest_size)
        select gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'extra',d.key,null,d.size from drive_bucket_scan_objects d
        left join drive_bucket_scan_objects s on s.scan_id=$2::uuid and s.key=d.key and not s.is_dir_marker
        where d.scan_id=$3::uuid and not d.is_dir_marker and s.key is null
        returning kind
      ), counts as (
        select count(*) filter(where kind='missing')::int missing,
          count(*) filter(where kind='size_mismatch')::int mismatched,
          count(*) filter(where kind='extra')::int extra
        from (select kind from source_diffs union all select kind from extra_diffs) all_diffs
      ), state_done as (
        update drive_migration_verification_state v set status='completed',phase='complete',missing_objects=c.missing,
          mismatched_objects=c.mismatched,extra_objects=c.extra,attempt_count=0,last_error=null,
          lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now()
        from counts c where v.migration_item_id=$1::uuid and v.generation=$4::int and v.lease_owner=$5::text
        returning c.missing,c.mismatched,c.extra
      ), item_done as (
        update drive_migration_items i set last_progress_at=now(),updated_at=now(),
          progress=jsonb_set(jsonb_set(coalesce(i.progress,'{}'::jsonb),'{fileVerification}',jsonb_build_object(
            'status','completed','missing',s.missing,'mismatched',s.mismatched,'extra',s.extra,'generation',$4::int,'completedAt',now()
          )), '{stage}','"file_verification_completed"'::jsonb)
        from state_done s where i.id=$1::uuid returning i.id
      ) select missing,mismatched,extra from state_done
    `, [task.migration_item_id, task.source_scan_id, task.destination_scan_id, task.generation, task.lease_owner, task.execution_mode || null, task.migration_id, task.overwrite !== false])
    if (!completed.rowCount) throw new Error("File Scanner task lease was lost")
    await db.query("commit")
    const value = completed.rows[0]
    return { missing: Number(value.missing), mismatched: Number(value.mismatched), extra: Number(value.extra) }
  } catch (error) { await db.query("rollback"); throw error }
}
async function wakeMigrationOrchestrator(db: Client) {
  const result = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
  const settings = result.rows[0]?.value || {}
  if (!settings.orchestratorUrl || !settings.sharedSecret) return "not_configured"
  try {
    const response = await fetch(`${String(settings.orchestratorUrl).replace(/\/+$/, "")}/wake`, { method: "POST", headers: { Authorization: `Bearer ${settings.sharedSecret}` }, signal: AbortSignal.timeout(8_000) })
    return response.ok ? "signaled" : `http_${response.status}`
  } catch { return "deferred_to_cron" }
}
async function compareAndWake(db: Client, task: Row) {
  const result = await compare(db, task)
  return { ...result, migrationOrchestrator: await wakeMigrationOrchestrator(db) }
}
async function processTask(db: Client, env: Env, task: Row) {
  if (task.phase === "compare") return { itemId: task.migration_item_id, phase: "compare", ...(await compareAndWake(db, task)) }
  const phase: "source" | "destination" = task.phase === "destination" ? "destination" : "source"
  const scanId = await ensureScan(db, task, phase)
  task[phase === "source" ? "source_scan_id" : "destination_scan_id"] = scanId
  const account = phase === "source" ? task.source_account : task.target_account
  const bucket = phase === "source" ? task.source_bucket : task.target_bucket
  const cursor = phase === "source" ? task.source_cursor : task.destination_cursor
  const jurisdiction = phase === "source" ? task.source_jurisdiction : task.target_jurisdiction
  const page = await listObjects(env, account, bucket, cursor, jurisdiction || null, task.scan_prefix || null)
  if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error("R2 returned a truncated page without a forward cursor")
  const persisted = await persistMigrationPage(db, scanId, task, phase, page)
  if (page.truncated) return { itemId: task.migration_item_id, phase, ...persisted }
  if (phase === "source") return { itemId: task.migration_item_id, phase, ...persisted }
  const refreshed = (await db.query(`select * from drive_migration_verification_state where migration_item_id=$1`, [task.migration_item_id])).rows[0]
  return { itemId: task.migration_item_id, phase: "compare", ...(await compareAndWake(db, { ...task, ...refreshed })) }
}
async function processGenericScan(db: Client, env: Env, task: Row) {
  const account = { cloudflare_account_id: task.cloudflare_account_id, r2_access_key_id: task.r2_access_key_id, r2_secret_access_key: task.r2_secret_access_key }
  const page = await listObjects(env, account, task.bucket_name, task.cursor || null, task.jurisdiction || null, task.prefix || null)
  if (page.truncated && (!page.cursor || page.cursor === task.cursor)) throw new Error("R2 returned a truncated page without a forward cursor")
  const objects = [...new Map((page.objects as Row[]).map((object) => [object.key, object])).values()]
  const updated = await db.query(`
    with lease as (
      select id,migration_id from drive_bucket_scans where id=$1::uuid and lease_owner=$5::text for update
    ), incoming as (
      select x.key,x.size,x.is_dir_marker,x.etag,x.last_modified
      from jsonb_to_recordset($6::jsonb) as x(key text,size bigint,is_dir_marker boolean,etag text,last_modified timestamptz)
    ), previous as (
      select o.key,o.size,o.is_dir_marker from drive_bucket_scan_objects o
      join incoming i on i.key=o.key where o.scan_id=$1::uuid
    ), delta as (
      select
        coalesce(sum((case when i.is_dir_marker then 0 else 1 end)-(case when p.key is not null and not p.is_dir_marker then 1 else 0 end)),0)::bigint object_delta,
        coalesce(sum((case when i.is_dir_marker then 0 else i.size end)-(case when p.key is not null and not p.is_dir_marker then p.size else 0 end)),0)::bigint byte_delta
      from incoming i left join previous p on p.key=i.key
    ), upserted as (
      insert into drive_bucket_scan_objects(scan_id,key,size,is_dir_marker,etag,last_modified)
      select $1::uuid,key,size,is_dir_marker,etag,last_modified from incoming where exists(
        select 1 from lease l where l.id=$1::uuid and (l.migration_id is null or exists(select 1 from drive_migrations m where m.id=l.migration_id and m.status in('running','verifying')))
      )
      on conflict(scan_id,key) do update set size=excluded.size,is_dir_marker=excluded.is_dir_marker,etag=excluded.etag,last_modified=excluded.last_modified
      returning key
    ), saved_scan as (
      update drive_bucket_scans s set cursor=$2::text,status=$3::text,
        objects=greatest(0,coalesce(s.objects,0)+d.object_delta),bytes=greatest(0,coalesce(s.bytes,0)+d.byte_delta),
        last_key=$4::text,error=null,attempt_count=0,lease_owner=null,lease_expires_at=null,
        completed_at=case when $3::text='completed' then now() else null end,updated_at=now()
      from delta d,(select count(*) from upserted) writes
      where s.id=$1::uuid and exists(
        select 1 from lease l where l.id=s.id and (l.migration_id is null or exists(select 1 from drive_migrations m where m.id=l.migration_id and m.status in('running','verifying')))
      )
      returning s.id,s.migration_id,s.migration_item_id,s.kind,s.objects,s.bytes,s.status
    ), saved_item as (
      update drive_migration_items i set source_objects=s.objects,source_bytes=s.bytes,
        progress=coalesce(i.progress,'{}'::jsonb)||jsonb_build_object(
          'sourceScanId',s.id::text,'sourceScanStatus',case when s.status='completed' then 'completed' else 'running' end,
          'sourceScanObjects',s.objects,'sourceScanBytes',s.bytes,
          'stage',case when s.status='completed' then 'scan_completed' else 'scanning_source' end
        ),last_progress_at=now(),updated_at=now()
      from saved_scan s where s.kind='source' and s.migration_id is not null and s.migration_item_id is not null
        and not exists(select 1 from drive_migration_verification_state v where v.source_scan_id=s.id)
        and i.id=s.migration_item_id and i.migration_id=s.migration_id
      returning i.id
    )
    select s.id,s.migration_id,s.migration_item_id,s.kind,s.objects,s.bytes,s.status,(select count(*) from saved_item) item_syncs
    from saved_scan s
  `, [task.id, page.truncated ? page.cursor : null, page.truncated ? "pending" : "completed", objects.at(-1)?.key || task.last_key || null, task.lease_owner, JSON.stringify(objects)])
  if (!updated.rowCount) throw new Error("File Scanner generic scan lease was lost")
  const scan = updated.rows[0]
  return { scanId: task.id, phase: "inventory", pageObjects: objects.length, continued: page.truncated, ...scan }
}
async function finishState(db: Client, owner: string, result: Row, error?: string) {
  await db.query(`update drive_file_scanner_state set status=$1,lease_owner=null,last_completed_at=now(),last_error=$2,last_result=$3::jsonb,cycle_count=cycle_count+1,updated_at=now() where id=true and lease_owner=$4`, [error ? "error" : "idle", error || null, JSON.stringify(result), owner])
}
async function heartbeatState(env: Env, owner: string) {
  await database(env, async (db) => {
    await db.query(`update drive_file_scanner_state set last_started_at=now(),updated_at=now() where id=true and status='running' and lease_owner=$1`, [owner])
  })
}
async function heartbeatTask(env: Env, kind: ClaimedTask["kind"], task: Row) {
  await database(env, async (db) => {
    const result = kind === "migration"
      ? await db.query(`update drive_migration_verification_state set lease_expires_at=now()+interval '90 seconds' where migration_item_id=$1 and generation=$2 and status='running' and lease_owner=$3`, [task.migration_item_id, task.generation, task.lease_owner])
      : await db.query(`update drive_bucket_scans set lease_expires_at=now()+interval '90 seconds' where id=$1 and status='running' and lease_owner=$2`, [task.id, task.lease_owner])
    if (result.rowCount !== 1) throw new Error("File Scanner task lease was lost")
  })
}
async function cycle(env: Env) {
  const claimed = await database<ClaimedCycle>(env, async (db) => {
    await ensureSchema(db)
    const owner = crypto.randomUUID()
    const lease = await db.query(`
      insert into drive_file_scanner_state(id,status,lease_owner,last_started_at,last_error,updated_at) values(true,'running',$1,now(),null,now())
      on conflict(id) do update set status='running',lease_owner=$1,last_started_at=now(),last_error=null,updated_at=now()
        where drive_file_scanner_state.status<>'running' or drive_file_scanner_state.last_started_at<now()-($2::int * interval '1 millisecond')
      returning id
    `, [owner, SCANNER_STATE_LEASE_MS])
    if (!lease.rowCount) return { ok: true as const, skipped: "cycle_already_running" }
    try {
      const setting = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
      if (setting.rows[0]?.value?.fileScannerEnabled !== true && setting.rows[0]?.value?.enabled !== true) {
        const result = { ok: true as const, skipped: "disabled" }
        await finishState(db, owner, result)
        return result
      }

      const tasks: ClaimedTask[] = []
      for (let slot = 0; slot < SCAN_CONCURRENCY; slot += 1) {
        const kinds = slot % 2 === 0 ? ["generic", "migration"] as const : ["migration", "generic"] as const
        let claimedTask: ClaimedTask | null = null
        for (const kind of kinds) {
          const task = kind === "generic" ? await claimGenericScan(db, owner) : await claim(db, owner)
          if (task) {
            claimedTask = { kind, task }
            break
          }
        }
        if (!claimedTask) break
        tasks.push(claimedTask)
      }
      if (!tasks.length) {
        const result = { ok: true as const, idle: true as const }
        await finishState(db, owner, result)
        return result
      }
      return { ok: true as const, owner, tasks }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishState(db, owner, { ok: false, error: message }, message).catch(() => undefined); throw error
    }
  })

  if (!("tasks" in claimed)) return claimed

  const heartbeat = setInterval(() => { void heartbeatState(env, claimed.owner).catch(() => undefined) }, SCANNER_HEARTBEAT_MS)
  try {
    const results = await Promise.all(claimed.tasks.map(async ({ kind, task }) => {
      const startedAt = Date.now()
      try {
        const taskHeartbeat = setInterval(() => { void heartbeatTask(env, kind, task).catch(() => undefined) }, TASK_HEARTBEAT_MS)
        try {
          const result = await databaseTaskWithRetry(env, async (db) => {
            const result = kind === "migration"
              ? await processTask(db, env, task)
              : await processGenericScan(db, env, task)
            return { ok: true, ...result }
          })
          tunePageSize(Date.now() - startedAt, true)
          return result
        } finally {
          clearInterval(taskHeartbeat)
        }
      } catch (error) {
        tunePageSize(Date.now() - startedAt, false)
        const message = error instanceof Error ? error.message : String(error)
        await database(env, async (db) => {
          if (kind === "migration") {
            await db.query(`update drive_migration_verification_state set status=case when $5::boolean then 'pending' else 'failed' end,attempt_count=attempt_count+1,last_error=$2,lease_owner=null,lease_expires_at=null,updated_at=now() where migration_item_id=$1 and generation=$3 and lease_owner=$4`, [task.migration_item_id, message, task.generation, task.lease_owner, isTransientScanError(error)])
          } else {
            await db.query(`update drive_bucket_scans set status=case when $4::boolean then 'pending' else 'failed' end,attempt_count=attempt_count+1,error=$2,lease_owner=null,lease_expires_at=null,updated_at=now() where id=$1 and lease_owner=$3`, [task.id, message, task.lease_owner, isTransientScanError(error)])
          }
        }).catch(() => undefined)
        console.error("File Scanner task failed", { kind, taskId: task.migration_item_id || task.id, error: message })
        return { ok: false, error: message, taskId: task.migration_item_id || task.id }
      }
    }))

    const failed = results.filter((result) => result.ok === false).length
    const summary = { ok: failed === 0, processed: results.length, failed, results }
    await database(env, async (db) => finishState(db, claimed.owner, summary, failed ? `${failed} of ${results.length} scan tasks failed` : undefined))
    return summary
  } finally {
    clearInterval(heartbeat)
  }
}

async function cycleAndContinue(env: Env) {
  const result = await cycle(env)
  const idle = "idle" in result && result.idle === true
  const skipped = "skipped" in result && Boolean(result.skipped)
  const failed = "ok" in result && result.ok === false
  if (!idle && !skipped && !failed) await env.FILE_SCAN_QUEUE.send({ reason: "continue" }, { contentType: "json" })
  return result
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "file-scanner", build: BUILD })
    }
    if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/status" && request.method === "GET") return json(await database(env, async (db) => { const [state,verificationQueue,inventoryQueue] = await Promise.all([db.query(`select * from drive_file_scanner_state where id=true`),db.query(`select status,count(*)::int count from drive_migration_verification_state group by status`),db.query(`select status,count(*)::int count,count(*) filter(where lease_expires_at>now())::int leased,min(updated_at) oldest_updated_at from drive_bucket_scans where status in('pending','running','failed') group by status`)]); return { ok: true, service: "file-scanner", build: BUILD, state: state.rows[0] || null, queue: verificationQueue.rows, inventoryScans: inventoryQueue.rows } }))
    if (url.pathname === "/run" && request.method === "POST" || url.pathname === "/wake" && request.method === "POST") { try { return json(await cycleAndContinue(env)) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503) } }
    return json({ error: "Not found" }, 404)
  },
  async queue(batch: MessageBatch<ScanMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        const result = await cycleAndContinue(env)
        if ("ok" in result && result.ok === false) throw new Error("One or more File Scanner tasks failed")
        message.ack()
      }
      catch (error) { console.error("File Scanner continuation failed", error); message.retry({ delaySeconds: Math.min(15 * (2 ** Math.min(message.attempts, 8)), 900) }) }
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cycleAndContinue(env).then(() => undefined).catch((error) => {
      console.error("Scheduled File Scanner cycle failed", error)
    }))
  },
}
