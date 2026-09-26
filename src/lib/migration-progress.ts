// Transfer progress is separate from verification/settings. Truncation
// prevents 6,657 / 6,660 rounding up to 100.0% while files remain.
export function migrationProgressPercent(processed: number, total: number): number {
  if (!Number.isFinite(processed) || !Number.isFinite(total) || total <= 0) return 0
  if (processed >= total) return 100
  return Math.max(0, Math.min(99.9, Math.floor((processed / total) * 1000) / 10))
}
