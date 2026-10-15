const MIGRATION_WORKER_DIRECTORY = "workers/migration-worker"
const BACKEND_WORKER_DIRECTORY = "workers/backend-worker"

export type GitHubWorkerKind = "migration" | "backend"

export function isWorkerWorkflow(content: string, kind: GitHubWorkerKind = "migration"): boolean {
  const hasCurrentBootstrapSecrets =
    content.includes("DRIVE_MIGRATION_ORCHESTRATOR_URL") &&
    content.includes("DRIVE_WORKER_SHARED_SECRET")

  return /^\s*repository_dispatch\s*:/m.test(content) &&
    content.includes(kind === "backend" ? "drive-backend-worker" : "drive-migration-worker") &&
    content.includes("github.event.client_payload") &&
    hasCurrentBootstrapSecrets &&
    content.includes(kind === "backend" ? BACKEND_WORKER_DIRECTORY : MIGRATION_WORKER_DIRECTORY)
}
