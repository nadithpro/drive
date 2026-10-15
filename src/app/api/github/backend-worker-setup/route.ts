import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { GITHUB_TOKEN_COOKIE, GitHubApiError } from "@/lib/github-oauth"
import { advanceWorkerSetup } from "@/lib/github-worker-setup"
import { requireAdmin } from "@/lib/server-auth"
import { recordUserActivity } from "@/lib/activity-audit"

export const maxDuration = 120

export async function POST(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  }
  const token = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value
  if (!token) return NextResponse.json({ error: "Connect GitHub first" }, { status: 401 })
  try {
    const body = await request.json() as { cursor?: unknown; selectedId?: unknown }
    const result = await advanceWorkerSetup(token, typeof body.cursor === "string" ? body.cursor : undefined, typeof body.selectedId === "string" ? body.selectedId : undefined, "backend")
    if (typeof body.cursor !== "string" || typeof body.selectedId === "string") {
      await recordUserActivity(request, auth.user.id, {
        action: typeof body.selectedId === "string" ? "github.backend_worker_setup.repository_selected" : "github.backend_worker_setup.started",
        entityType: "github_backend_worker_setup", entityId: "setup", entityLabel: "GitHub Backend Worker setup",
        summary: typeof body.selectedId === "string" ? "Selected GitHub Backend Worker repository" : "Started GitHub Backend Worker setup",
        after: { status: result.status },
      })
    }
    return NextResponse.json(result, { status: result.status === "pending" ? 202 : 200 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Backend Worker setup failed" }, {
      status: error instanceof GitHubApiError ? error.status >= 500 ? 502 : error.status : 400,
    })
  }
}
