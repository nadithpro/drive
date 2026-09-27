"use client"

import * as React from "react"
import { GripVertical } from "lucide-react"
import { Card, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { formatLogStage } from "@/lib/dashboard-log-format"

export type DashboardLogEntry = {
  id?: string
  at: string
  context?: string
  stage?: string
  operation?: string
  status?: string
  message: string
}

type Column = "time" | "context" | "stage"
const defaults = { time: 170, context: 150, stage: 160 }
const clamp = (value: number) => Math.max(110, Math.min(600, value))

export function DashboardLogsCard({
  title = "Logs", entries, contextLabel = "Bucket", emptyState = "No logs captured yet.",
  storageKey, maxHeight = 420, autoScroll = true, className,
}: {
  title?: string
  entries: DashboardLogEntry[]
  contextLabel?: string
  emptyState?: string
  storageKey?: string
  maxHeight?: number
  autoScroll?: boolean
  className?: string
}) {
  const [widths, setWidths] = React.useState(defaults)
  const viewport = React.useRef<HTMLDivElement>(null)
  const follow = React.useRef(true)
  const resizing = React.useRef<{ key: Column; pointerId: number; x: number; width: number } | null>(null)

  React.useEffect(() => {
    let next = defaults
    try {
      const saved = storageKey ? JSON.parse(localStorage.getItem(storageKey) || "null") : null
      if (saved && typeof saved === "object") {
        next = { ...defaults }
        for (const key of Object.keys(defaults) as Column[]) {
          const value = saved[key] ?? (key === "context" ? saved.bucket : undefined)
          if (typeof value === "number" && Number.isFinite(value)) next[key] = clamp(value)
        }
      }
    } catch { /* Storage is optional. */ }
    setWidths(next)
  }, [storageKey])

  const resize = React.useCallback((key: Column, width: number) => {
    setWidths(previous => {
      const next = { ...previous, [key]: clamp(width) }
      try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Storage is optional. */ }
      return next
    })
  }, [storageKey])

  React.useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = resizing.current
      if (active && event.pointerId === active.pointerId) resize(active.key, active.width + event.clientX - active.x)
    }
    const stop = () => { resizing.current = null }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      resizing.current = null
    }
  }, [resize])

  const last = entries.at(-1)
  React.useEffect(() => {
    if (autoScroll && follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [autoScroll, entries.length, last?.at, last?.message])

  const gridTemplateColumns = `${widths.time}px ${widths.context}px ${widths.stage}px minmax(260px, 1fr)`
  return (
    <Card className={cn("gap-0 overflow-hidden rounded-3xl border-border/70 p-0 sm:gap-0 md:gap-0", className)}>
      <div className="border-b px-4 py-3"><CardTitle className="text-sm">{title}</CardTitle></div>
      <ScrollArea ref={viewport} style={{ maxHeight }} className="rounded-b-3xl" hideScrollbar onScroll={() => {
        const element = viewport.current
        if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
      }}>
        <div style={{ minWidth: Math.max(900, widths.time + widths.context + widths.stage + 320) }} className="font-mono text-xs">
          <div className="sticky top-0 z-10 border-b bg-background/80 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="grid select-none gap-3 text-[11px] text-muted-foreground" style={{ gridTemplateColumns }}>
              {([["time", "Time"], ["context", contextLabel], ["stage", "Stage / Status"]] as const).map(([key, label]) => (
                <div key={key} className="relative pr-8">
                  {label}
                  <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${label} column`} aria-valuemin={110} aria-valuemax={600} aria-valuenow={widths[key]}
                    className="absolute right-0 top-1/2 flex size-7 -translate-y-1/2 cursor-col-resize touch-none items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onKeyDown={event => {
                      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(key, widths[key] + (event.key === "ArrowLeft" ? -10 : 10)) }
                    }}
                    onPointerDown={event => {
                      event.preventDefault()
                      resizing.current = { key, pointerId: event.pointerId, x: event.clientX, width: widths[key] }
                      event.currentTarget.setPointerCapture(event.pointerId)
                    }}>
                    <GripVertical className="size-4" />
                  </div>
                </div>
              ))}
              <div>Message</div>
            </div>
          </div>
          <div className="flex flex-col gap-1 px-3 py-2">
            {entries.map((entry, index) => {
              const time = Date.parse(entry.at)
              const stage = `${formatLogStage(entry.stage, entry.operation)}${entry.status ? ` - ${formatLogStage(entry.status)}` : ""}`
              return (
                <div key={entry.id || `${entry.at}:${entry.context}:${index}`} className="grid gap-3" style={{ gridTemplateColumns }}>
                  <div className="truncate text-muted-foreground">{Number.isFinite(time) ? new Date(time).toLocaleString() : entry.at || "—"}</div>
                  <div className="truncate" title={entry.context}>{entry.context || "—"}</div>
                  <div className="truncate text-muted-foreground" title={stage}>{stage}</div>
                  <div className="whitespace-pre-wrap break-words">{entry.message || "-"}</div>
                </div>
              )
            })}
          </div>
        </div>
      </ScrollArea>
      {entries.length === 0 ? <div className="border-t px-4 py-8 text-center text-sm text-muted-foreground">{emptyState}</div> : null}
    </Card>
  )
}
