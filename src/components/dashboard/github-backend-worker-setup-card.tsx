"use client"

import * as React from "react"
import { toast } from "sonner"
import { GitHubWorkerSetup } from "@/components/dashboard/github-worker-setup"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WorkerRepository } from "@/lib/github-worker-setup"

export function GitHubBackendWorkerSetupCard({ connected, onConnect, onCreated }: {
  connected: boolean
  onConnect: () => void
  onCreated: () => void
}) {
  const [workerCount, setWorkerCount] = React.useState(1)
  const [setupBusy, setSetupBusy] = React.useState(false)

  async function setup(repo: WorkerRepository, workflow: string) {
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "GitHub Backend Worker",
        category: "worker",
        provider: "github_actions",
        workerKind: "backend",
        capabilities: ["scan", "verify"],
        githubRepoOwner: repo.owner,
        githubRepoName: repo.name,
        githubRepositoryId: repo.id,
        githubWorkflowFile: workflow,
        githubRef: repo.defaultBranch,
        workerCount,
        notes: "GitHub hosted backend scan and verification worker",
      }),
    })
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(result.error || "Unable to register Backend Worker")
    toast.success("Backend Worker set up and ready for Orchestrator dispatch")
    onCreated()
  }

  return <Card>
    <CardHeader>
      <CardTitle>GitHub Backend Worker</CardTitle>
      <CardDescription>GitHub hosted runners scan and verify buckets when dispatched by the Migration Orchestrator. Migration state and the Neon file queue remain with the Orchestrator.</CardDescription>
    </CardHeader>
    <CardContent className="grid gap-4">
      {!connected ? <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={onConnect}>Connect GitHub</Button>
        <p className="text-sm text-muted-foreground">Connect your GitHub account to detect and set up the worker repository.</p>
      </div> : <>
        <div className="space-y-2">
          <Label htmlFor="backend-worker-count">Workers per active migration</Label>
          <Select value={String(workerCount)} onValueChange={(value) => setWorkerCount(Number(value))} disabled={setupBusy}>
            <SelectTrigger id="backend-worker-count"><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3, 4, 5].map((count) => <SelectItem key={count} value={String(count)}>{count} worker{count === 1 ? "" : "s"}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <GitHubWorkerSetup
          connected={connected}
          workerKind="backend"
          startLabel="Start"
          onBusy={setSetupBusy}
          onSelect={setup}
        />
      </>}
    </CardContent>
  </Card>
}
