const labels: Record<string, string> = {
  awaiting_independent_verification: "Waiting for verification",
  transfer_copy: "Transfer", move_copy: "Move",
}

export function formatLogStage(value?: string, operation?: string): string {
  const stage = String(value || "").trim()
  if (!stage) return "—"
  const kind = String(operation || "").toLowerCase()
  const prefix = stage.toLowerCase().split(" ·")[0]
  if (["migration", "transfer", "move"].includes(kind)) {
    const stages: Record<string, string> = { repair_copy: kind === "move" ? "Move" : "Transfer", repair_scan: "Scanning", repair_verify: "Verifying" }
    if (stages[prefix]) return stages[prefix] + stage.slice(prefix.length)
  }
  const alias = Object.keys(labels).find(key => stage.toLowerCase() === key || stage.toLowerCase().startsWith(`${key} ·`))
  return alias ? labels[alias] + stage.slice(alias.length) : stage.replace(/[_-]+/g, " ").replace(/^./, character => character.toUpperCase())
}
