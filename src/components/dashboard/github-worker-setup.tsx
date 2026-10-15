"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WorkerRepository } from "@/lib/github-worker-setup"

type WorkerSetupResponse = {
  status?: string
  cursor?: unknown
  message?: unknown
  error?: unknown
  repo?: WorkerRepository
  workflow?: unknown
  candidates?: WorkerRepository[]
}

export function GitHubWorkerSetup({ connected, onSelect, onBusy, workerKind = "migration", startLabel }: {
  connected: boolean
  workerKind?: "migration" | "backend"
  startLabel?: string
  onSelect: (repo: WorkerRepository, workflow: string) => void | Promise<void>
  onBusy: (busy: boolean) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [candidates, setCandidates] = React.useState<WorkerRepository[]>([])
  const controller = React.useRef<AbortController | null>(null)
  const cursor = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    return () => { controller.current?.abort(); onBusy(false) }
  }, [onBusy])

  async function run(selectedId?: string) {
    if (controller.current) return
    // Every button click starts a complete discovery pass. Existing forks are
    // reconciled by the server, so retries recover without stale saved sessions
    // or creating duplicate repositories. A repository choice continues its scan.
    if (!selectedId) cursor.current = undefined
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    onBusy(true)
    setCandidates([])
    setMessage("Looking for the worker repository...")
    try {
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        const setupPath = workerKind === "backend" ? "/api/github/backend-worker-setup" : "/api/github/worker-setup"
        const response = await fetch(setupPath, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor: cursor.current, selectedId }), signal: abort.signal,
        })
        const responseText = await response.text()
        let result: WorkerSetupResponse | null = null
        try {
          const parsed: unknown = JSON.parse(responseText)
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) result = parsed as WorkerSetupResponse
        } catch {
          // Preserve the HTTP details below so HTML platform errors are actionable.
        }
        const contentType = response.headers.get("content-type")?.split(";")[0] || "unknown content type"
        if (!result || typeof result !== "object") {
          throw new Error(`GitHub setup returned an unexpected response (HTTP ${response.status}, ${contentType}). Retry; if it continues, check the deployment function logs.`)
        }
        if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "GitHub setup failed. Retry to continue.")
        if (abort.signal.aborted) return
        setMessage(typeof result.message === "string" ? result.message : "Continuing GitHub setup...")
        if (typeof result.cursor === "string" && result.cursor) {
          cursor.current = result.cursor
        }
        if (result.status === "ready" && result.repo && typeof result.workflow === "string" && result.workflow) {
          cursor.current = undefined
          await onSelect(result.repo, result.workflow)
          return
        }
        if (result.status === "ready") throw new Error("GitHub setup did not return a repository workflow. Press start to retry.")
        if (result.status === "choose") {
          const nextCandidates = Array.isArray(result.candidates) ? result.candidates : []
          if (nextCandidates.length === 0) throw new Error("GitHub setup returned no repository choices. Press start to retry.")
          setCandidates(nextCandidates)
          return
        }
        if (result.status !== "pending" || typeof result.cursor !== "string" || !result.cursor) {
          throw new Error("GitHub setup returned an incomplete response. Press start to retry.")
        }
        selectedId = undefined
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")) }
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", cancel); resolve() }, 1500)
          abort.signal.addEventListener("abort", cancel, { once: true })
        })
      }
      setMessage("Setup is taking longer than expected. Press start to check the repository and finish setup.")
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Setup failed. Press start to retry.")
    } finally {
      if (!abort.signal.aborted) { setBusy(false); onBusy(false) }
      controller.current = null
    }
  }

  return <div className="md:col-span-2 flex flex-col gap-3">
    <p className="text-sm text-muted-foreground">Automatically find or create your worker repository, sync the latest code, and activate its workflow. Existing repositories are reused when you retry.</p>
    <div className="flex gap-2">
      <Button type="button" disabled={!connected || busy} aria-busy={busy} onClick={() => void run()}>{busy ? "Starting..." : startLabel || "start"}</Button>
    </div>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {candidates.length > 0 && <Select disabled={busy} onValueChange={(id) => void run(id)}>
      <SelectTrigger aria-label="Detected worker repositories"><SelectValue placeholder="Choose a matching repository" /></SelectTrigger>
      <SelectContent><SelectGroup>{candidates.map((repo) => <SelectItem key={repo.id} value={repo.id}>{repo.fullName}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>}
  </div>
}
