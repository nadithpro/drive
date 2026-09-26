import { syncWorkerRepository } from "@/lib/github-worker-sync"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createAgent, listAgents, type AgentCapability, type AgentCategory, type AgentProvider } from "@/lib/agents-store"
import { GITHUB_TOKEN_COOKIE } from "@/lib/github-oauth"
import { syncGitHubWorkerSecrets } from "@/lib/github-worker-secrets"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { getMigrationWorkerSettings } from "@/lib/migration-worker-settings-store"
import { requireAdmin } from "@/lib/server-auth"
import { recordUserActivity } from "@/lib/activity-audit"

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function parseCapabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry ?? ""))
    .filter((entry): entry is AgentCapability =>
      ["scan", "verify", "repair", "bulk_migrate", "diagnostics"].includes(entry)
    )
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const agents = await listAgents()
    return NextResponse.json({ agents })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load workers") }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const name = asString(body.name).trim()
    const category = (["worker", "agent"].includes(asString(body.category)) ? asString(body.category) : "worker") as AgentCategory
    const provider = (
      ["self_hosted", "github_actions", "local"].includes(asString(body.provider))
        ? asString(body.provider)
        : "self_hosted"
    ) as AgentProvider
    const capabilities = parseCapabilities(body.capabilities)

    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 })

    if (provider === "github_actions") {
      if (!asString(body.githubRepoOwner).trim() || !asString(body.githubRepoName).trim() || !asString(body.githubWorkflowFile).trim()) {
        return NextResponse.json(
          { error: "GitHub repo owner, repo name, and workflow file are required for GitHub Actions agents" },
          { status: 400 }
        )
      }
    }

    const cookieStore = await cookies()
    const githubTokenFromCookie = cookieStore.get(GITHUB_TOKEN_COOKIE)?.value ?? ""
    const githubTokenToUse = asString(body.githubToken).trim() || githubTokenFromCookie || undefined

    let githubRef = asString(body.githubRef).trim() || undefined

    // A registered workflow is eligible for immediate orchestrator dispatch,
    // including while a migration is already running. Provision its runtime
    // contract before saving the row so the orchestrator can never discover
    // and dispatch a half-configured repository.
    if (provider === "github_actions") {
      if (!githubTokenToUse) throw new Error("Reconnect GitHub before adding this workflow")
      const [orchestrator, workerSettings] = await Promise.all([
        getMigrationOrchestratorSettings(),
        getMigrationWorkerSettings(),
      ])
      if (!orchestrator.orchestratorUrl) throw new Error("Migration Orchestrator URL is not configured")
      if (workerSettings.sharedSecret.length < 24 || workerSettings.sharedSecret.length > 512) {
        throw new Error("Configure the Migration Worker shared secret before adding a GitHub workflow")
      }
      const codeSync = await syncWorkerRepository({
        token: githubTokenToUse,
        owner: asString(body.githubRepoOwner).trim(),
        repo: asString(body.githubRepoName).trim(),
        workflow: asString(body.githubWorkflowFile).trim(),
        sourceRepo: process.env.GITHUB_WORKER_SOURCE_REPO,
        activateActions: true,
      })
      githubRef = codeSync.defaultBranch
      await syncGitHubWorkerSecrets({
        token: githubTokenToUse,
        owner: asString(body.githubRepoOwner).trim(),
        repo: asString(body.githubRepoName).trim(),
        serverUrl: orchestrator.orchestratorUrl,
        sharedSecret: workerSettings.sharedSecret,
      })
    }

    const result = await createAgent({
      name,
      category,
      provider,
      capabilities,
      endpointDomain: asString(body.endpointDomain).trim() || undefined,
      endpointIp: asString(body.endpointIp).trim() || undefined,
      githubRepoOwner: asString(body.githubRepoOwner).trim() || undefined,
      githubRepoName: asString(body.githubRepoName).trim() || undefined,
      githubWorkflowFile: asString(body.githubWorkflowFile).trim() || undefined,
      githubRef,
      githubRepositoryId: asString(body.githubRepositoryId).trim() || undefined,
      githubToken: githubTokenToUse,
      workerCount: provider === "github_actions" ? Number(body.workerCount) : 1,
      notes: asString(body.notes).trim() || undefined,
    })

    await recordUserActivity(request, auth.user.id, {
      action: "worker.created",
      entityType: "worker",
      entityId: result.agent?.id,
      entityLabel: name,
      summary: `Created ${category === "worker" ? "worker" : "agent"} ${name}`,
      after: { category, provider, capabilities },
    })

    return NextResponse.json(result, { status: 201 })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to create agent/worker") }, { status: 400 })
  }
}
