import crypto from "crypto"
import { isWorkerWorkflow } from "./github-worker-workflow"

export const GITHUB_TOKEN_COOKIE = "githubOAuthToken"
export const GITHUB_STATE_COOKIE = "githubOAuthState"
export const GITHUB_FLOW_COOKIE = "githubOAuthFlow"

type GitHubRepo = {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch?: string
  owner?: { login?: string }
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean }
}

type GitHubWorkflow = {
  id: number
  name: string
  path: string
  state?: string
}

type GitHubWorkflowRun = {
  id: number
  html_url?: string
  status?: string
  conclusion?: string | null
  event?: string
  head_branch?: string
  created_at?: string
  updated_at?: string
  display_title?: string
  name?: string
  run_number?: number
}

type GitHubWorkflowRunJob = {
  id: number
  name?: string
  status?: string
  conclusion?: string | null
  started_at?: string | null
  completed_at?: string | null
  steps?: Array<{
    name?: string
    status?: string
    conclusion?: string | null
    number?: number
    started_at?: string | null
    completed_at?: string | null
  }>
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var ${name}`)
  return value
}

export function getGitHubOAuthConfig() {
  return {
    clientId: requireEnv("GITHUB_CLIENT_ID"),
    clientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
    appUrl: (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/+$/, ""),
  }
}

export function buildGitHubOAuthUrl(state: string, appUrlOverride?: string): string {
  const { clientId, appUrl } = getGitHubOAuthConfig()
  const resolvedAppUrl = (appUrlOverride || appUrl || "").replace(/\/+$/, "")
  if (!resolvedAppUrl) throw new Error("Missing NEXT_PUBLIC_APP_URL or APP_URL")
  const url = new URL("https://github.com/login/oauth/authorize")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", `${resolvedAppUrl}/api/github/callback`)
  url.searchParams.set("scope", "repo workflow admin:repo_hook")
  url.searchParams.set("state", state)
  return url.toString()
}

export class GitHubApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function githubApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(15000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch {
    throw new GitHubApiError(`GitHub returned an invalid response (${response.status}); retry setup`, response.status)
  }
  if (!response.ok) {
    const message =
      typeof json?.message === "string" ? json.message : `GitHub API request failed (${response.status})`
    throw new GitHubApiError(message, response.status)
  }
  return json as T
}

export async function exchangeGitHubCode(code: string, appUrlOverride?: string): Promise<string> {
  const { clientId, clientSecret, appUrl } = getGitHubOAuthConfig()
  const resolvedAppUrl = (appUrlOverride || appUrl || "").replace(/\/+$/, "")
  if (!resolvedAppUrl) throw new Error("Missing NEXT_PUBLIC_APP_URL or APP_URL")
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${resolvedAppUrl}/api/github/callback`,
    }),
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(typeof json.error_description === "string" ? json.error_description : "Unable to exchange GitHub OAuth code")
  }
  return json.access_token
}

export async function listGitHubRepos(token: string): Promise<Array<{
  id: string
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch?: string
}>> {
  const repos: GitHubRepo[] = []
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Repository listing exceeded 10,000 entries; narrow GitHub access and retry")
    const response = await githubApi<unknown>(`/user/repos?per_page=100&sort=full_name&direction=asc&affiliation=owner,collaborator,organization_member&page=${page}`, token)
    const batch = Array.isArray(response) ? response as GitHubRepo[] : []
    repos.push(...batch)
    if (batch.length < 100) break
  }
  const uniqueRepos = new Map<string, GitHubRepo>()
  for (const repo of repos) {
    if (!repo || (typeof repo.id !== "number" && typeof repo.id !== "string") || typeof repo.name !== "string" || !repo.name.trim()) continue
    const owner = typeof repo.owner?.login === "string" ? repo.owner.login.trim() : ""
    if (!owner) continue
    const key = String(repo.id)
    if (!uniqueRepos.has(key)) uniqueRepos.set(key, repo)
  }
  return [...uniqueRepos.values()]
    .map((repo) => ({
      id: String(repo.id),
      owner: String(repo.owner?.login ?? ""),
      name: String(repo.name),
      fullName: typeof repo.full_name === "string" && repo.full_name.trim() ? repo.full_name : `${repo.owner?.login}/${repo.name}`,
      private: Boolean(repo.private),
      defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : undefined,
    }))
}

export async function listGitHubWorkflows(token: string, owner: string, repo: string, ref?: string, compatibleOnly = false): Promise<Array<{
  id: string
  name: string
  path: string
  state?: string
}>> {
  const workflowRecords: GitHubWorkflow[] = []
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Workflow listing exceeded 10,000 entries; narrow GitHub access and retry")
    const response = await githubApi<{ workflows?: GitHubWorkflow[] }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?per_page=100&page=${page}`,
      token
    )
    const batch = Array.isArray(response.workflows) ? response.workflows : []
    workflowRecords.push(...batch)
    if (batch.length < 100) break
  }
  const uniqueWorkflows = new Map<string, GitHubWorkflow>()
  for (const workflow of workflowRecords) {
    if (!workflow || (typeof workflow.id !== "number" && typeof workflow.id !== "string") || typeof workflow.name !== "string" || typeof workflow.path !== "string") continue
    if (!uniqueWorkflows.has(workflow.path)) uniqueWorkflows.set(workflow.path, workflow)
  }
  const workflows = [...uniqueWorkflows.values()].map((workflow) => ({
    id: String(workflow.id),
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
  }))

  // GitHub can retain an Actions workflow record after its file was removed.
  // Verify every returned path against the selected ref (or the repository's
  // current default branch when no ref was supplied) before exposing it.
  const actual: typeof workflows = []
  for (let offset = 0; offset < workflows.length; offset += 5) {
    const batch = await Promise.all(
      workflows.slice(offset, offset + 5).map(async (workflow) => {
        if (!workflow.path.startsWith(".github/workflows/") || !/\.ya?ml$/i.test(workflow.path)) return null
        const contentPath = workflow.path.split("/").map(encodeURIComponent).join("/")
        try {
          const file = await githubApi<{ type?: string; path?: string; encoding?: string; content?: string }>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${contentPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
            token
          )
          if (file.type !== "file" || (typeof file.path === "string" && file.path !== workflow.path)) return null
          if (compatibleOnly) {
            if (file.encoding !== "base64" || !file.content) return null
            const content = Buffer.from(file.content, "base64").toString("utf8")
            if (!isWorkerWorkflow(content)) return null
          }
          return workflow
        } catch (error) {
          if (error instanceof GitHubApiError && (error.status === 404 || error.status === 409)) return null
          throw error
        }
      })
    )
    actual.push(...batch.filter((workflow): workflow is (typeof workflows)[number] => Boolean(workflow)))
  }
  return actual
}

export async function setGitHubActionsSecret(input: {
  token: string
  owner: string
  repo: string
  name: string
  value: string
}): Promise<void> {
  try {
    const sodiumModule = await import("libsodium-wrappers")
    const sodium = (sodiumModule as { default?: typeof sodiumModule } & typeof sodiumModule).default ?? sodiumModule
    const keyResponse = await githubApi<{ key: string; key_id: string }>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/secrets/public-key`,
      input.token
    )
    if (typeof keyResponse?.key !== "string" || !keyResponse.key.trim()) {
      throw new Error("GitHub did not return a repository secrets public key")
    }
    if (typeof keyResponse?.key_id !== "string" || !keyResponse.key_id.trim()) {
      throw new Error("GitHub did not return a repository secrets key id")
    }
    if (!("ready" in sodium) || !("from_base64" in sodium) || !("crypto_box_seal" in sodium) || !("to_base64" in sodium)) {
      throw new Error("libsodium-wrappers did not load correctly")
    }

    await sodium.ready
    const variants = (sodium as { base64_variants?: { ORIGINAL?: number | null } }).base64_variants
    if (!variants || typeof variants.ORIGINAL === "undefined") {
      throw new Error("libsodium base64 helpers are unavailable")
    }
    const originalVariant = variants.ORIGINAL ?? undefined

    const publicKey = sodium.from_base64(keyResponse.key, originalVariant)
    if (!publicKey) throw new Error("Unable to decode GitHub repository public key")
    const encryptedBytes = sodium.crypto_box_seal(input.value, publicKey)
    const encryptedValue = sodium.to_base64(encryptedBytes, originalVariant)

    await githubApi(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/secrets/${encodeURIComponent(input.name)}`,
      input.token,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: keyResponse.key_id,
        }),
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to set GitHub Actions secret '${input.name}': ${message}`)
  }
}

export async function listGitHubWorkflowRuns(input: {
  token: string
  owner: string
  repo: string
  workflow: string
  branch?: string
  event?: string
  perPage?: number
}): Promise<Array<{
  id: string
  htmlUrl?: string
  status?: string
  conclusion?: string | null
  event?: string
  headBranch?: string
  createdAt?: string
  updatedAt?: string
  displayTitle?: string
  name?: string
  runNumber?: number
}>> {
  const query = new URLSearchParams()
  query.set("per_page", String(Math.max(1, Math.min(100, input.perPage ?? 20))))
  if (input.branch) query.set("branch", input.branch)
  if (input.event) query.set("event", input.event)

  const response = await githubApi<{ workflow_runs?: GitHubWorkflowRun[] }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/workflows/${encodeURIComponent(input.workflow.split("/").pop()!)}/runs?${query.toString()}`,
    input.token
  )
  return (Array.isArray(response.workflow_runs) ? response.workflow_runs : []).map((run) => ({
    id: String(run.id),
    htmlUrl: typeof run.html_url === "string" ? run.html_url : undefined,
    status: typeof run.status === "string" ? run.status : undefined,
    conclusion: typeof run.conclusion === "string" || run.conclusion === null ? run.conclusion : undefined,
    event: typeof run.event === "string" ? run.event : undefined,
    headBranch: typeof run.head_branch === "string" ? run.head_branch : undefined,
    createdAt: typeof run.created_at === "string" ? run.created_at : undefined,
    updatedAt: typeof run.updated_at === "string" ? run.updated_at : undefined,
    displayTitle: typeof run.display_title === "string" ? run.display_title : undefined,
    name: typeof run.name === "string" ? run.name : undefined,
    runNumber: typeof run.run_number === "number" ? run.run_number : undefined,
  }))
}

export async function getGitHubWorkflowRun(input: {
  token: string
  owner: string
  repo: string
  runId: string
}): Promise<{
  id: string
  htmlUrl?: string
  status?: string
  conclusion?: string | null
  event?: string
  headBranch?: string
  createdAt?: string
  updatedAt?: string
  displayTitle?: string
  name?: string
  runNumber?: number
}> {
  const run = await githubApi<GitHubWorkflowRun>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runId)}`,
    input.token
  )
  return {
    id: String(run.id),
    htmlUrl: typeof run.html_url === "string" ? run.html_url : undefined,
    status: typeof run.status === "string" ? run.status : undefined,
    conclusion: typeof run.conclusion === "string" || run.conclusion === null ? run.conclusion : undefined,
    event: typeof run.event === "string" ? run.event : undefined,
    headBranch: typeof run.head_branch === "string" ? run.head_branch : undefined,
    createdAt: typeof run.created_at === "string" ? run.created_at : undefined,
    updatedAt: typeof run.updated_at === "string" ? run.updated_at : undefined,
    displayTitle: typeof run.display_title === "string" ? run.display_title : undefined,
    name: typeof run.name === "string" ? run.name : undefined,
    runNumber: typeof run.run_number === "number" ? run.run_number : undefined,
  }
}

export async function cancelGitHubWorkflowRun(input: {
  token: string
  owner: string
  repo: string
  runId: string
}): Promise<void> {
  await mutateGitHubWorkflowRun(input, "cancel")
}

export async function forceCancelGitHubWorkflowRun(input: {
  token: string
  owner: string
  repo: string
  runId: string
}): Promise<void> {
  await mutateGitHubWorkflowRun(input, "force-cancel")
}

async function mutateGitHubWorkflowRun(
  input: {
    token: string
    owner: string
    repo: string
    runId: string
  },
  action: "cancel" | "force-cancel"
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runId)}/${action}`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  )

  if (response.status === 202 || response.status === 409) return

  const text = await response.text().catch(() => "")
  let message = `GitHub workflow ${action} failed (${response.status})`
  try {
    const json = text ? (JSON.parse(text) as { message?: unknown }) : {}
    if (typeof json.message === "string" && json.message.trim()) message = json.message.trim()
  } catch {}
  throw new Error(message)
}

export async function listGitHubWorkflowRunJobs(input: {
  token: string
  owner: string
  repo: string
  runId: string
}): Promise<Array<{
  id: string
  name?: string
  status?: string
  conclusion?: string | null
  startedAt?: string | null
  completedAt?: string | null
  steps: Array<{
    name?: string
    status?: string
    conclusion?: string | null
    number?: number
    startedAt?: string | null
    completedAt?: string | null
  }>
}>> {
  const response = await githubApi<{ jobs?: GitHubWorkflowRunJob[] }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runId)}/jobs?per_page=100`,
    input.token
  )

  return (Array.isArray(response.jobs) ? response.jobs : []).map((job) => ({
    id: String(job.id),
    name: typeof job.name === "string" ? job.name : undefined,
    status: typeof job.status === "string" ? job.status : undefined,
    conclusion: typeof job.conclusion === "string" || job.conclusion === null ? job.conclusion : undefined,
    startedAt: typeof job.started_at === "string" || job.started_at === null ? job.started_at : undefined,
    completedAt: typeof job.completed_at === "string" || job.completed_at === null ? job.completed_at : undefined,
    steps: (Array.isArray(job.steps) ? job.steps : []).map((step) => ({
      name: typeof step.name === "string" ? step.name : undefined,
      status: typeof step.status === "string" ? step.status : undefined,
      conclusion: typeof step.conclusion === "string" || step.conclusion === null ? step.conclusion : undefined,
      number: typeof step.number === "number" ? step.number : undefined,
      startedAt: typeof step.started_at === "string" || step.started_at === null ? step.started_at : undefined,
      completedAt: typeof step.completed_at === "string" || step.completed_at === null ? step.completed_at : undefined,
    })),
  }))
}

export function createGitHubOAuthState(): string {
  return crypto.randomBytes(24).toString("hex")
}
