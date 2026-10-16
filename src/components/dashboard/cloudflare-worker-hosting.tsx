"use client"

import * as React from "react"
import { CheckCircle2, CircleDashed, Cloud, Eye, EyeOff, KeyRound, RefreshCw, ServerCog, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

type Mode = "single" | "separate"
type WorkerKey = "backend" | "scanner" | "migration"
type Installation = {
  mode: Mode
  status: "pending" | "running" | "ready" | "failed"
  step: string
  releaseVersion?: string
  error?: string
  tokensSaved?: boolean
  workers: Record<WorkerKey, { accountName?: string; scriptName: string; url?: string; deployed?: boolean; verified?: boolean; phase?: string; deployedAt?: string; verifiedAt?: string; lastCheckedAt?: string; latencyMs?: number; build?: string | number; error?: string }>
}
const labels: Record<WorkerKey, string> = { backend: "Backend Orchestrator", scanner: "File Scanner", migration: "Migration Orchestrator" }

export function CloudflareWorkerHosting({ onboarding = false, onReady }: { onboarding?: boolean; onReady?: () => void } = {}) {
  const [mode, setMode] = React.useState<Mode>("single")
  const [token, setToken] = React.useState("")
  const [scannerToken, setScannerToken] = React.useState("")
  const [migrationToken, setMigrationToken] = React.useState("")
  const [tokensVisible, setTokensVisible] = React.useState(false)
  const [canRevealTokens, setCanRevealTokens] = React.useState(false)
  const [installation, setInstallation] = React.useState<Installation | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const repairAttempted = React.useRef(false)
  const initialSyncStarted = React.useRef(false)
  const syncInFlight = React.useRef(false)
  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/workers/cloudflare-install", { cache: "no-store", signal: AbortSignal.timeout(15_000) })
    const payload = await response.json().catch(() => ({})) as { installation?: Installation; canRevealTokens?: boolean; error?: string }
    if (!response.ok) throw new Error(payload.error || "Unable to load Cloudflare hosting status")
    setInstallation(payload.installation || null)
    setCanRevealTokens(payload.canRevealTokens === true)
    if (payload.installation?.mode) setMode(payload.installation.mode)
  }, [])
  const syncWorkers = React.useCallback(async () => {
    if (syncInFlight.current) return
    syncInFlight.current = true
    setSyncing(true)
    try {
      for (const [worker] of ([
        ["backend", "Backend Orchestrator"],
        ["scanner", "File Scanner"],
        ["migration", "Migration Orchestrator"],
      ] as const)) {
        const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reconcile_worker", worker }), signal: AbortSignal.timeout(45_000) })
        const payload = await response.json().catch(() => ({})) as { installation?: Installation; error?: string }
        if (!response.ok) throw new Error(payload.error || "Worker status sync failed")
        if (payload.installation) setInstallation(payload.installation)
      }
    } finally { syncInFlight.current = false; setSyncing(false) }
  }, [])
  React.useEffect(() => {
    if (initialSyncStarted.current) return
    initialSyncStarted.current = true
    void refresh().then(() => syncWorkers()).catch(() => undefined)
  }, [refresh, syncWorkers])
  React.useEffect(() => {
    const ready = installation?.status === "ready" && installation.tokensSaved === true && (Object.values(installation.workers) as Installation["workers"][WorkerKey][]).every((worker) => worker.deployed && worker.verified && worker.url && worker.lastCheckedAt)
    if (ready) { repairAttempted.current = false; onReady?.(); return }
    if ((installation?.status !== "failed" && installation?.status !== "running") || !installation.tokensSaved || repairAttempted.current || busy) return
    repairAttempted.current = true
    void deploy(false)
  // deploy is intentionally event-like; installation transitions prevent repeats.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installation, busy, onReady])

  const revealTokens = async () => {
    if (tokensVisible) { setToken(""); setScannerToken(""); setMigrationToken(""); setTokensVisible(false); return }
    setBusy(true)
    try {
      const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal_tokens" }) })
      const payload = await response.json().catch(() => ({})) as { tokens?: { mode: Mode; token?: string; backendToken?: string; scannerToken?: string; migrationToken?: string }; error?: string }
      if (!response.ok || !payload.tokens) throw new Error(payload.error || "Unable to reveal saved tokens")
      setMode(payload.tokens.mode); setToken(payload.tokens.token || payload.tokens.backendToken || ""); setScannerToken(payload.tokens.scannerToken || ""); setMigrationToken(payload.tokens.migrationToken || ""); setTokensVisible(true)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to reveal saved tokens") }
    finally { setBusy(false) }
  }

  const saveReplacementTokens = async () => {
    setBusy(true)
    try {
      const body = mode === "single" ? { action: "replace_tokens", mode, token } : { action: "replace_tokens", mode, backendToken: token, scannerToken, migrationToken }
      const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({})) as { installation?: Installation; error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to replace saved tokens")
      setInstallation(payload.installation || installation); setToken(""); setScannerToken(""); setMigrationToken(""); setTokensVisible(false)
      toast.success("Cloudflare token replaced without redeploying healthy Workers")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to replace saved tokens") }
    finally { setBusy(false) }
  }

  const deploy = async (restart = false, checkForUpdates = false, forceRedeploy = false) => {
    setBusy(true)
    let polling = true
    const pollDeployment = async () => {
      if (!polling) return
      await refresh().catch(() => undefined)
      if (polling) window.setTimeout(() => void pollDeployment(), 1_000)
    }
    void pollDeployment()
    try {
      const body = mode === "single"
        ? { mode, token, restart, checkForUpdates, forceRedeploy }
        : { mode, backendToken: token, scannerToken, migrationToken, restart, checkForUpdates, forceRedeploy }
      const response = await fetch("/api/workers/cloudflare-install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({})) as { installation?: Installation; error?: string }
      if (payload.installation) setInstallation(payload.installation)
      if (!response.ok) throw new Error(payload.error || "Cloudflare Worker installation failed")
      setToken(""); setScannerToken(""); setMigrationToken("")
      toast.success(checkForUpdates ? "Latest Worker release checked; all Workers are verified" : forceRedeploy ? "All Cloudflare Workers were redeployed and verified" : "All Cloudflare Workers were deployed, verified and enabled")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cloudflare Worker installation failed")
      await refresh().catch(() => undefined)
    } finally { polling = false; setBusy(false) }
  }

  const workers = (["backend", "scanner", "migration"] as WorkerKey[])
  const hasDeployedWorkers = workers.some((worker) => Boolean(installation?.workers[worker]?.url || installation?.workers[worker]?.deployed))
  const deleteWorkers = async (): Promise<boolean> => {
    if (!window.confirm("Delete the three deployed Cloudflare Workers and clear their saved deployment state? This cannot be undone.")) return false
    setBusy(true)
    try {
      const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete_workers" }) })
      const payload = await response.json().catch(() => ({})) as { installation?: Installation | null; error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to delete Cloudflare Workers")
      setInstallation(payload.installation || null)
      setToken(""); setScannerToken(""); setMigrationToken(""); setTokensVisible(false)
      toast.success("Cloudflare Workers deleted; enter a token to deploy them again")
      return true
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to delete Cloudflare Workers"); return false }
    finally { setBusy(false) }
  }
  const changeMode = async (next: Mode) => {
    if (next === mode || busy) return
    if (hasDeployedWorkers) {
      if (!window.confirm("Changing the account layout requires deleting the current Workers first. Continue?")) return
      if (!await deleteWorkers()) return
    }
    setMode(next); setTokensVisible(false); setToken(""); setScannerToken(""); setMigrationToken("")
  }
  const installationReady = installation?.status === "ready" && installation.tokensSaved === true && workers.every((worker) => {
    const current = installation.workers[worker]
    return Boolean(current.deployed && current.verified && current.url && current.lastCheckedAt)
  })
  const tokenInputReady = Boolean(token && (mode === "single" || (scannerToken && migrationToken)))

  return (
    <section>
      <Card className="overflow-hidden py-0">
        <CardHeader className="border-b px-5 py-5 sm:px-7 sm:py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary"><Cloud /></div>
              <div><CardTitle>Cloudflare service Workers</CardTitle><CardDescription className="mt-1">Review deployment state, credentials, and live health for Drive&apos;s service Workers.</CardDescription></div>
            </div>
            <Badge variant="secondary">Automatic hosting</Badge>
          </div>
        </CardHeader>

        <>
          <CardContent className="flex flex-col gap-6 px-5 py-5 sm:px-7 sm:py-6">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="flex flex-col gap-4">
                <div><p className="text-sm font-medium">Cloudflare accounts</p><p className="mt-1 text-sm text-muted-foreground">Use one token for every Worker, or isolate each Worker in a separate account.</p></div>
                <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(value) => { if (value) void changeMode(value as Mode) }} disabled={busy || tokensVisible} aria-label="Cloudflare account layout"><ToggleGroupItem value="single">One account</ToggleGroupItem><ToggleGroupItem value="separate">Separate accounts</ToggleGroupItem></ToggleGroup>
              </div>
              <Item variant="outline"><ItemMedia variant="icon"><KeyRound /></ItemMedia><ItemContent><ItemTitle>API credentials</ItemTitle><p className="text-xs text-muted-foreground">{installation?.tokensSaved ? "Encrypted and saved" : "No token saved"}</p></ItemContent><ItemActions><Badge variant={installation?.tokensSaved ? "default" : "destructive"}>{installation?.tokensSaved ? "Saved" : "Required"}</Badge></ItemActions></Item>
            </div>

            <FieldGroup className={mode === "separate" ? "grid gap-4 lg:grid-cols-3" : undefined}>
              <Field className={mode === "single" ? "max-w-2xl" : undefined}><FieldLabel htmlFor="cf-backend-token">{mode === "single" ? "Cloudflare API token" : "Backend Orchestrator token"}</FieldLabel><div className="relative"><Input id="cf-backend-token" className="pr-10" type={tokensVisible ? "text" : "password"} autoComplete="off" value={token} placeholder={installation?.tokensSaved ? "Saved securely — leave blank to reuse" : "Paste API token"} onChange={(event) => setToken(event.target.value)} disabled={busy} />{installation?.tokensSaved && canRevealTokens ? <Button type="button" variant="ghost" size="icon" className="absolute top-1/2 right-1 -translate-y-1/2" aria-label={tokensVisible ? "Hide saved token" : "Show saved token"} onClick={() => void revealTokens()} disabled={busy}>{tokensVisible ? <EyeOff /> : <Eye />}</Button> : null}</div><FieldDescription>{installation?.tokensSaved ? "A saved token is available for future repairs." : "The token is encrypted before it is stored."}</FieldDescription></Field>
              {mode === "separate" ? <><Field><FieldLabel htmlFor="cf-scanner-token">File Scanner token</FieldLabel><Input id="cf-scanner-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={scannerToken} placeholder={installation?.tokensSaved ? "Saved securely — leave blank to reuse" : "Paste API token"} onChange={(event) => setScannerToken(event.target.value)} disabled={busy} /></Field><Field><FieldLabel htmlFor="cf-migration-token">Migration Orchestrator token</FieldLabel><Input id="cf-migration-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={migrationToken} placeholder={installation?.tokensSaved ? "Saved securely — leave blank to reuse" : "Paste API token"} onChange={(event) => setMigrationToken(event.target.value)} disabled={busy} /></Field></> : null}
            </FieldGroup>

            <div className="flex flex-wrap gap-2">
              {!installationReady ? <Button onClick={() => void deploy(false)} disabled={busy || (!installation?.tokensSaved && !tokenInputReady)}>{busy ? "Working…" : installation?.status === "failed" || installation?.status === "running" ? "Repair and continue" : "Deploy Workers"}</Button> : null}
              {installationReady ? <>
                <Button variant="outline" onClick={() => void deploy(false, true)} disabled={busy || syncing}><RefreshCw data-icon="inline-start" />{busy ? "Checking release…" : "Check for updates"}</Button>
                <Button variant="default" onClick={() => void deploy(false, false, true)} disabled={busy}><RefreshCw data-icon="inline-start" />{busy ? "Redeploying Workers…" : "Redeploy all Workers"}</Button>
              </> : null}
              {installation?.status === "failed" ? <Button variant="outline" onClick={() => void deploy(true)} disabled={busy || (!installation.tokensSaved && !tokenInputReady)}>Start fresh</Button> : null}
              <Button variant="outline" onClick={() => void syncWorkers()} disabled={busy || syncing}><RefreshCw data-icon="inline-start" className={syncing ? "animate-spin" : undefined} />{syncing ? "Syncing Workers…" : "Refresh status"}</Button>
              {hasDeployedWorkers ? <Button variant="destructive" onClick={() => void deleteWorkers()} disabled={busy || syncing}>Delete deployed Workers</Button> : null}
              {installation?.tokensSaved && !canRevealTokens ? <Badge variant="outline">Create the administrator before revealing saved tokens</Badge> : null}
              {installation?.tokensSaved && canRevealTokens && tokensVisible && tokenInputReady ? <Button onClick={() => void saveReplacementTokens()} disabled={busy}>Save replacement token</Button> : null}
            </div>

            {syncing && !installationReady ? <Alert><RefreshCw className="animate-spin" /><AlertTitle>Syncing Worker status</AlertTitle><AlertDescription>Checking each Worker separately and saving its latest heartbeat and deployment details.</AlertDescription></Alert> : installation?.error ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>Worker verification failed</AlertTitle><AlertDescription>{installation.error}</AlertDescription></Alert> : installationReady ? <Alert><CheckCircle2 /><AlertTitle>All Workers are live</AlertTitle><AlertDescription>Each script exists in Cloudflare and passed a current authenticated health check.</AlertDescription></Alert> : <Alert><CircleDashed /><AlertTitle>{installation?.status === "running" ? "Deploying Workers" : installation ? "Deployment is not verified" : "Ready for first deployment"}</AlertTitle><AlertDescription>{installation ? `Current step: ${installation.step}${installation.releaseVersion ? ` · Release ${installation.releaseVersion}` : ""}.` : "Enter the required token, then Drive will deploy Workers in dependency order."}</AlertDescription></Alert>}
          </CardContent>

          <Separator />
          <CardContent className="p-0">
            <ItemGroup>{workers.map((worker, index) => {
              const current = installation?.tokensSaved ? installation.workers[worker] : undefined
              const live = Boolean(current?.deployed && current.verified && current.url && current.lastCheckedAt)
              const phase = live ? "verified" : current?.phase === "failed" ? "failed" : current?.phase || "not deployed"
              const phaseLabel = ["uploading", "configuring", "deployed", "deleting", "verifying"].includes(phase) ? "deploying" : phase
              return <React.Fragment key={worker}>{index > 0 ? <Separator /> : null}<Item className="rounded-none border-0 px-5 py-5 sm:px-7"><ItemMedia variant="icon">{live ? <CheckCircle2 /> : phase === "failed" ? <TriangleAlert /> : <ServerCog />}</ItemMedia><ItemContent><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><ItemTitle>{labels[worker]}</ItemTitle><p className="mt-1 text-xs text-muted-foreground">{current?.scriptName || "Waiting for a verified deployment"}</p></div><Badge variant={live ? "default" : phase === "failed" ? "destructive" : "secondary"}>{live ? "Live" : phaseLabel}</Badge></div>{current?.url ? <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-5"><p className="truncate" title={current.url}>URL <span className="block text-foreground">{current.url}</span></p><p>Cloudflare account <span className="block text-foreground">{current.accountName || "Validated account"}</span></p><p>Last deployed <span className="block text-foreground">{current.deployedAt ? new Date(current.deployedAt).toLocaleString() : "Unknown"}</span></p><p>Last response <span className="block text-foreground">{current.latencyMs != null ? `${current.latencyMs} ms` : "No response recorded"}</span></p><p>Live check <span className="block text-foreground">{current.lastCheckedAt ? new Date(current.lastCheckedAt).toLocaleString() : "Never checked"}</span></p></div> : <p className="mt-2 text-sm text-muted-foreground">No deployed Worker URL exists yet. Account details will appear only after deployment.</p>}{current?.error && current.url ? <p className="mt-2 text-sm text-destructive">{current.error}</p> : null}</ItemContent></Item></React.Fragment>
            })}</ItemGroup>
          </CardContent>
        </>
      </Card>
    </section>
  )
}
