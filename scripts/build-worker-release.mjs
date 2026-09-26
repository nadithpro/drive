import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const version = String(process.env.WORKER_RELEASE_VERSION || process.argv[2] || "").trim()
const baseUrl = String(process.env.WORKER_RELEASE_BASE_URL || process.argv[3] || "").trim().replace(/\/+$/, "")
const buildTimeoutMs = Math.max(10_000, Number(process.env.WORKER_BUILD_TIMEOUT_MS || 60_000))
if (!version || !/^https:\/\//i.test(baseUrl)) throw new Error("Usage: build-worker-release.mjs <version> <https-release-base-url>")

const root = resolve(import.meta.dirname, "..")
const output = resolve(root, "worker-release")
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

const definitions = [
  { key: "backend", directory: "backend-orchestrator", file: "backend-orchestrator.mjs", flags: ["nodejs_compat_v2", "enable_ctx_exports"] },
  { key: "scanner", directory: "file-scanner", file: "file-scanner.mjs", flags: ["nodejs_compat_v2"] },
  { key: "migration", directory: "migration-orchestrator", file: "migration-orchestrator.mjs", flags: ["nodejs_compat_v2", "enable_ctx_exports", "global_fetch_strictly_public"] },
]

const manifest = { version, createdAt: new Date().toISOString(), workers: {} }
for (const definition of definitions) {
  const directory = resolve(root, "workers", definition.directory)
  const temporary = resolve(output, `.build-${definition.key}`)
  const wrangler = resolve(directory, "node_modules", "wrangler", "bin", "wrangler.js")
  const result = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", temporary], { cwd: directory, stdio: "inherit", shell: false, timeout: buildTimeoutMs })
  // Some Windows Wrangler versions retain a telemetry handle after writing a
  // complete dry-run bundle. A timed-out process is safe to accept only when
  // its expected entry module is already present; CI normally exits directly.
  const completedBundleAfterTimeout = result.error?.code === "ETIMEDOUT" && existsSync(resolve(temporary, "index.js"))
  if (result.error && !completedBundleAfterTimeout) throw result.error
  if (result.status !== 0 && !completedBundleAfterTimeout) process.exit(result.status ?? 1)
  const source = resolve(temporary, "index.js")
  const destination = resolve(output, definition.file)
  cpSync(source, destination)
  const bytes = readFileSync(destination)
  manifest.workers[definition.key] = {
    url: `${baseUrl}/${definition.file}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    compatibilityDate: "2026-08-04",
    compatibilityFlags: definition.flags,
  }
  rmSync(temporary, { recursive: true, force: true })
}
writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
