import crypto from "crypto"
import { queryDb } from "./db"
import { getMigrationWorkerSharedSecret } from "./migration-worker-settings-store"

export type AgentCategory = "worker" | "agent"
export type AgentProvider = "self_hosted" | "github_actions" | "local"
export type AgentStatus =
  | "pending_registration"
  | "online"
  | "offline"
  | "busy"
  | "dispatch_ready"
  | "disabled"
  | "error"

export type AgentCapability = "scan" | "verify" | "repair" | "bulk_migrate" | "diagnostics"

export type DriveAgent = {
  id: string
  name: string
  category: AgentCategory
  provider: AgentProvider
  status: AgentStatus
  capabilities: AgentCapability[]
  endpointDomain?: string
  endpointIp?: string
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
  githubRef?: string
  githubRepositoryId?: string
  workerCount: number
  notes?: string
  lastHeartbeatAt?: string
  lastSeenIp?: string
  lastSeenHost?: string
  lastSeenVersion?: string
  lastError?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type DriveAgentRun = {
  id: string
  agentId: string
  runType: string
  status: "pending" | "running" | "completed" | "failed" | "canceled"
  externalRunId?: string
  jobReference?: string
  summary?: string
  payload?: Record<string, unknown>
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

type DriveAgentRow = {
  id: string
  name: string
  category: string
  provider: string
  status: string
  capabilities: unknown
  endpoint_domain: string | null
  endpoint_ip: string | null
  github_repo_owner: string | null
  github_repo_name: string | null
  github_workflow_file: string | null
  github_ref: string | null
  github_repository_id: string | null
  github_token: string | null
  worker_count: number | null
  notes: string | null
  registration_token: string | null
  registration_token_hash: string | null
  last_heartbeat_at: string | null
  last_seen_ip: string | null
  last_seen_host: string | null
  last_seen_version: string | null
  last_error: string | null
  metadata: unknown
  created_at: string
  updated_at: string
}

export type DriveAgentRunRow = {
  id: string
  agent_id: string
  run_type: string
  status: string
  external_run_id: string | null
  job_reference: string | null
  summary: string | null
  payload: unknown
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

const AGENTS_TABLE = "drive_agents"
const AGENT_RUNS_TABLE = "drive_agent_runs"
const MAX_AGENT_TOKEN_LENGTH = 512

function sanitizeCapabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry ?? ""))
    .filter((entry): entry is AgentCapability =>
      ["scan", "verify", "repair", "bulk_migrate", "diagnostics"].includes(entry)
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeEndpointDomain(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    if (trimmed.includes("://")) {
      return new URL(trimmed).hostname || null
    }
  } catch {
    // Fall back to the raw host-ish value below.
  }
  return trimmed
}

function mapAgentRow(row: DriveAgentRow): DriveAgent {
  return {
    id: row.id,
    name: row.name,
    category: (row.category === "agent" ? "agent" : "worker") as AgentCategory,
    provider: (["self_hosted", "github_actions", "local"].includes(row.provider) ? row.provider : "self_hosted") as AgentProvider,
    status: (
      ["pending_registration", "online", "offline", "busy", "dispatch_ready", "disabled", "error"].includes(row.status)
        ? row.status
        : "pending_registration"
    ) as AgentStatus,
    capabilities: sanitizeCapabilities(row.capabilities),
    endpointDomain: row.endpoint_domain ?? undefined,
    endpointIp: row.endpoint_ip ?? undefined,
    githubRepoOwner: row.github_repo_owner ?? undefined,
    githubRepoName: row.github_repo_name ?? undefined,
    githubWorkflowFile: row.github_workflow_file ?? undefined,
    githubRef: row.github_ref ?? undefined,
    githubRepositoryId: row.github_repository_id ?? undefined,
    workerCount: Math.max(1, Math.min(5, Math.floor(Number(row.worker_count) || 1))),
    notes: row.notes ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    lastSeenIp: row.last_seen_ip ?? undefined,
    lastSeenHost: row.last_seen_host ?? undefined,
    lastSeenVersion: row.last_seen_version ?? undefined,
    lastError: row.last_error ?? undefined,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapAgentRunRow(row: DriveAgentRunRow): DriveAgentRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    runType: row.run_type,
    status: (
      ["pending", "running", "completed", "failed", "canceled"].includes(row.status) ? row.status : "pending"
    ) as DriveAgentRun["status"],
    externalRunId: row.external_run_id ?? undefined,
    jobReference: row.job_reference ?? undefined,
    summary: row.summary ?? undefined,
    payload: isRecord(row.payload) ? row.payload : {},
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hashRegistrationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

function buildRegistrationToken(): string {
  return `drvagt_${crypto.randomBytes(24).toString("hex")}`
}

function deriveInitialStatus(input: {
  provider: AgentProvider
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
}): AgentStatus {
  if (input.provider === "github_actions") {
    return input.githubRepoOwner && input.githubRepoName && input.githubWorkflowFile
      ? "dispatch_ready"
      : "error"
  }
  return "pending_registration"
}

export async function listAgents(): Promise<Array<DriveAgent & { latestRun: DriveAgentRun | null; runs: DriveAgentRun[] }>> {
  const { rows } = await queryDb<DriveAgentRow & { recent_runs: DriveAgentRunRow[] }>(
    `select a.*,
       coalesce(r.runs, '[]'::jsonb) as recent_runs
     from public.${AGENTS_TABLE} a
     left join lateral (
       select jsonb_agg(to_jsonb(recent) order by recent.created_at desc, recent.id desc) as runs
       from (
         select * from public.${AGENT_RUNS_TABLE} where agent_id = a.id
         order by created_at desc, id desc limit 20
       ) recent
     ) r on true
     order by a.created_at desc, a.id desc`
  )
  return rows.map((row) => {
    const runs = Array.isArray(row.recent_runs) ? row.recent_runs.map(mapAgentRunRow) : []
    return { ...mapAgentRow(row), latestRun: runs[0] ?? null, runs }
  })
}

export async function createAgent(input: {
  name: string
  category: AgentCategory
  provider: AgentProvider
  capabilities: AgentCapability[]
  endpointDomain?: string
  endpointIp?: string
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
  githubRef?: string
  githubRepositoryId?: string
  githubToken?: string
  workerCount?: number
  notes?: string
}): Promise<{ agent: DriveAgent; registrationToken?: string }> {
  const name = input.name.trim()
  if (!name) throw new Error("Agent/worker name is required")

  const registrationToken = buildRegistrationToken()

  const row = {
    id: crypto.randomUUID(),
    name,
    category: input.category,
    provider: input.provider,
    status: deriveInitialStatus(input),
    capabilities: Array.from(new Set(input.capabilities)),
    endpoint_domain: input.endpointDomain?.trim() || null,
    endpoint_ip: input.endpointIp?.trim() || null,
    github_repo_owner: input.githubRepoOwner?.trim() || null,
    github_repo_name: input.githubRepoName?.trim() || null,
    github_workflow_file: input.githubWorkflowFile?.trim() || null,
    github_ref: input.githubRef?.trim() || null,
    github_repository_id: input.githubRepositoryId?.trim() || null,
    github_token: input.githubToken?.trim() || null,
    worker_count: input.provider === "github_actions" ? Math.max(1, Math.min(5, Math.floor(input.workerCount ?? 1))) : 1,
    notes: input.notes?.trim() || null,
    registration_token: registrationToken ?? null,
    registration_token_hash: registrationToken ? hashRegistrationToken(registrationToken) : null,
    metadata: {},
  }

  const { rows } = await queryDb<DriveAgentRow>(
    `insert into public.${AGENTS_TABLE} (
       id, name, category, provider, status, capabilities, endpoint_domain,
       endpoint_ip, github_repo_owner, github_repo_name, github_workflow_file,
       github_ref, github_repository_id, github_token, worker_count, notes,
       registration_token, registration_token_hash, metadata
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     ) returning *`,
    [row.id, row.name, row.category, row.provider, row.status, JSON.stringify(row.capabilities),
      row.endpoint_domain, row.endpoint_ip, row.github_repo_owner, row.github_repo_name,
      row.github_workflow_file, row.github_ref, row.github_repository_id, row.github_token,
      row.worker_count, row.notes, row.registration_token, row.registration_token_hash, JSON.stringify(row.metadata)]
  )
  return { agent: mapAgentRow(rows[0]), registrationToken }
}

export async function getAgentById(id: string): Promise<DriveAgent | null> {
  const { rows } = await queryDb<DriveAgentRow>(`select * from public.${AGENTS_TABLE} where id = $1 limit 1`, [id])
  const row = rows[0]
  return row ? mapAgentRow(row) : null
}

export async function getAgentGithubToken(agentId: string): Promise<string | null> {
  const { rows } = await queryDb<{ github_token: string | null }>(`select github_token from public.${AGENTS_TABLE} where id = $1 limit 1`, [agentId])
  const row = rows[0]
  return typeof row?.github_token === "string" && row.github_token.trim() ? row.github_token.trim() : null
}

export async function getAgentRegistrationToken(agentId: string): Promise<string | null> {
  const { rows } = await queryDb<{ registration_token: string | null }>(`select registration_token from public.${AGENTS_TABLE} where id = $1 limit 1`, [agentId])
  const row = rows[0]
  return typeof row?.registration_token === "string" && row.registration_token.trim() ? row.registration_token.trim() : null
}

export async function ensureAgentRegistrationToken(agentId: string): Promise<string> {
  const existingToken = await getAgentRegistrationToken(agentId)
  if (existingToken) return existingToken

  const registrationToken = buildRegistrationToken()
  const { rows } = await queryDb<{ registration_token: string }>(
    `update public.${AGENTS_TABLE}
     set registration_token = $2, registration_token_hash = $3, updated_at = now()
     where id = $1 and (registration_token is null or registration_token = '')
     returning registration_token`,
    [agentId, registrationToken, hashRegistrationToken(registrationToken)]
  )
  if (rows[0]?.registration_token) return rows[0].registration_token
  const existing = await getAgentRegistrationToken(agentId)
  if (!existing) throw new Error("Agent/worker not found")
  return existing
}

export async function createAgentRun(input: {
  agentId: string
  runType: string
  status?: DriveAgentRun["status"]
  externalRunId?: string
  jobReference?: string
  summary?: string
  payload?: Record<string, unknown>
}): Promise<DriveAgentRun> {
  const now = new Date().toISOString()
  const { rows } = await queryDb<DriveAgentRunRow>(
    `insert into public.${AGENT_RUNS_TABLE} (
       id, agent_id, run_type, status, external_run_id, job_reference,
       summary, payload, started_at, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) returning *`,
    [crypto.randomUUID(), input.agentId, input.runType, input.status ?? "pending",
      input.externalRunId ?? null, input.jobReference ?? null, input.summary ?? null,
      JSON.stringify(input.payload ?? {}), input.status === "running" ? now : null, now, now]
  )
  return mapAgentRunRow(rows[0])
}

export async function updateAgentRun(
  id: string,
  updates: Partial<{
    status: DriveAgentRun["status"]
    externalRunId: string | null
    jobReference: string | null
    summary: string | null
    payload: Record<string, unknown>
    completedAt: string | null
  }>
): Promise<DriveAgentRun> {
  const columns: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.status !== undefined) columns.status = updates.status
  if (updates.externalRunId !== undefined) columns.external_run_id = updates.externalRunId ?? null
  if (updates.jobReference !== undefined) columns.job_reference = updates.jobReference ?? null
  if (updates.summary !== undefined) columns.summary = updates.summary ?? null
  if (updates.payload !== undefined) columns.payload = JSON.stringify(updates.payload)
  if (updates.completedAt !== undefined) columns.completed_at = updates.completedAt ?? null
  const values: unknown[] = [id]
  const assignments = Object.entries(columns).map(([column, value], index) => {
    values.push(value)
    return `${column} = $${index + 2}${column === "payload" ? "::jsonb" : ""}`
  })
  const { rows } = await queryDb<DriveAgentRunRow>(
    `update public.${AGENT_RUNS_TABLE} set ${assignments.join(", ")} where id = $1 returning *`,
    values
  )
  if (!rows[0]) throw new Error("Agent run not found")
  return mapAgentRunRow(rows[0])
}

export async function getLatestAgentRunByJobReference(jobReference: string): Promise<DriveAgentRun | null> {
  const { rows } = await queryDb<DriveAgentRunRow>(
    `select * from public.${AGENT_RUNS_TABLE} where job_reference = $1 order by created_at desc, id desc limit 1`,
    [jobReference]
  )
  const row = rows[0]
  return row ? mapAgentRunRow(row) : null
}

export async function listAgentRunsByAgentId(agentId: string, limit = 20): Promise<DriveAgentRun[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const { rows } = await queryDb<DriveAgentRunRow>(
    `select * from public.${AGENT_RUNS_TABLE} where agent_id = $1 order by created_at desc, id desc limit $2`,
    [agentId, boundedLimit]
  )
  return rows.map(mapAgentRunRow)
}

export async function updateAgent(
  id: string,
  updates: Partial<{
    status: AgentStatus
    lastError: string | null
    metadata: Record<string, unknown>
    lastHeartbeatAt: string | null
    workerCount: number
    githubRef: string
  }>
): Promise<DriveAgent> {
  const columns: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.status !== undefined) columns.status = updates.status
  if (updates.lastError !== undefined) columns.last_error = updates.lastError ?? null
  if (updates.metadata !== undefined) columns.metadata = JSON.stringify(updates.metadata)
  if (updates.lastHeartbeatAt !== undefined) columns.last_heartbeat_at = updates.lastHeartbeatAt ?? null
  if (updates.workerCount !== undefined) columns.worker_count = Math.max(1, Math.min(5, Math.floor(updates.workerCount)))
  if (updates.githubRef !== undefined) columns.github_ref = updates.githubRef
  const values: unknown[] = [id]
  const assignments = Object.entries(columns).map(([column, value], index) => {
    values.push(value)
    return `${column} = $${index + 2}${column === "metadata" ? "::jsonb" : ""}`
  })
  const { rows } = await queryDb<DriveAgentRow>(
    `update public.${AGENTS_TABLE} set ${assignments.join(", ")} where id = $1 returning *`,
    values
  )
  if (!rows[0]) throw new Error("Agent/worker not found")
  return mapAgentRow(rows[0])
}

export async function authenticateAgent(input: { agentId: string; token: string }): Promise<DriveAgent> {
  const { rows } = await queryDb<DriveAgentRow>(`select * from public.${AGENTS_TABLE} where id = $1 limit 1`, [input.agentId])
  const row = rows[0]
  if (!row) throw new Error("Agent/worker not found")
  if (String(row.status ?? "").trim().toLowerCase() === "disabled") {
    throw new Error("Worker is disabled")
  }
  const token = input.token.trim()
  if (!token || token.length > MAX_AGENT_TOKEN_LENGTH) throw new Error("Invalid worker secret")
  const registrationHash = row.registration_token_hash ?? ""
  const configuredSharedSecret = await getMigrationWorkerSharedSecret().catch(() => "")
  // Do not let a malformed legacy setting become a valid authentication
  // credential. The panel only provisions secrets in this bounded range.
  const sharedSecret =
    configuredSharedSecret.length >= 24 && configuredSharedSecret.length <= MAX_AGENT_TOKEN_LENGTH
      ? configuredSharedSecret
      : ""
  const sharedHash = sharedSecret ? hashRegistrationToken(sharedSecret) : ""
  const tokenHash = hashRegistrationToken(token)
  const matches = [registrationHash, sharedHash].some((expected) => {
    if (!expected || expected.length !== tokenHash.length) return false
    return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(expected))
  })
  if (!matches) throw new Error("Invalid worker secret")
  return mapAgentRow(row)
}

export async function deleteAgent(id: string): Promise<void> {
  await queryDb(`delete from public.${AGENTS_TABLE} where id = $1`, [id])
}

export async function recordAgentHeartbeat(input: {
  agentId: string
  token: string
  remoteIp?: string | null
  host?: string | null
  version?: string | null
  capabilities?: AgentCapability[]
  metadata?: Record<string, unknown>
}): Promise<DriveAgent> {
  const authenticated = await authenticateAgent({ agentId: input.agentId, token: input.token })

  const now = new Date().toISOString()
  const nextCapabilities =
    input.capabilities && input.capabilities.length > 0 ? Array.from(new Set(input.capabilities)) : authenticated.capabilities
  const nextStatus: AgentStatus = authenticated.status === "disabled" ? "disabled" : "online"
  const metadata = { ...(authenticated.metadata ?? {}), ...(input.metadata ?? {}) }
  const { rows } = await queryDb<DriveAgentRow>(
    `update public.${AGENTS_TABLE} set
       status = $2, last_heartbeat_at = $3,
       endpoint_ip = coalesce($4, endpoint_ip),
       endpoint_domain = coalesce($5, endpoint_domain),
       last_seen_ip = coalesce($4, last_seen_ip),
       last_seen_host = coalesce($6, last_seen_host),
       last_seen_version = coalesce($7, last_seen_version),
       capabilities = $8::jsonb, metadata = $9::jsonb,
       updated_at = now(), last_error = null
     where id = $1 and status <> 'disabled'
     returning *`,
    [input.agentId, nextStatus, now, input.remoteIp ?? null,
      normalizeEndpointDomain(input.host) ?? null, input.host ?? null,
      input.version ?? null, JSON.stringify(nextCapabilities), JSON.stringify(metadata)]
  )
  if (!rows[0]) throw new Error("Worker was disabled while registering its heartbeat")
  return mapAgentRow(rows[0])
}

export async function recordMigrationWorkerInstanceHeartbeat(agentId: string, workerInstanceId: string, heartbeatAt: string): Promise<void> {
  await queryDb(
    `update public.${AGENT_RUNS_TABLE}
     set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{workerHeartbeatAt}', to_jsonb($3::text), true),
         updated_at = now()
     where agent_id = $1
       and run_type = 'github_dispatch'
       and status = 'running'
       and payload->>'workerInstanceId' = $2`,
    [agentId, workerInstanceId, heartbeatAt]
  )
}
