import { NextResponse } from "next/server"
import { authenticateMigrationOrchestrator } from "@/lib/migration-orchestrator-auth"
import { postgresSslDisabled, queryDb } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function postgresUrl() {
  return String(process.env.POSTGRES_URL || "").trim()
}
export async function GET(request: Request) {
  const auth = await authenticateMigrationOrchestrator(request)
  if (!auth.ok) return NextResponse.json({ error: "Invalid orchestration secret" }, { status: 401 })
  const database = postgresUrl()
  if (!database) return NextResponse.json({ error: "Panel PostgreSQL URL is not configured" }, { status: 503 })
  const configuredOrigin = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/+$/, "")
  await queryDb(`
    insert into drive_app_settings(key,value,updated_at) values('orchestration-panel-origin',$1::jsonb,now())
    on conflict(key) do update set value=excluded.value,updated_at=now()
  `, [JSON.stringify({ panelOrigin: configuredOrigin })])
  return NextResponse.json({
    version: 1,
    postgresUrl: database,
    disablePostgresSsl: postgresSslDisabled(database),
    githubWorkerSourceRepo: process.env.GITHUB_WORKER_SOURCE_REPO?.trim() || "iamnadith/Drive",
  }, { headers: { "Cache-Control": "no-store, max-age=0" } })
}
