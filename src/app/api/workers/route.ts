import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { POST as createWorker } from "@/app/api/agents/route"
import { getAgentGithubToken, listAgents, updateAgent, updateAgentRun } from "@/lib/agents-store"
import { GITHUB_TOKEN_COOKIE, getGitHubWorkflowRun, listGitHubWorkflowRunJobs, listGitHubWorkflowRuns } from "@/lib/github-oauth"
import { listClaimedActiveRepairJobs, getRepairJob, updateRepairJob } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

function isRecentIso(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) return false
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return false
  return Date.now() - time <= maxAgeMs
}

async function mapBounded<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < values.length; index += concurrency) {
    results.push(...await Promise.all(values.slice(index, index + concurrency).map(task)))
  }
  return results
}

function getEffectiveStatus<T extends { provider: string; status: string; lastHeartbeatAt?: string }>(agent: T): string {
  if (agent.provider === "github_actions") {
    if (isRecentIso(agent.lastHeartbeatAt, 90_000)) return "online"
    return agent.status === "online" || agent.status === "busy" ? "online" : "offline"
  }
  if (agent.status === "error") return "offline"
  if ((agent.provider === "self_hosted" || agent.provider === "local") && agent.status === "online") {
    if (!isRecentIso(agent.lastHeartbeatAt, 60_000)) return "offline"
  }
  return agent.status
}

function buildGitHubRunDiagnostics(
  jobs: Array<{
    name?: string
    status?: string
    conclusion?: string | null
    steps: Array<{ name?: string; status?: string; conclusion?: string | null }>
  }>
) {
  const lines: string[] = []
  const failureBits: string[] = []

  for (const job of jobs) {
    if (job.name) {
      lines.push(
        `${job.name}: ${job.status || "unknown"}${job.conclusion ? ` (${job.conclusion})` : ""}`
      )
    }

    for (const step of job.steps) {
      if (!step.name) continue
      if (lines.length < 12) {
        lines.push(
          `- ${step.name}: ${step.status || "unknown"}${step.conclusion ? ` (${step.conclusion})` : ""}`
        )
      }
      if (step.conclusion && step.conclusion !== "success" && step.conclusion !== "skipped" && failureBits.length < 4) {
        failureBits.push(`${job.name || "job"} / ${step.name}: ${step.conclusion}`)
      }
    }
  }

  return {
    githubLogLines: lines,
    failureReason: failureBits[0] ?? null,
  }
}

function getReconciledGithubAgentStatus(runStatus: "running" | "completed" | "failed" | "canceled") {
  if (runStatus === "running") return "online" as const
  return "offline" as const
}

function matchGithubRunToDispatch(
  runs: Awaited<ReturnType<typeof listGitHubWorkflowRuns>>,
  dispatchRequestedAt: unknown,
  excludedRunIds: unknown,
  identityHints: string[] = []
) {
  if (!Array.isArray(runs) || runs.length === 0) return null

  const requestedAt =
    typeof dispatchRequestedAt === "string" && dispatchRequestedAt.trim().length > 0
      ? Date.parse(dispatchRequestedAt)
      : Number.NaN

  if (!Number.isFinite(requestedAt)) return null
  const excluded = new Set(Array.isArray(excludedRunIds) ? excludedRunIds.filter((value): value is string => typeof value === "string") : [])

  const candidates = runs.filter((candidate) => {
      if (excluded.has(candidate.id)) return false
      const createdAt = Date.parse(candidate.createdAt || "")
      if (!Number.isFinite(createdAt)) return false
      return createdAt >= requestedAt - 10_000
    })
  if (candidates.length === 0) return null
  const hints = identityHints.filter((value) => typeof value === "string" && value.length > 0)
  const identified = hints.length > 0
    ? candidates.filter((candidate) => {
        const identity = `${candidate.displayTitle ?? ""} ${candidate.name ?? ""}`
        return hints.some((hint) => identity.includes(hint))
      })
    : []
  if (identified.length === 1) return identified[0]
  // Only accept a timestamp match when it is unambiguous. This prevents two
  // workers sharing one repository from being attached to the same run.
  return candidates.length === 1 ? candidates[0] : null
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const agents = await listAgents()
    const cookieToken = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ?? ""

    for (const agent of agents) {
      if (agent.provider !== "github_actions" || !agent.latestRun || !["github_dispatch", "github_backend_dispatch"].includes(agent.latestRun.runType)) continue
      if (!agent.githubRepoOwner || !agent.githubRepoName || !agent.githubWorkflowFile) continue

      const githubToken = (await getAgentGithubToken(agent.id)) || cookieToken || getGitHubTokenFallback()
      if (!githubToken) continue

      const latestRun = agent.latestRun
      let githubRun: Awaited<ReturnType<typeof getGitHubWorkflowRun>> | null = null

      const linkedRepairJob = latestRun.jobReference ? await getRepairJob(latestRun.jobReference).catch(() => null) : null
      const activeRepairJob =
        linkedRepairJob &&
        (linkedRepairJob.status === "pending" || linkedRepairJob.status === "claimed" || linkedRepairJob.status === "running")
      const hasFreshWorkerHeartbeat = isRecentIso(linkedRepairJob?.lastHeartbeatAt || agent.lastHeartbeatAt, 90_000)

      if (latestRun.externalRunId) {
        githubRun = await getGitHubWorkflowRun({
          token: githubToken,
          owner: agent.githubRepoOwner,
          repo: agent.githubRepoName,
          runId: latestRun.externalRunId,
        }).catch(() => null)
      } else {
        const runs = await listGitHubWorkflowRuns({
          token: githubToken,
          owner: agent.githubRepoOwner,
          repo: agent.githubRepoName,
          workflow: agent.githubWorkflowFile,
          branch: agent.githubRef || "main",
          event: "repository_dispatch",
          perPage: 10,
        }).catch(() => [])
        githubRun = matchGithubRunToDispatch(
          runs,
          (latestRun.payload ?? {}).dispatchRequestedAt,
          (latestRun.payload ?? {}).githubRunIdsBeforeDispatch,
          [agent.id, latestRun.jobReference ?? ""]
        )
      }

      if (!githubRun) {
        if (activeRepairJob) {
          if (hasFreshWorkerHeartbeat) {
            await updateAgent(agent.id, {
              status: "online",
              lastError: null,
              metadata: {
                ...(agent.metadata ?? {}),
                activeRepairJobId: latestRun.jobReference ?? null,
              },
            }).catch(() => undefined)
            continue
          }

          await updateAgentRun(latestRun.id, {
            status: "pending",
            externalRunId: null,
            summary: `GitHub dispatch queued for repair job ${latestRun.jobReference}; waiting for GitHub to start the run`,
            payload: {
              ...(latestRun.payload ?? {}),
              githubStatus: null,
              githubConclusion: null,
            },
          }).catch(() => undefined)

          await updateAgent(agent.id, {
            status: "offline",
            lastError: null,
            metadata: {
              ...(agent.metadata ?? {}),
              activeRepairJobId: null,
              githubRunStatus: null,
              githubRunConclusion: null,
            },
          }).catch(() => undefined)
        }
        continue
      }

      const currentStatus = String(githubRun.status ?? "").toLowerCase()
      const conclusion = String(githubRun.conclusion ?? "").toLowerCase()
      const githubJobs =
        latestRun.externalRunId || githubRun.id
          ? await listGitHubWorkflowRunJobs({
              token: githubToken,
              owner: agent.githubRepoOwner,
              repo: agent.githubRepoName,
              runId: latestRun.externalRunId ?? githubRun.id,
            }).catch(() => [])
          : []
      const diagnostics = buildGitHubRunDiagnostics(githubJobs)
      const abortRequested =
        Boolean((latestRun.payload ?? {}).githubAbortRequestedAt) || linkedRepairJob?.status === "canceled"

      const runStatus =
        hasFreshWorkerHeartbeat && activeRepairJob
          ? "running"
          : abortRequested && currentStatus === "completed"
          ? "canceled"
          :
        currentStatus === "completed"
          ? conclusion === "success"
            ? "completed"
            : conclusion === "cancelled"
              ? "canceled"
              : "failed"
          : "running"

      await updateAgentRun(latestRun.id, {
        status: runStatus,
        externalRunId: githubRun.id,
        summary:
          runStatus === "completed"
            ? "GitHub workflow completed successfully"
            : runStatus === "canceled"
              ? abortRequested
                ? "GitHub workflow was aborted by user"
                : "GitHub workflow was aborted"
              : runStatus === "failed"
                ? `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`
                : "GitHub workflow is running",
        payload: {
          ...(latestRun.payload ?? {}),
          ...(githubRun.htmlUrl ? { htmlUrl: githubRun.htmlUrl } : {}),
          githubStatus: currentStatus || null,
          githubConclusion: conclusion || null,
          githubUpdatedAt: githubRun.updatedAt ?? null,
          ...(githubJobs.length > 0 ? { githubJobs } : {}),
          ...(diagnostics.githubLogLines.length > 0 ? { githubLogLines: diagnostics.githubLogLines } : {}),
          ...(diagnostics.failureReason ? { failureReason: diagnostics.failureReason } : {}),
        },
        ...(runStatus === "completed" || runStatus === "failed" || runStatus === "canceled"
          ? { completedAt: new Date().toISOString() }
          : {}),
      }).catch(() => undefined)

      await updateAgent(agent.id, {
        status: getReconciledGithubAgentStatus(runStatus),
        lastError:
          runStatus === "failed"
            ? diagnostics.failureReason || `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`
            : null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: runStatus === "running" ? latestRun.jobReference ?? null : null,
          githubRunStatus: currentStatus || null,
          githubRunConclusion: conclusion || null,
          githubRunUpdatedAt: githubRun.updatedAt ?? null,
          ...(githubRun.htmlUrl ? { githubRunUrl: githubRun.htmlUrl } : {}),
        },
      }).catch(() => undefined)

      if (!hasFreshWorkerHeartbeat && (runStatus === "failed" || runStatus === "canceled") && latestRun.jobReference) {
        const repairJob = linkedRepairJob ?? (await getRepairJob(latestRun.jobReference).catch(() => null))
        if (repairJob && (repairJob.status === "pending" || repairJob.status === "claimed" || repairJob.status === "running")) {
          await updateRepairJob(repairJob.id, {
            status: runStatus === "canceled" ? "canceled" : "failed",
            summary:
              runStatus === "canceled"
                ? abortRequested
                  ? "GitHub workflow was aborted by user before worker completed the job"
                  : "GitHub workflow was aborted before worker completed the job"
                : diagnostics.failureReason || `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`,
            error:
              runStatus === "failed"
                ? diagnostics.failureReason || `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`
                : "GitHub workflow was aborted",
            result: {
              ...(repairJob.result ?? {}),
              githubRun: {
                id: githubRun.id,
                htmlUrl: githubRun.htmlUrl ?? null,
                status: currentStatus || null,
                conclusion: conclusion || null,
                updatedAt: githubRun.updatedAt ?? null,
                jobs: githubJobs,
                logLines: diagnostics.githubLogLines,
              },
            },
            completedAt: new Date().toISOString(),
          }).catch(() => undefined)
        }
      }
    }

    const activeJobs = await listClaimedActiveRepairJobs(100)
    const activeAgentById = new Map(agents.map((agent) => [agent.id, agent]))

    for (const job of activeJobs) {
      if (!job.claimedByAgentId) continue
      if (!["pending", "claimed", "running"].includes(job.status)) continue

      const agent = activeAgentById.get(job.claimedByAgentId)
      if (!agent) continue

      if (agent.provider === "self_hosted" || agent.provider === "local") {
        const workerOnline = agent.status === "online" && isRecentIso(agent.lastHeartbeatAt, 60_000)
        if (!workerOnline) {
          // Shared migration shards are leased and requeued by the migration
          // orchestrator. Do not turn a briefly disconnected worker into a
          // terminal migration failure from a dashboard refresh.
          if (job.workKey?.includes(":shard:")) continue
          await updateRepairJob(job.id, {
            status: "failed",
            summary: "Self-hosted worker went offline before the job completed",
            error: "Self-hosted worker is offline. Start the worker and run the job again.",
            completedAt: new Date().toISOString(),
          }).catch(() => undefined)

          await updateAgent(agent.id, {
            status: "offline",
            lastError: null,
            metadata: {
              ...(agent.metadata ?? {}),
              activeRepairJobId: null,
            },
          }).catch(() => undefined)
        }
      }
    }

    const freshAgents = await listAgents()
    const referencedJobIds = Array.from(new Set(freshAgents.flatMap((agent) => agent.runs.map((run) => run.jobReference).filter((id): id is string => Boolean(id)))))
    const referencedJobs = await mapBounded(referencedJobIds, 8, (jobId) => getRepairJob(jobId).catch(() => null))
    const activeJobById = new Map(referencedJobs.filter((job) => job !== null).map((job) => [job.id, job]))
    const attachCurrentWork = <T extends { jobReference?: string; payload?: Record<string, unknown> }>(run: T): T => {
      const job = run.jobReference ? activeJobById.get(run.jobReference) : null
      if (!job || job.mode !== "migration") return run
      return {
        ...run,
        payload: {
          ...(run.payload ?? {}),
          currentWork: {
            status: job.status,
            payload: job.payload,
            progress: job.progress,
            summary: job.summary,
            lastHeartbeatAt: job.lastHeartbeatAt,
            updatedAt: job.updatedAt,
          },
        },
      }
    }
    return NextResponse.json({
      agents: freshAgents.map((agent) => ({
        ...agent,
        status: getEffectiveStatus(agent),
        latestRun: agent.latestRun ? attachCurrentWork(agent.latestRun) : null,
        runs: agent.runs.map(attachCurrentWork),
      })),
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load workers") }, { status: 400 })
  }
}

export const POST = createWorker
