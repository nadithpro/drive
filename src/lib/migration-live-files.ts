export function currentMigrationFiles(files: Array<Record<string, unknown>>, now: number) {
  return files.filter((file) => {
    const heartbeat = Date.parse(String(file.lastHeartbeatAt || ""))
    return typeof file.key === "string" && file.key.length > 0
      && ["copying", "transferring", "running"].includes(String(file.status))
      && Number.isFinite(heartbeat) && now - heartbeat >= -90_000 && now - heartbeat < 90_000
  })
}
