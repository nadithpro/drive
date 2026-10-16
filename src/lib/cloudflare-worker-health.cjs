/**
 * Return a health failure reported by an authenticated Worker status payload.
 * Liveness is not readiness: an HTTP 200 can still contain a failed durable
 * orchestrator state (for example, panel reconciliation failing with 401).
 * @param {unknown} payload
 * @returns {string | null}
 */
function runtimeHealthError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Worker returned an invalid status response"
  }

  const response = /** @type {{ ok?: unknown; error?: unknown; state?: unknown }} */ (payload)
  if (response.ok === false) {
    return typeof response.error === "string" && response.error.trim()
      ? response.error.trim()
      : "Worker reported an unhealthy status"
  }

  if (!response.state || typeof response.state !== "object" || Array.isArray(response.state)) return null
  const state = /** @type {{ status?: unknown; last_error?: unknown; lastError?: unknown }} */ (response.state)
  const status = typeof state.status === "string" ? state.status.trim().toLowerCase() : ""
  if (status !== "error" && status !== "failed" && status !== "unhealthy") return null

  const detail = typeof state.last_error === "string" ? state.last_error
    : typeof state.lastError === "string" ? state.lastError
      : ""
  // /status has already passed bearer authentication before this function is
  // called. That proves the Worker's current secret matches the panel database,
  // so a persisted queue-sync 401 is from an earlier cycle and should not block
  // setup from re-enabling the orchestrator. The next cycle will clear it.
  if (/^Migration queue status sync failed \(HTTP 401\): Invalid orchestration secret$/i.test(detail.trim())) return null
  // A completed storage-sync cycle can retain this summary when an optional
  // panel-side delivery/CORS maintenance row fails. That work has its own
  // durable retry state and must not mark the deployed Worker itself offline.
  if (detail.trim() === "Panel delivery reconciliation reported errors") return null
  return detail.trim() || `Worker runtime reports ${status}`
}

module.exports = { runtimeHealthError }
