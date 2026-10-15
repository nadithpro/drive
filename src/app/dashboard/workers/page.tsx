"use client"

import * as React from "react"
import { Activity, Bot, Clock3, Copy, Eye, EyeOff, Github, HardDrive, Plus, RefreshCw, Search, Server, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useRouter, useSearchParams } from "next/navigation"
import { GitHubWorkerSetup } from "@/components/dashboard/github-worker-setup"
import { GitHubBackendWorkerSetupCard } from "@/components/dashboard/github-backend-worker-setup-card"
import { CloudflareWorkerHosting } from "@/components/dashboard/cloudflare-worker-hosting"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { WorkerPageSkeleton } from "@/components/dashboard/loading-skeletons"
import { cn } from "@/lib/utils"

type AgentProvider = "self_hosted" | "github_actions" | "local"
type AgentStatus = "pending_registration" | "online" | "offline" | "busy" | "dispatch_ready" | "disabled" | "error"
type AgentCapability = "scan" | "verify" | "repair" | "bulk_migrate" | "diagnostics"

type AgentRow = {
  id: string
  name: string
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
  createdAt: string
  updatedAt: string
  latestRun?: {
    id: string
    status: "pending" | "running" | "completed" | "failed" | "canceled"
    runType: string
    summary?: string
    externalRunId?: string
    jobReference?: string
    payload?: Record<string, unknown>
    createdAt: string
  } | null
  runs: Array<{
    id: string
    status: "pending" | "running" | "completed" | "failed" | "canceled"
    runType: string
    summary?: string
    externalRunId?: string
    jobReference?: string
    payload?: Record<string, unknown>
    createdAt: string
  }>
}

type RepairJobRow = {
  id: string
  migrationId: string
  requestedByAgentId?: string
  claimedByAgentId?: string
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
  mode: "verify_only" | "repair_only" | "repair_and_verify" | "migration"
  payload?: Record<string, unknown>
  progress?: Record<string, unknown>
  result?: Record<string, unknown>
  summary?: string
  error?: string
  claimedAt?: string
  startedAt?: string
  completedAt?: string
  lastHeartbeatAt?: string
  createdAt: string
  updatedAt: string
  linkedRun?: {
    id: string
    status: "pending" | "running" | "completed" | "failed" | "canceled"
    runType: string
    summary?: string
    externalRunId?: string
    payload?: Record<string, unknown>
    createdAt: string
    updatedAt: string
  } | null
}

function normalizeAgentRow(input: unknown): AgentRow | null {
  if (typeof input !== "object" || input === null) return null
  const row = input as Record<string, unknown>
  return {
    id: typeof row.id === "string" ? row.id : "",
    name: typeof row.name === "string" ? row.name : "",
    provider:
      row.provider === "github_actions" || row.provider === "self_hosted" || row.provider === "local"
        ? row.provider
        : "self_hosted",
    status:
      row.status === "pending_registration" ||
      row.status === "online" ||
      row.status === "offline" ||
      row.status === "busy" ||
      row.status === "dispatch_ready" ||
      row.status === "disabled" ||
      row.status === "error"
        ? row.status
        : "offline",
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities.filter((value): value is AgentCapability => typeof value === "string") as AgentCapability[]) : [],
    endpointDomain: typeof row.endpointDomain === "string" ? row.endpointDomain : undefined,
    endpointIp: typeof row.endpointIp === "string" ? row.endpointIp : undefined,
    githubRepoOwner: typeof row.githubRepoOwner === "string" ? row.githubRepoOwner : undefined,
    githubRepoName: typeof row.githubRepoName === "string" ? row.githubRepoName : undefined,
    githubWorkflowFile: typeof row.githubWorkflowFile === "string" ? row.githubWorkflowFile : undefined,
    githubRef: typeof row.githubRef === "string" ? row.githubRef : undefined,
    githubRepositoryId: typeof row.githubRepositoryId === "string" ? row.githubRepositoryId : undefined,
    workerCount: Math.max(1, Math.min(5, Math.floor(Number(row.workerCount) || 1))),
    notes: typeof row.notes === "string" ? row.notes : undefined,
    lastHeartbeatAt: typeof row.lastHeartbeatAt === "string" ? row.lastHeartbeatAt : undefined,
    lastSeenIp: typeof row.lastSeenIp === "string" ? row.lastSeenIp : undefined,
    lastSeenHost: typeof row.lastSeenHost === "string" ? row.lastSeenHost : undefined,
    lastSeenVersion: typeof row.lastSeenVersion === "string" ? row.lastSeenVersion : undefined,
    lastError: typeof row.lastError === "string" ? row.lastError : undefined,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    latestRun: typeof row.latestRun === "object" && row.latestRun !== null ? (row.latestRun as AgentRow["latestRun"]) : null,
    runs: Array.isArray(row.runs) ? (row.runs as AgentRow["runs"]) : [],
  }
}

const capabilityOptions: Array<{ value: AgentCapability; label: string }> = [
  { value: "scan", label: "Scan" },
  { value: "verify", label: "Verify" },
  { value: "repair", label: "Repair" },
  { value: "bulk_migrate", label: "Bulk migrate" },
  { value: "diagnostics", label: "Diagnostics" },
]

const defaultCapabilities = capabilityOptions.map((capability) => capability.value)

function formatDate(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getEffectiveStatus(agent: AgentRow): AgentStatus {
  if (agent.provider === "github_actions") {
    if (agent.lastHeartbeatAt) {
      const last = new Date(agent.lastHeartbeatAt).getTime()
      if (Number.isFinite(last) && Date.now() - last <= 90_000) return "online"
    }
    return agent.status === "online" || agent.status === "busy" ? "online" : "offline"
  }
  if (agent.status === "error") return "offline"
  if ((agent.provider === "self_hosted" || agent.provider === "local") && agent.status === "online") {
    if (!agent.lastHeartbeatAt) return "offline"
    const last = new Date(agent.lastHeartbeatAt).getTime()
    if (!Number.isFinite(last)) return "offline"
    if (Date.now() - last > 60_000) return "offline"
  }
  return agent.status
}

function statusBadge(status: AgentStatus) {
  if (status === "online") return <Badge className="bg-green-600">Online</Badge>
  if (status === "busy") return <Badge className="bg-primary text-primary-foreground">Busy</Badge>
  if (status === "dispatch_ready") return <Badge className="bg-cyan-600">Dispatch ready</Badge>
  if (status === "pending_registration") return <Badge variant="secondary">Pending registration</Badge>
  if (status === "offline") return <Badge variant="outline">Offline</Badge>
  if (status === "disabled") return <Badge variant="outline">Disabled</Badge>
  return <Badge variant="destructive">Error</Badge>
}

function providerLabel(provider: AgentProvider): string {
  if (provider === "github_actions") return "GitHub Actions"
  if (provider === "local") return "Local"
  return "Self-hosted"
}

function getWorkerConnectionLabel(worker: Pick<AgentRow, "provider" | "githubRepoOwner" | "githubRepoName" | "lastSeenHost" | "endpointDomain" | "lastSeenIp" | "endpointIp">): string {
  if (worker.provider === "github_actions") {
    return worker.githubRepoOwner && worker.githubRepoName ? `${worker.githubRepoOwner} / ${worker.githubRepoName}` : "-"
  }
  return worker.lastSeenHost || worker.endpointDomain || worker.lastSeenIp || worker.endpointIp || "-"
}

function MigrationWorkerSecretControl() {
  const [secret, setSecret] = React.useState("")
  const [configured, setConfigured] = React.useState(false)
  const [updatedAt, setUpdatedAt] = React.useState("")
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [visible, setVisible] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [secretSyncStatus, setSecretSyncStatus] = React.useState<"ready" | "syncing" | "failed" | "unverified">("unverified")

  const load = React.useCallback(async () => {
    const response = await fetch("/api/settings/migration-workers", { cache: "no-store" })
    const payload = await response.json().catch(() => ({})) as { settings?: { sharedSecret?: string; secretConfigured?: boolean; updatedAt?: string; secretSyncStatus?: "ready" | "syncing" | "failed" | "unverified" }; error?: string }
    if (!response.ok) throw new Error(payload.error || "Unable to load migration Worker secret")
    setConfigured(payload.settings?.secretConfigured === true)
    setSecret(payload.settings?.sharedSecret || "")
    setUpdatedAt(payload.settings?.updatedAt || "")
    setSecretSyncStatus(payload.settings?.secretSyncStatus || "unverified")
    setLoaded(true)
  }, [])

  React.useEffect(() => { void load().catch((error) => { setLoaded(true); setMessage(error instanceof Error ? error.message : String(error)) }) }, [load])

  const save = async () => {
    setBusy(true); setMessage("")
    try {
      const response = await fetch("/api/settings/migration-workers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sharedSecret: secret }) })
      const payload = await response.json().catch(() => ({})) as { error?: string; syncedRepositories?: number }
      if (!response.ok) throw new Error(payload.error || "Unable to save migration Worker secret")
      setSecret(""); setVisible(false); await load(); setMessage(`Secret synced to ${payload.syncedRepositories ?? 0} GitHub ${payload.syncedRepositories === 1 ? "repository" : "repositories"}.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const syncLabel = !loaded ? "Loading..." : !configured ? "Secret required" : secretSyncStatus === "ready" ? "Synced" : secretSyncStatus === "syncing" ? "Syncing GitHub secrets" : secretSyncStatus === "failed" ? "GitHub sync failed" : "GitHub sync required"
  const syncVariant = secretSyncStatus === "failed" || !configured ? "destructive" : secretSyncStatus === "ready" ? "outline" : "secondary"
  return <div className="rounded-xl border bg-card p-4 shadow-sm"><div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"><div><div className="font-medium">Migration Worker access</div><p className="text-xs text-muted-foreground">One shared secret authenticates migration workers; each worker keeps its own identity.</p></div><Badge variant={syncVariant}>{syncLabel}</Badge></div><div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"><div className="relative flex-1"><Input aria-label="Migration Worker shared secret" type={visible ? "text" : "password"} value={secret} disabled={!loaded || busy} onChange={(event) => setSecret(event.target.value)} placeholder={configured ? "Saved securely — enter a replacement" : "At least 24 characters"} className="pr-10" />{configured ? <Button type="button" variant="ghost" size="icon" className="absolute top-1/2 right-1 -translate-y-1/2" aria-label={visible ? "Hide migration Worker secret" : "Show migration Worker secret"} onClick={() => setVisible((current) => !current)} disabled={busy}>{visible ? <EyeOff /> : <Eye />}</Button> : null}</div><Button onClick={() => void save()} disabled={!loaded || busy || !secret.trim()}>{busy ? "Syncing..." : "Save and sync"}</Button></div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>Last saved: {updatedAt ? new Date(updatedAt).toLocaleString() : "Never"}</span>{message ? <span>{message}</span> : null}</div></div>
}

function jobStatusBadge(status: RepairJobRow["status"]) {
  if (status === "completed") return <Badge>Completed</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  if (status === "running") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (status === "claimed") return <Badge className="bg-cyan-600">Claimed</Badge>
  if (status === "pending") return <Badge variant="secondary">Pending</Badge>
  return <Badge variant="outline">Aborted</Badge>
}

function jobStatusLabel(status: RepairJobRow["status"]): string {
  return status === "canceled" ? "Aborted" : status
}

function agentRunStatusLabel(status?: "pending" | "running" | "completed" | "failed" | "canceled"): string {
  if (!status) return "-"
  return status === "canceled" ? "aborted" : status
}

function readLogLines(job: RepairJobRow): string[] {
  const lines: string[] = []
  const pushLine = (value: unknown) => {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (!trimmed || lines.includes(trimmed)) return
    lines.push(trimmed)
  }

  pushLine(job.summary)
  pushLine(job.error)

  const linkedRunPayload = job.linkedRun?.payload ?? {}
  const githubLogLines = Array.isArray(linkedRunPayload.githubLogLines) ? linkedRunPayload.githubLogLines : []
  for (const line of githubLogLines) pushLine(line)
  pushLine(linkedRunPayload.failureReason)

  const resultItems =
    job.result && typeof job.result === "object" && Array.isArray((job.result as { items?: unknown[] }).items)
      ? ((job.result as { items: Array<Record<string, unknown>> }).items)
      : []
  for (const item of resultItems) {
    if (typeof item.summary === "string") pushLine(item.summary)
    if (Array.isArray(item.failureSamples)) {
      for (const sample of item.failureSamples.slice(0, 6)) {
        if (sample && typeof sample === "object") {
          const key = typeof sample.key === "string" ? sample.key : "item"
          const error = typeof sample.error === "string" ? sample.error : ""
          pushLine(error ? `${key}: ${error}` : key)
        }
      }
    }
  }

  return lines.slice(0, 12)
}

export default function WorkersPage() {
  const ACTIVE_REFRESH_MS = 15_000
  const IDLE_REFRESH_MS = 20_000
  const router = useRouter()
  const searchParams = useSearchParams()
  const [agents, setAgents] = React.useState<AgentRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [createdToken, setCreatedToken] = React.useState<string | null>(null)

  const [name, setName] = React.useState("")
  const [provider, setProvider] = React.useState<AgentProvider>("github_actions")
  const [capabilities, setCapabilities] = React.useState<AgentCapability[]>(defaultCapabilities)
  const [githubRepoOwner, setGithubRepoOwner] = React.useState("")
  const [githubRepoName, setGithubRepoName] = React.useState("")
  const [githubWorkflowFile, setGithubWorkflowFile] = React.useState("")
  const [githubRef, setGithubRef] = React.useState("main")
  const [githubRepositoryId, setGithubRepositoryId] = React.useState("")
  const [workerCount, setWorkerCount] = React.useState(1)
  const [repositoryMode, setRepositoryMode] = React.useState("manual")
  const [repositorySetupBusy, setRepositorySetupBusy] = React.useState(false)
  const [repositorySetupReady, setRepositorySetupReady] = React.useState(false)
  const handleRepositorySetupBusy = React.useCallback((busy: boolean) => {
    setRepositorySetupBusy(busy)
    if (busy) setRepositorySetupReady(false)
  }, [])
  const [githubToken, setGithubToken] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [githubConnected, setGithubConnected] = React.useState(false)
  const [githubSessionReady, setGithubSessionReady] = React.useState(false)
  const [githubRepos, setGithubRepos] = React.useState<Array<{ id: string; owner: string; name: string; fullName: string; defaultBranch?: string }>>([])
  const [githubWorkflows, setGithubWorkflows] = React.useState<Array<{ id: string; name: string; path: string }>>([])
  const [githubWorkflowsLoading, setGithubWorkflowsLoading] = React.useState(false)
  const githubReposRequest = React.useRef<AbortController | null>(null)
  const [repairJobs, setRepairJobs] = React.useState<RepairJobRow[]>([])
  const [deletingWorkerId, setDeletingWorkerId] = React.useState<string | null>(null)
  const [deletingJobId, setDeletingJobId] = React.useState<string | null>(null)
  const [abortingJobId, setAbortingJobId] = React.useState<string | null>(null)
  const [confirmDeleteWorker, setConfirmDeleteWorker] = React.useState<AgentRow | null>(null)
  const [selectedWorker, setSelectedWorker] = React.useState<AgentRow | null>(null)
  const [workerDetailsOpen, setWorkerDetailsOpen] = React.useState(false)
  const [workerTokenLoading, setWorkerTokenLoading] = React.useState<string | null>(null)
  const [workerTokenValue, setWorkerTokenValue] = React.useState<string | null>(null)
  const [workerTokenWorkerId, setWorkerTokenWorkerId] = React.useState<string | null>(null)
  const [workerSharedSecretConfigured, setWorkerSharedSecretConfigured] = React.useState(false)
  const [createdWorkerId, setCreatedWorkerId] = React.useState<string | null>(null)
  const refreshInFlightRef = React.useRef(false)
  const shouldLiveRefresh =
    agents.some((agent) => {
      const status = getEffectiveStatus(agent)
      return status === "online"
    }) ||
    repairJobs.some((job) => !["completed", "failed", "canceled"].includes(job.status))

  const loadAgents = React.useCallback(async (notify = false) => {
    try {
      const res = await fetch("/api/workers", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load workers"
        throw new Error(message)
      }
      const rows =
        typeof json === "object" && json !== null && Array.isArray((json as any).agents)
          ? ((json as any).agents as unknown[]).map(normalizeAgentRow).filter((row): row is AgentRow => Boolean(row?.id))
          : []
      setAgents(rows)
    } catch (error) {
      if (notify) {
        toast.error(error instanceof Error ? error.message : "Unable to load workers")
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRepairJobs = React.useCallback(async (notify = false) => {
    try {
      const res = await fetch("/api/repair-jobs", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load migration work items"
        throw new Error(message)
      }
      const jobs = typeof json === "object" && json !== null && Array.isArray((json as any).jobs) ? (json as any).jobs as RepairJobRow[] : []
      // Per-file migration records are internal durable queue state. Only
      // explicit repair/verify work belongs in the user-facing jobs UI.
      setRepairJobs(jobs.filter((job) => job.mode !== "migration"))
    } catch (error) {
      if (notify) {
        toast.error(error instanceof Error ? error.message : "Unable to load migration work items")
      }
    }
  }, [])

  const refreshAll = React.useCallback(async (notify = false) => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      await Promise.all([loadAgents(notify), loadRepairJobs(notify)])
    } finally {
      refreshInFlightRef.current = false
    }
  }, [loadAgents, loadRepairJobs])

  React.useEffect(() => {
    void refreshAll()
    const refreshIntervalMs = shouldLiveRefresh ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void refreshAll()
    }, refreshIntervalMs)

    const onFocus = () => void refreshAll()
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshAll()
    }

    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [ACTIVE_REFRESH_MS, IDLE_REFRESH_MS, refreshAll, shouldLiveRefresh])

  React.useEffect(() => {
    const status = searchParams.get("github")
    if (status === "connected") {
      toast.success("GitHub connected")
      setGithubConnected(true)
      setGithubSessionReady(true)
    } else if (status === "error") {
      toast.error("GitHub connection failed")
    }
  }, [searchParams])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data
      if (!data || typeof data !== "object" || (data as { type?: string }).type !== "github-oauth") return

      if ((data as { status?: string }).status === "connected") {
        setGithubConnected(true)
        setGithubSessionReady(true)
        toast.success("GitHub connected")
      } else {
        toast.error("GitHub connection failed")
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const loadGitHubRepos = React.useCallback(async () => {
    githubReposRequest.current?.abort()
    const controller = new AbortController()
    githubReposRequest.current = controller
    try {
      const res = await fetch("/api/github/repos", { cache: "no-store", signal: controller.signal })
      const json: unknown = await res.json().catch(() => ({}))
      if (controller.signal.aborted) return
      if (!res.ok) {
        if (res.status === 401) {
          setGithubConnected(false)
          setGithubRepos([])
          setGithubRepoOwner("")
          setGithubRepoName("")
          setGithubWorkflowFile("")
          setGithubRepositoryId("")
          setGithubWorkflows([])
          setGithubWorkflowsLoading(false)
          setRepositorySetupReady(false)
          return
        }
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load GitHub repositories"
        throw new Error(message)
      }
      setGithubConnected(true)
      setGithubRepos(typeof json === "object" && json !== null && Array.isArray((json as any).repos) ? (json as any).repos : [])
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "Unable to load GitHub repositories")
    } finally {
      if (githubReposRequest.current === controller) githubReposRequest.current = null
    }
  }, [])

  React.useEffect(() => {
    if (provider !== "github_actions" || !open || !githubSessionReady) return
    void loadGitHubRepos()
  }, [provider, open, loadGitHubRepos, githubSessionReady])

  React.useEffect(() => {
    if (!githubRepoOwner || !githubRepoName || provider !== "github_actions") {
      setGithubWorkflows([])
      setGithubWorkflowsLoading(false)
      return
    }
    const controller = new AbortController()
    setGithubWorkflows([])
    setGithubWorkflowsLoading(true)
    if (repositoryMode === "manual") setGithubWorkflowFile("")
    const ref = githubRef.trim()
    const requestTimer = window.setTimeout(() => void (async () => {
      try {
        const refQuery = ref ? `&ref=${encodeURIComponent(ref)}` : ""
        const res = await fetch(`/api/github/workflows?owner=${encodeURIComponent(githubRepoOwner)}&repo=${encodeURIComponent(githubRepoName)}${refQuery}`, { cache: "no-store", signal: controller.signal })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (res.status === 401) {
            setGithubConnected(false)
            setGithubSessionReady(false)
            setGithubRepos([])
            setGithubRepoOwner("")
            setGithubRepoName("")
            setGithubWorkflowFile("")
            setGithubRepositoryId("")
            setGithubWorkflows([])
            throw new Error("GitHub session expired. Reconnect GitHub and try again.")
          }
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load GitHub workflows"
          throw new Error(message)
        }
        if (controller.signal.aborted) return
        const workflows = typeof json === "object" && json !== null && Array.isArray((json as any).workflows) ? (json as any).workflows : []
        setGithubWorkflows(workflows)
        setGithubWorkflowFile((current) => {
          if (workflows.some((workflow: { path?: unknown }) => workflow.path === current)) return current
          return typeof workflows[0]?.path === "string" ? workflows[0].path : ""
        })
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "Unable to load GitHub workflows")
      } finally {
        if (!controller.signal.aborted) setGithubWorkflowsLoading(false)
      }
    })(), 300)
    return () => {
      window.clearTimeout(requestTimer)
      controller.abort()
    }
  }, [githubRepoOwner, githubRepoName, githubRef, provider, repositoryMode])

  const resetForm = React.useCallback(() => {
    setName("")
    setProvider("github_actions")
    setCapabilities(defaultCapabilities)
    setGithubRepoOwner("")
    setGithubRepoName("")
    setGithubWorkflowFile("")
    setGithubRef("main")
    setGithubRepositoryId("")
    setWorkerCount(1)
    setGithubToken("")
    setRepositoryMode("manual")
    setRepositorySetupBusy(false)
    setRepositorySetupReady(false)
    setNotes("")
    setCreatedToken(null)
    setCreatedWorkerId(null)
    setGithubConnected(false)
    setGithubSessionReady(false)
    setGithubRepos([])
    setGithubWorkflows([])
    setGithubWorkflowsLoading(false)
    githubReposRequest.current?.abort()
    githubReposRequest.current = null
  }, [])

  const copyText = React.useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied`)
    } catch {
      toast.error(`Unable to copy ${label.toLowerCase()}`)
    }
  }, [])

  const loadWorkerToken = React.useCallback(async (worker: AgentRow) => {
    setWorkerTokenLoading(worker.id)
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}/token`, { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load worker token"
        throw new Error(message)
      }
      const token =
        typeof json === "object" && json !== null && typeof (json as any).token === "string"
          ? String((json as any).token)
          : null
      const workerId =
        typeof json === "object" && json !== null && typeof (json as any).workerId === "string"
          ? String((json as any).workerId)
          : worker.id

      setWorkerTokenValue(token)
      setWorkerSharedSecretConfigured(
        typeof json === "object" && json !== null && (json as { sharedSecretConfigured?: unknown }).sharedSecretConfigured === true
      )
      setWorkerTokenWorkerId(workerId)
      setSelectedWorker(worker)
      setWorkerDetailsOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load worker token")
    } finally {
      setWorkerTokenLoading(null)
    }
  }, [])

  const startGitHubConnect = React.useCallback(() => {
    const connectUrl = new URL("/api/github/connect?popup=1", window.location.origin).toString()
    const fallbackUrl = new URL("/api/github/connect", window.location.origin).toString()
    const popup = window.open(
      connectUrl,
      "github-worker-connect",
      "popup=yes,width=720,height=760,resizable=yes,scrollbars=yes"
    )

    if (!popup) {
      window.location.href = fallbackUrl
    }
  }, [])

  const toggleCapability = (value: AgentCapability, checked: boolean) => {
    setCapabilities((current) => {
      if (checked) return Array.from(new Set([...current, value]))
      return current.filter((entry) => entry !== value)
    })
  }

  const submit = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider,
          capabilities,
          endpointDomain: "",
          endpointIp: "",
          githubRepoOwner,
          githubRepoName,
          githubWorkflowFile,
          githubRef,
          githubRepositoryId,
          workerCount,
          githubToken,
          notes,
        }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to create worker"
        throw new Error(message)
      }
      const created = typeof json === "object" && json !== null && "agent" in json ? ((json as any).agent as AgentRow) : null
      const registrationToken =
        typeof json === "object" && json !== null && typeof (json as any).registrationToken === "string"
          ? String((json as any).registrationToken)
          : null

      if (created) setAgents((current) => [created, ...current])
      setCreatedWorkerId(created?.id ?? null)
      setCreatedToken(provider === "github_actions" ? null : registrationToken)
      toast.success("Worker saved")
      if (provider === "github_actions" || !registrationToken) {
        setOpen(false)
        resetForm()
        await loadAgents()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create worker")
    } finally {
      setSaving(false)
    }
  }

  const deleteWorker = React.useCallback(
    async (worker: AgentRow) => {
      setDeletingWorkerId(worker.id)
      try {
        const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to delete worker"
          throw new Error(message)
        }
        toast.success("Worker deleted")
        await loadAgents()
        await loadRepairJobs()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to delete worker")
      } finally {
        setDeletingWorkerId(null)
      }
    },
    [loadAgents, loadRepairJobs]
  )

  const deleteRepairJobRecord = React.useCallback(
    async (job: RepairJobRow) => {
      setDeletingJobId(job.id)
      try {
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to delete migration work item"
          throw new Error(message)
        }
        toast.success("Migration work item deleted")
        await loadRepairJobs()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to delete migration work item")
      } finally {
        setDeletingJobId(null)
      }
    },
    [loadRepairJobs]
  )

  const abortRepairJobRecord = React.useCallback(
    async (job: RepairJobRow) => {
      setAbortingJobId(job.id)
      try {
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "abort" }),
        })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to abort migration work item"
          throw new Error(message)
        }
        toast.success("Migration work item aborted")
        await loadRepairJobs()
        await loadAgents()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to abort migration work item")
      } finally {
        setAbortingJobId(null)
      }
    },
    [loadAgents, loadRepairJobs]
  )


  const totalOnline = agents.filter((agent) => getEffectiveStatus(agent) === "online").length
  const totalGithub = agents.filter((agent) => agent.provider === "github_actions").length
  const totalSelfHosted = agents.filter((agent) => agent.provider === "self_hosted" || agent.provider === "local").length
  // A GitHub agent row represents one registered workflow configuration, not
  // one worker process. Its configured capacity can launch up to workerCount
  // independent workers; self-hosted/local registrations represent one each.
  const totalWorkers = agents.reduce(
    (total, agent) => total + (agent.provider === "github_actions" ? agent.workerCount : 1),
    0
  )
  const activeJobs = repairJobs.filter((job) => !["completed", "failed", "canceled"].includes(job.status)).length
  const visibleWorkers = agents
  const visibleRepairJobs = repairJobs.slice(0, 3)
  const getWorkerLinkedJobs = React.useCallback(
    (worker: AgentRow) =>
      repairJobs.filter((job) => job.claimedByAgentId === worker.id || job.requestedByAgentId === worker.id),
    [repairJobs]
  )

  const updateWorkflowWorkerCount = React.useCallback(async (workflow: AgentRow, count: number) => {
    setAgents((current) => current.map((entry) => entry.id === workflow.id ? { ...entry, workerCount: count } : entry))
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(workflow.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerCount: count }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to update worker count"
        throw new Error(message)
      }
      toast.success(`Workflow will dispatch ${count} worker${count === 1 ? "" : "s"}`)
    } catch (error) {
      setAgents((current) => current.map((entry) => entry.id === workflow.id ? { ...entry, workerCount: workflow.workerCount } : entry))
      toast.error(error instanceof Error ? error.message : "Unable to update worker count")
    }
  }, [])

  if (loading && agents.length === 0 && repairJobs.length === 0) {
    return <WorkerPageSkeleton />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-4 w-4" />
            Worker orchestration
          </div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Workers</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Manage GitHub-triggered and self-hosted workers, monitor heartbeat health, and keep migration jobs visible from one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void refreshAll(true)} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next)
              if (!next) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button className="h-8 px-3 text-sm">
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add workflow
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[88vh] sm:max-h-[94vh] sm:max-w-3xl flex flex-col rounded-2xl p-0 overflow-hidden">
              <DialogHeader className="border-b px-6 py-5">
                <DialogTitle>Add GitHub workflow</DialogTitle>
                <DialogDescription>
                  Connect a GitHub account and register a migration workflow. Self-hosted workers register themselves with the shared secret and orchestrator URL.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="space-y-6 p-6 pb-6">
                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Workflow setup</p>
                    <div className="grid gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="worker-name">Workflow name</Label>
                        <Input id="worker-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="github-migration-main" />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Capabilities</p>
                    <div className="grid gap-2 md:grid-cols-3">
                      {capabilityOptions.map((capability) => (
                        <label key={capability.value} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={capabilities.includes(capability.value)}
                            onCheckedChange={(checked) => toggleCapability(capability.value, checked === true)}
                          />
                          <span>{capability.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

              {provider === "github_actions" ? (
                <div className="rounded-lg border bg-muted/40 p-4 pb-6 grid gap-4 md:grid-cols-2">
                  <div className="md:col-span-2 flex items-center gap-2">
                    <Button
                      type="button"
                      variant={githubConnected ? "outline" : "default"}
                      onClick={startGitHubConnect}
                    >
                      <Github className="mr-1 h-4 w-4" />
                      {githubConnected ? "Reconnect GitHub" : "Connect GitHub"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {githubConnected
                        ? "Connected in a separate window. Repository secrets will be provisioned automatically on save."
                        : "Open a small GitHub window, complete OAuth, and continue this form without interruption."}
                    </span>
                  </div>
                  <div className="md:col-span-2">
                    <ToggleGroup type="single" variant="outline" value={repositoryMode} disabled={repositorySetupBusy} onValueChange={(value) => { if (value) { setRepositoryMode(value); setRepositorySetupReady(false) } }} aria-label="Repository setup mode">
                      <ToggleGroupItem value="manual">Select manually</ToggleGroupItem>
                      <ToggleGroupItem value="auto">Auto detect / fork</ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                  {repositoryMode === "auto" && <GitHubWorkerSetup connected={githubConnected} onBusy={handleRepositorySetupBusy} onSelect={(repo, workflow) => {
                    setGithubRepos((current) => [...current.filter((entry) => entry.id !== repo.id), repo])
                    setGithubRepoOwner(repo.owner)
                    setGithubRepoName(repo.name)
                    setGithubRepositoryId(repo.id)
                    setGithubRef(repo.defaultBranch)
                    setGithubWorkflowFile(workflow)
                    setRepositorySetupReady(true)
                  }} />}
                  <div className="space-y-2">
                    <Label>Repository</Label>
                    <Select
                      disabled={repositorySetupBusy || repositoryMode === "auto"}
                      value={githubRepoOwner && githubRepoName ? `${githubRepoOwner}/${githubRepoName}` : ""}
                      onValueChange={(value) => {
                        const [owner, repo] = value.split("/")
                        const selected = githubRepos.find((entry) => entry.owner === owner && entry.name === repo)
                        setGithubWorkflowFile("")
                        setGithubWorkflows([])
                        setGithubRepoOwner(owner || "")
                        setGithubRepoName(repo || "")
                        setGithubRepositoryId(selected?.id || "")
                        setGithubRef(selected?.defaultBranch || "main")
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={githubConnected ? "Select repository" : "Connect GitHub first"} />
                      </SelectTrigger>
                      <SelectContent>
                        {githubRepos.map((repo) => (
                          <SelectItem key={repo.id} value={`${repo.owner}/${repo.name}`}>
                            {repo.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Workflow</Label>
                    <Select disabled={!githubRepoOwner || !githubRepoName || githubWorkflowsLoading} value={githubWorkflowFile} onValueChange={setGithubWorkflowFile}>
                      <SelectTrigger>
                        <SelectValue placeholder={!githubRepoOwner || !githubRepoName ? "Choose repository first" : githubWorkflowsLoading ? "Loading workflows..." : githubWorkflows.length > 0 ? "Select workflow" : "No workflow files found"} />
                      </SelectTrigger>
                      <SelectContent>
                        {githubWorkflows.map((workflow) => (
                          <SelectItem key={workflow.id} value={workflow.path}>
                            {workflow.name} ({workflow.path})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Workers per dispatch</Label>
                    <Select value={String(workerCount)} onValueChange={(value) => setWorkerCount(Number(value))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5].map((count) => <SelectItem key={count} value={String(count)}>{count} worker{count === 1 ? "" : "s"}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="github-ref">Git ref</Label>
                    <Input disabled={repositoryMode === "auto"} id="github-ref" value={githubRef} onChange={(e) => setGithubRef(e.target.value)} placeholder="main" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="repo-id">Optional repository id</Label>
                    <Input disabled={repositoryMode === "auto"} id="repo-id" value={githubRepositoryId} onChange={(e) => setGithubRepositoryId(e.target.value)} placeholder="123456789" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="github-token">Optional fallback GitHub token</Label>
                    <Input
                      id="github-token"
                      type="password"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      placeholder="ghp_... or fine-grained token"
                    />
                    <p className="text-xs text-muted-foreground">
                      Usually not needed after GitHub OAuth connect. Keep this only as a server-side fallback.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                  {provider === "local"
                    ? "Local workers use the shared worker secret from Settings and send heartbeats from your own machine."
                    : "Self-hosted workers use the shared worker secret from Settings. Existing registration tokens remain accepted for older clients."}
                </div>
              )}

                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Region, routing rules, or operational notes." />
                  </div>

              {createdToken ? (
                <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-100">
                  <div className="font-medium">Worker credentials</div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-green-500/20 bg-black/10 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-green-200">Worker ID</div>
                        {createdWorkerId ? (
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-green-50 hover:bg-green-500/10" onClick={() => void copyText(createdWorkerId, "Worker ID")}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-1 break-all font-mono text-xs">{createdWorkerId || "-"}</div>
                    </div>
                    <div className="rounded-md border border-green-500/20 bg-black/10 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-green-200">Legacy registration token</div>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-green-50 hover:bg-green-500/10" onClick={() => void copyText(createdToken, "Worker token")}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="mt-1 break-all font-mono text-xs">{createdToken}</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-green-200">
                    Use the shared worker secret from Settings for new clients. This legacy token can authenticate older clients and is shown only once. Heartbeats go to <span className="font-mono">/api/workers/&lt;workerId&gt;/heartbeat</span>.
                  </div>
                </div>
              ) : null}
                </div>
              </div>

              <DialogFooter className="border-t px-6 py-4">
                {createdToken ? (
                  <Button
                    onClick={() => {
                      setOpen(false)
                      resetForm()
                    }}
                  >
                    Done
                  </Button>
                ) : (
                  <Button onClick={submit} disabled={saving || repositorySetupBusy || githubWorkflowsLoading || (provider === "github_actions" && (!githubRepoOwner || !githubRepoName || !githubWorkflowFile || (repositoryMode === "auto" && !repositorySetupReady)))}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Dialog
        open={workerDetailsOpen}
        onOpenChange={(next) => {
          setWorkerDetailsOpen(next)
          if (!next) {
            setSelectedWorker(null)
            setWorkerTokenValue(null)
            setWorkerTokenWorkerId(null)
            setWorkerSharedSecretConfigured(false)
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedWorker?.name || "Worker details"}</DialogTitle>
            <DialogDescription>Review the worker id, connection details, and authentication setup.</DialogDescription>
          </DialogHeader>
          {selectedWorker ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Worker ID</div>
                <div className="mt-1 break-all font-mono text-xs">{workerTokenWorkerId || selectedWorker.id}</div>
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => void copyText(workerTokenWorkerId || selectedWorker.id, "Worker ID")}>
                    <Copy className="mr-1 h-4 w-4" />
                    Copy ID
                  </Button>
                </div>
              </div>
                <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Connection</div>
                <div className="mt-1">
                  {getWorkerConnectionLabel(selectedWorker)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {selectedWorker.provider === "github_actions"
                    ? `Workflow: ${selectedWorker.githubWorkflowFile || "-"}`
                    : `Last heartbeat: ${formatDate(selectedWorker.lastHeartbeatAt)}`}
                </div>
              </div>
              <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">
                  {selectedWorker.provider === "github_actions" ? "Shared worker secret" : "Registration token"}
                </div>
                {selectedWorker.provider === "github_actions" ? (
                  <>
                    <div className="mt-1 text-sm">
                      {workerSharedSecretConfigured ? "Configured in Settings" : "Not configured"}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      GitHub workers use the one shared secret from Settings plus this worker&apos;s unique ID. The secret is never displayed here.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mt-1 break-all font-mono text-xs">{workerTokenValue || "No token loaded"}</div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button variant="outline" size="sm" disabled={workerTokenLoading === selectedWorker.id} onClick={() => void loadWorkerToken(selectedWorker)}>
                        <RefreshCw className={cn("mr-1 h-4 w-4", workerTokenLoading === selectedWorker.id && "animate-spin")} />
                        {workerTokenValue ? "Refresh token" : "Get token"}
                      </Button>
                      {workerTokenValue ? (
                        <Button variant="outline" size="sm" onClick={() => void copyText(workerTokenValue, "Worker token")}>
                          <Copy className="mr-1 h-4 w-4" />
                          Copy token
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Workers</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : totalWorkers}</div>
            <p className="text-xs text-muted-foreground">Configured worker capacity</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connected Now</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : totalOnline}</div>
            <p className="text-xs text-muted-foreground">Online and busy workers</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Registered Workflows</CardTitle>
            <Github className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : totalGithub}</div>
            <p className="text-xs text-muted-foreground">{totalSelfHosted} self-hosted worker{totalSelfHosted === 1 ? "" : "s"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Queue</CardTitle>
            <Clock3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : activeJobs}</div>
            <p className="text-xs text-muted-foreground">{repairJobs.length} live/recent work items</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Workers</CardTitle>
            <CardDescription>Manage registered workers, deployment connections, heartbeat health, and active work.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1">
              <Server className="h-3.5 w-3.5" />
              {totalSelfHosted} Self Hosted
            </Badge>
            <Badge variant="outline" className="gap-1">
              <Github className="h-3.5 w-3.5" />
              {totalGithub} GitHub
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-1">
          {!loading && agents.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
              No workers configured yet. Add one to register a self-hosted worker or connect a GitHub worker repository.
            </div>
          ) : null}

          {visibleWorkers.map((worker) => {
            const effectiveStatus = getEffectiveStatus(worker)
            const summary = worker.latestRun?.summary || worker.lastError || worker.notes || "No notes yet"
            const linkedWorkerJobs = getWorkerLinkedJobs(worker)
            const activeLinkedWorkerJobs = linkedWorkerJobs.filter((job) => !["completed", "failed", "canceled"].includes(job.status))
            const activeWorkflowRuns = worker.runs.filter((run) => ["github_dispatch", "github_backend_dispatch"].includes(run.runType) && (run.status === "pending" || run.status === "running"))

            return (
              <div key={worker.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted">
                        {worker.provider === "github_actions" ? <Github className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold">{worker.name}</h3>
                          {statusBadge(effectiveStatus)}
                          <Badge variant="outline">{providerLabel(worker.provider)}</Badge>
                          {worker.provider === "github_actions" ? <Badge variant="secondary">Registered workflow</Badge> : null}
                        </div>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">{worker.id}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {(Array.isArray(worker.capabilities) ? worker.capabilities : []).map((capability) => (
                        <Badge key={capability} variant="secondary" className="font-normal">
                          {capabilityOptions.find((option) => option.value === capability)?.label ?? capability}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    {worker.provider === "github_actions" ? (
                      <Select value={String(worker.workerCount)} onValueChange={(value) => void updateWorkflowWorkerCount(worker, Number(value))}>
                        <SelectTrigger className="h-9 w-[132px]" aria-label="Workers per dispatch"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5].map((count) => <SelectItem key={count} value={String(count)}>{count} worker{count === 1 ? "" : "s"}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={deletingWorkerId === worker.id}
                      onClick={() => setConfirmDeleteWorker(worker)}
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      {deletingWorkerId === worker.id ? "Deleting..." : "Delete"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={workerTokenLoading === worker.id}
                      onClick={() => void loadWorkerToken(worker)}
                    >
                      <Eye className="mr-1 h-4 w-4" />
                      {workerTokenLoading === worker.id ? "Loading..." : "Details"}
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Connection</div>
                    <div className="font-medium">{getWorkerConnectionLabel(worker)}</div>
                    <div className="mt-2 text-xs text-muted-foreground">Heartbeat: {formatDate(worker.lastHeartbeatAt)}</div>
                    <div className="text-xs text-muted-foreground">Host: {worker.lastSeenHost || "-"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Repository</div>
                    <div className="font-medium">
                      {worker.githubRepoOwner && worker.githubRepoName ? `${worker.githubRepoOwner}/${worker.githubRepoName}` : "-"}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">Workflow: {worker.githubWorkflowFile || "-"}</div>
                    <div className="text-xs text-muted-foreground">Ref: {worker.githubRef || "-"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Runtime</div>
                    <div className="font-medium">Version: {worker.lastSeenVersion || "-"}</div>
                    <div className="mt-2 text-xs text-muted-foreground">Last seen IP: {worker.lastSeenIp || worker.endpointIp || "-"}</div>
                    <div className="text-xs text-muted-foreground">Created: {formatDate(worker.createdAt)}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Latest run</div>
                    <div className="font-medium">
                      {worker.latestRun ? `${worker.latestRun.runType} - ${agentRunStatusLabel(worker.latestRun.status)}` : "No runs yet"}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{summary}</div>
                    {worker.provider === "github_actions" ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Linked jobs: {linkedWorkerJobs.length} total, {activeLinkedWorkerJobs.length} active
                      </div>
                    ) : null}
                  </div>
                </div>
                {worker.provider === "github_actions" ? (
                  <div className="mt-3 rounded-lg border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Independent workflow workers</div>
                      <div className="text-xs text-muted-foreground">{activeWorkflowRuns.length} active / {worker.workerCount} configured</div>
                    </div>
                    {activeWorkflowRuns.length === 0 ? (
                      <div className="text-sm text-muted-foreground">No active workflow workers.</div>
                    ) : (
                      <div className="space-y-2">
                        {activeWorkflowRuns.map((run) => {
                          const instanceId = typeof run.payload?.workerInstanceId === "string" ? run.payload.workerInstanceId : run.id
                          const currentWork = typeof run.payload?.currentWork === "object" && run.payload.currentWork !== null
                            ? run.payload.currentWork as Record<string, unknown>
                            : null
                          const currentJob = currentWork
                            ? {
                                status: (["pending", "claimed", "running", "completed", "failed", "canceled"].includes(String(currentWork.status))
                                  ? String(currentWork.status)
                                  : "pending") as RepairJobRow["status"],
                                payload: typeof currentWork.payload === "object" && currentWork.payload !== null ? currentWork.payload as Record<string, unknown> : {},
                                progress: typeof currentWork.progress === "object" && currentWork.progress !== null ? currentWork.progress as Record<string, unknown> : {},
                                lastHeartbeatAt: typeof currentWork.lastHeartbeatAt === "string" ? currentWork.lastHeartbeatAt : undefined,
                              }
                            : undefined
                          const inventoryObjects = Array.isArray(currentJob?.payload?.inventoryObjects) ? currentJob.payload.inventoryObjects : []
                          const currentObject = inventoryObjects[0] && typeof inventoryObjects[0] === "object" ? inventoryObjects[0] as Record<string, unknown> : null
                          const currentFile = typeof currentJob?.progress?.currentFile === "object" && currentJob.progress.currentFile !== null
                            ? currentJob.progress.currentFile as Record<string, unknown>
                            : currentObject
                          const fileKey = typeof currentFile?.key === "string" ? currentFile.key : "Waiting for next file"
                          const bytesTransferred = Number(currentJob?.progress?.bytesTransferred ?? 0)
                          const bytesTotal = Number(currentJob?.progress?.bytesTotal ?? currentObject?.size ?? 0)
                          const percent = bytesTotal > 0 ? Math.min(100, Math.max(0, Math.round((bytesTransferred / bytesTotal) * 100))) : null
                          return (
                            <div key={run.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border bg-background p-3 text-sm">
                              <div className="min-w-0 flex-1">
                                <div className="font-medium">Worker {instanceId.slice(0, 8)}</div>
                                <div className="mt-2 truncate font-mono text-xs" title={fileKey}>{fileKey}</div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {currentJob ? `${jobStatusLabel(currentJob.status)}${percent === null ? "" : ` · ${percent}%`}` : "Idle and ready to claim"}
                                  {currentJob?.lastHeartbeatAt ? ` · heartbeat ${formatDate(currentJob.lastHeartbeatAt)}` : ""}
                                </div>
                                <div className="text-xs text-muted-foreground">GitHub run {run.externalRunId || "indexing"} · {run.status}{run.jobReference ? ` · job ${run.jobReference.slice(0, 8)}` : ""}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <MigrationWorkerSecretControl />
      <GitHubBackendWorkerSetupCard connected={githubConnected} onConnect={startGitHubConnect} onCreated={() => void loadAgents()} />
      <CloudflareWorkerHosting />

      <AlertDialog open={!!confirmDeleteWorker} onOpenChange={(open: boolean) => !open && setConfirmDeleteWorker(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worker?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteWorker
                ? repairJobs.some(
                    (job) =>
                      !["completed", "failed", "canceled"].includes(job.status) &&
                      (job.claimedByAgentId === confirmDeleteWorker.id || job.requestedByAgentId === confirmDeleteWorker.id)
                  )
                  ? "This worker has active jobs. First abort the worker-pool attempt from its migration details; deletion is blocked until the Orchestrator confirms it has stopped."
                  : "This will remove the worker from the system." 
                : "This will remove the worker from the system."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmDeleteWorker(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.preventDefault()
                if (!confirmDeleteWorker) return
                void deleteWorker(confirmDeleteWorker).finally(() => setConfirmDeleteWorker(null))
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  )
}



