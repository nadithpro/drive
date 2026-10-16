import { NextResponse } from "next/server"
import type { DashboardAccountSummary } from "@/lib/accounts-store"
import type { DriveMigrationItem } from "@/lib/migrations-store"
import { getMergedBucketSnapshot } from "@/lib/migration-bucket-state"
import { queryDb } from "@/lib/db"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"

type RangeKey = "7d" | "30d" | "90d" | "all"

type BucketStatsRow = {
  id: string
  account_id: string
  bucket_name: string
  objects: number | string | null
  bytes: number | string | null
  status: string | null
  error: string | null
  updated_at: string | null
}

type MigrationItemRow = {
  id: string
  migration_id: string
  source_bucket: string
  target_bucket: string
  source_objects: number | string | null
  source_bytes: number | string | null
  slurper_job_id: string | null
  slurper_status: string | null
  progress: Record<string, unknown> | null
  last_progress_at: string | null
  created_at: string
  updated_at: string | null
}

type VerifyDiffRow = {
  id: string
  migration_item_id: string
  kind: string
  key: string
  created_at: string
}

type AnalyticsRepairJobRow = {
  id: string
  migration_id: string
  status: string
  summary: string | null
  error: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

type AnalyticsRepairJob = {
  id: string
  migrationId: string
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
  summary?: string
  error?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

type ActiveAccountSnapshotRow = {
  captured_day: string
  account_id: string | null
  scope: "account" | "system"
  account_label: string | null
  account_email: string | null
  buckets: string | number | null
  objects: string | number | null
  bytes: string | number | null
  captured_at: string
}

type AnalyticsMigration = {
  id: string
  status: string
  syncStatus?: string
  syncMessage?: string
  createdAt: string
  completedAt?: string
  updatedAt?: string
}

const ANALYTICS_ITEM_PROGRESS_SQL = `jsonb_strip_nulls(jsonb_build_object(
  'stage',progress->'stage',
  'sourceScanStatus',progress->'sourceScanStatus',
  'slurperStatus',progress->'slurperStatus',
  'slurperCumulative',progress->'slurperCumulative',
  'slurperNormalized',progress->'slurperNormalized',
  'slurper',case when jsonb_typeof(progress->'slurper')='object' then jsonb_build_object('result',jsonb_strip_nulls(jsonb_build_object(
    'status',progress->'slurper'->'result'->'status',
    'objects',progress->'slurper'->'result'->'objects',
    'transferredObjects',progress->'slurper'->'result'->'transferredObjects',
    'skippedObjects',progress->'slurper'->'result'->'skippedObjects',
    'failedObjects',progress->'slurper'->'result'->'failedObjects'
  ))) end,
  'repairWorker',case when jsonb_typeof(progress->'repairWorker')='object' then jsonb_strip_nulls(jsonb_build_object(
    'stage',progress->'repairWorker'->'stage',
    'jobId',progress->'repairWorker'->'jobId',
    'status',progress->'repairWorker'->'status',
    'transferred',progress->'repairWorker'->'transferred',
    'failed',progress->'repairWorker'->'failed',
    'skipped',progress->'repairWorker'->'skipped',
    'cumulativeTransferred',progress->'repairWorker'->'cumulativeTransferred',
    'cumulativeSkipped',progress->'repairWorker'->'cumulativeSkipped',
    'details',case when jsonb_typeof(progress->'repairWorker'->'details')='object' then jsonb_strip_nulls(jsonb_build_object(
      'sourceObjectCount',progress->'repairWorker'->'details'->'sourceObjectCount',
      'initialMissing',progress->'repairWorker'->'details'->'initialMissing',
      'initialMismatched',progress->'repairWorker'->'details'->'initialMismatched',
      'finalMissing',progress->'repairWorker'->'details'->'finalMissing',
      'finalMismatched',progress->'repairWorker'->'details'->'finalMismatched'
    )) end
  )) end,
  'verify',case when jsonb_typeof(progress->'verify')='object' then jsonb_strip_nulls(jsonb_build_object(
    'status',progress->'verify'->'status',
    'missingInDest',progress->'verify'->'missingInDest',
    'sizeMismatched',progress->'verify'->'sizeMismatched',
    'extraInDest',progress->'verify'->'extraInDest',
    'note',progress->'verify'->'note'
  )) end,
  'live',case when jsonb_typeof(progress->'live')='object' then jsonb_strip_nulls(jsonb_build_object(
    'updatedAt',progress->'live'->'updatedAt',
    'status',progress->'live'->'status',
    'transferredObjects',progress->'live'->'transferredObjects',
    'transferredBytes',progress->'live'->'transferredBytes',
    'skippedObjects',progress->'live'->'skippedObjects',
    'failedObjects',progress->'live'->'failedObjects',
    'unaccountedObjects',progress->'live'->'unaccountedObjects',
    'verifyIssues',progress->'live'->'verifyIssues',
    'totalObjects',progress->'live'->'totalObjects',
    'workerStage',progress->'live'->'workerStage',
    'workerStatus',progress->'live'->'workerStatus',
    'slurperJobId',progress->'live'->'slurperJobId',
    'repairJobId',progress->'live'->'repairJobId'
  )) end
))`

type AnalyticsSqlSummaryRow = {
  user_summary: { total: string | number; active: string | number }
  migrations: AnalyticsMigration[]
  repair_jobs: AnalyticsRepairJobRow[]
  active_account_snapshots: ActiveAccountSnapshotRow[]
  account_summaries: DashboardAccountSummary[]
  bucket_status_breakdown: Record<string, string | number>
  worker_status_breakdown: Record<string, string | number>
  worker_total_count: string | number
  online_worker_count: string | number
  active_bucket_stats: BucketStatsRow[]
  active_bucket_summary: {
    bucket_count: string | number
    objects: string | number
    bytes: string | number
    newest_updated_at: string | null
    incomplete: boolean
  }
  failed_bucket_count: string | number
  attention_bucket_stats: BucketStatsRow[]
  recent_diffs: VerifyDiffRow[]
  failure_record_count: string | number
  verification_diff_count: string | number
}

function asRange(value: string | null): RangeKey {
  if (value === "7d" || value === "30d" || value === "90d") return value
  return "all"
}

function rangeDays(range: RangeKey): number | null {
  if (range === "all") return null
  if (range === "90d") return 90
  if (range === "30d") return 30
  return 7
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function dateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

function earliestDate(values: Array<string | undefined | null>): Date {
  let earliest = Number.POSITIVE_INFINITY
  for (const value of values) {
    const time = value ? Date.parse(value) : Number.NaN
    if (Number.isFinite(time) && time < earliest) earliest = time
  }
  if (!Number.isFinite(earliest)) {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    return today
  }
  const date = new Date(earliest)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function increment(map: Record<string, number>, key: string | undefined | null, by = 1) {
  const normalized = String(key || "unknown")
  map[normalized] = (map[normalized] ?? 0) + by
}

function itemMetrics(item: DriveMigrationItem) {
  const snapshot = getMergedBucketSnapshot(item)
  return {
    totalObjects: snapshot.total || item.sourceObjects || 0,
    totalBytes: item.sourceBytes || 0,
    transferred: snapshot.transferred,
    skipped: snapshot.skipped,
    failed: snapshot.failed,
    verifyIssues: snapshot.verifyIssues,
  }
}

async function capture<T>(
  label: string,
  warnings: string[],
  fn: () => Promise<T>,
  fallback: T,
  options?: { reportWarning?: boolean }
): Promise<T> {
  try {
    return await fn()
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? label)
        : label
    if (options?.reportWarning === false) {
      console.warn(`[analytics] ${label}: ${message}`)
    } else {
      warnings.push(`${label}: ${message}`)
    }
    return fallback
  }
}

async function listAnalyticsMigrationItems(start: Date, rangeIsAll: boolean): Promise<MigrationItemRow[]> {
  const rangeFilter = rangeIsAll
    ? ""
    : "where coalesce(last_progress_at,updated_at,created_at) >= $1"
  const { rows } = await queryDb<MigrationItemRow>(`
    select id,migration_id,source_bucket,target_bucket,source_objects,source_bytes,slurper_job_id,slurper_status,
      ${ANALYTICS_ITEM_PROGRESS_SQL} as progress,last_progress_at,created_at,updated_at
    from public.drive_migration_items
    ${rangeFilter}
  `, rangeIsAll ? undefined : [start.toISOString()])
  return rows
}

async function getAnalyticsSqlSummary(): Promise<AnalyticsSqlSummaryRow> {
  const { rows } = await queryDb<AnalyticsSqlSummaryRow>(`
    with active_buckets as materialized (
      select s.id,s.account_id,s.bucket_name,s.objects,s.bytes,s.status,s.error,s.updated_at
      from public.drive_bucket_stats s
      join public.drive_accounts a on a.id=s.account_id and a.status='active'
    ), bucket_status_counts as (
      select coalesce(nullif(status,''),'unknown') status,count(*) count
      from public.drive_bucket_stats
      group by 1
    ), active_bucket_totals as (
      select count(*)::text bucket_count,
        coalesce(sum(objects),0)::text objects,
        coalesce(sum(bytes),0)::text bytes,
        max(updated_at)::text newest_updated_at,
        coalesce(bool_or(lower(coalesce(status,'')) in ('pending','running','error')),false) incomplete
      from active_buckets
    ), recent_bucket_errors as (
      select id,account_id,bucket_name,objects,bytes,status,error,updated_at
      from public.drive_bucket_stats
      where status='error'
      order by updated_at desc nulls first,id
      limit 10
    ), recent_diffs as (
      select id,migration_item_id,kind,key,created_at
      from public.drive_bucket_verify_diffs
      order by created_at desc
      limit 25
    ), effective_agents as materialized (
      select case
        when provider='github_actions' then case
          when last_heartbeat_at >= now() - interval '90 seconds' then 'online'
          when status in ('online','busy') then 'online'
          else 'offline'
        end
        when status='error' then 'offline'
        when provider in ('self_hosted','local') and status='online'
          and (last_heartbeat_at is null or last_heartbeat_at < now() - interval '60 seconds') then 'offline'
        else coalesce(nullif(status,''),'unknown')
      end as effective_status
      from public.drive_agents
    ), worker_status_counts as (
      select effective_status,count(*)::int as count
      from effective_agents
      group by effective_status
    )
    select
      (select jsonb_build_object(
        'total',count(*)::text,
        'active',count(*) filter(where status='active')::text
      ) from public.drive_users) user_summary,
      coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id',m.id,'status',m.status,'syncStatus',m.sync_status,'syncMessage',m.sync_message,
          'createdAt',m.created_at::text,'completedAt',m.completed_at::text,'updatedAt',m.updated_at::text
        )) order by m.created_at desc,m.id desc)
        from (
          select id,status,sync_status,sync_message,created_at,completed_at,updated_at
          from public.drive_migrations
          order by created_at desc,id desc
          limit 100
        ) m
      ),'[]'::jsonb) migrations,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',j.id,'migration_id',j.migration_id,'status',j.status,'summary',j.summary,
          'error',j.error,'completed_at',j.completed_at::text,'created_at',j.created_at::text,
          'updated_at',j.updated_at::text
        ) order by j.created_at desc,j.id desc)
        from (
          select id,migration_id,status,summary,error,completed_at,created_at,updated_at
          from public.drive_repair_jobs
          order by created_at desc,id desc
          limit 100
        ) j
      ),'[]'::jsonb) repair_jobs,
      coalesce((
        select jsonb_agg(to_jsonb(daily) order by daily.captured_day asc)
        from (
          select captured_day::text as captured_day,account_id,scope,account_label,account_email,buckets,objects,bytes,captured_at
          from public.drive_analytics_active_account_snapshots snapshots
          where scope='system'
          order by captured_day desc
          limit 730
        ) daily
      ),'[]'::jsonb) active_account_snapshots,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',account.id,'label',account.label,'email',account.email,'createdAt',account.created_at::text,
          'cloudflareAccountId',account.cloudflare_account_id,'status',account.status,
          'totalBuckets',account.total_buckets,'totalObjects',account.total_objects,'totalBytes',account.total_bytes,
          'lastSyncedAt',account.last_synced_at::text,'syncStatus',account.sync_status,'syncMessage',account.sync_message
        ) order by account.updated_at desc nulls last,account.created_at desc,account.id desc)
        from public.drive_accounts account
      ),'[]'::jsonb) account_summaries,
      coalesce((select jsonb_object_agg(status,count) from bucket_status_counts),'{}'::jsonb) bucket_status_breakdown,
      coalesce((select jsonb_object_agg(effective_status,count) from worker_status_counts),'{}'::jsonb) worker_status_breakdown,
      coalesce((select sum(count) from worker_status_counts),0)::text worker_total_count,
      coalesce((select sum(count) from worker_status_counts where effective_status='online'),0)::text online_worker_count,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'account_id',account_id,'bucket_name',bucket_name,
        'objects',objects::text,'bytes',bytes::text,'status',status,'error',error,'updated_at',updated_at::text
      ) order by bytes desc,objects desc) from active_buckets),'[]'::jsonb) active_bucket_stats,
      (select to_jsonb(totals) from active_bucket_totals totals) active_bucket_summary,
      (select coalesce(sum(count) filter (where status='error'),0)::text from bucket_status_counts) failed_bucket_count,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'account_id',account_id,'bucket_name',bucket_name,
        'objects',objects::text,'bytes',bytes::text,'status',status,'error',error,'updated_at',updated_at::text
      ) order by updated_at desc nulls first,id) from recent_bucket_errors),'[]'::jsonb) attention_bucket_stats,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'migration_item_id',migration_item_id,'kind',kind,'key',key,'created_at',created_at::text
      ) order by created_at desc) from recent_diffs),'[]'::jsonb) recent_diffs,
      (select count(*)::text from public.drive_migration_item_failure_records) failure_record_count,
      (select count(*)::text from public.drive_bucket_verify_diffs) verification_diff_count
  `)
  if (!rows[0]) throw new Error("Analytics database summary query returned no row")
  return rows[0]
}

const ANALYTICS_CACHE_TTL_MS = 20_000

const analyticsCache = new Map<RangeKey, { expiresAt: number; payload: unknown }>()
const analyticsInFlight = new Map<RangeKey, Promise<unknown>>()

function mapRepairJobRow(row: AnalyticsRepairJobRow): AnalyticsRepairJob {
  const status = ["pending", "claimed", "running", "completed", "failed", "canceled"].includes(row.status)
    ? row.status
    : "pending"
  return {
    id: row.id,
    migrationId: row.migration_id,
    status: status as AnalyticsRepairJob["status"],
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function buildAnalyticsPayload(range: RangeKey) {
  const days = rangeDays(range)
  const generatedAt = new Date().toISOString()
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  if (days === null) {
    start.setTime(0)
  } else {
    start.setUTCDate(start.getUTCDate() - (days - 1))
  }

  const warnings: string[] = []

  const [
    sqlSummary,
    migrationItemRows,
  ] =
    await Promise.all([
      getAnalyticsSqlSummary(),
      capture(
        "migration items",
        warnings,
        () => listAnalyticsMigrationItems(start, days === null),
        [] as MigrationItemRow[]
      ),
    ])

  const migrations = sqlSummary.migrations ?? []
  const users = {
    total: toNumber(sqlSummary.user_summary?.total),
    active: toNumber(sqlSummary.user_summary?.active),
  }
  const repairJobs = (sqlSummary.repair_jobs ?? []).map(mapRepairJobRow)
  const activeAccountSnapshotRows = sqlSummary.active_account_snapshots ?? []

  // Account summaries and all bucket/worker aggregates come from the same
  // PostgreSQL statement snapshot, avoiding a second query and mixed freshness.
  const accounts = sqlSummary.account_summaries ?? []

  const bucketStats = sqlSummary.active_bucket_stats
  const recentDiffs = sqlSummary.recent_diffs
  const failureRecordCount = toNumber(sqlSummary.failure_record_count)
  const verifyDiffCount = toNumber(sqlSummary.verification_diff_count)

  const itemRowsAsItems: DriveMigrationItem[] = migrationItemRows.map((row) => ({
    id: row.id,
    migrationId: row.migration_id,
    sourceBucket: row.source_bucket,
    targetBucket: row.target_bucket,
    sourceObjects: toNumber(row.source_objects) || undefined,
    sourceBytes: toNumber(row.source_bytes) || undefined,
    slurperJobId: row.slurper_job_id ?? undefined,
    slurperStatus: row.slurper_status ?? undefined,
    progress: row.progress ?? {},
    lastProgressAt: row.last_progress_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  }))

  const accountById = new Map(accounts.map((account) => [account.id, account]))

  const migrationBreakdown: Record<string, number> = {}
  for (const migration of migrations) increment(migrationBreakdown, migration.status)

  const accountBreakdown: Record<string, number> = {}
  for (const account of accounts) increment(accountBreakdown, account.status)

  const workerBreakdown = Object.fromEntries(
    Object.entries(sqlSummary.worker_status_breakdown).map(([status, count]) => [status, toNumber(count)])
  )

  const repairBreakdown: Record<string, number> = {}
  for (const job of repairJobs) increment(repairBreakdown, job.status)

  const bucketSyncBreakdown = Object.fromEntries(
    Object.entries(sqlSummary.bucket_status_breakdown).map(([status, count]) => [status, toNumber(count)])
  )

  const activeAccount = accounts.find((account) => account.status === "active") ?? null
  const activeAccounts = accounts.filter((account) => account.status === "active")
  const activeAccountIds = new Set(activeAccounts.map((account) => account.id))
  const activeBucketStats = bucketStats.filter((row) => activeAccountIds.has(row.account_id))
  const activeAnalyticsBucketStats = activeBucketStats
  const chartStart =
    range === "all"
      ? earliestDate([
          ...activeAnalyticsBucketStats.map((row) => row.updated_at),
          ...activeAccountSnapshotRows.map((row) => row.captured_day),
          ...migrations.map((migration) => migration.createdAt),
          ...migrations.map((migration) => migration.completedAt),
          ...itemRowsAsItems.map((item) => item.lastProgressAt || item.updatedAt || item.createdAt),
          ...repairJobs.map((job) => job.updatedAt || job.createdAt),
        ])
      : start
  const chartDays = Math.max(
    1,
    Math.floor((new Date(new Date().toISOString().slice(0, 10)).getTime() - chartStart.getTime()) / 86_400_000) + 1
  )

  const dayKeys = Array.from({ length: chartDays }, (_, index) => {
    const date = new Date(chartStart)
    date.setUTCDate(chartStart.getUTCDate() + index)
    return dateKey(date)
  })

  // System snapshots aggregate all active accounts at capture time. Legacy
  // account-scoped rows remain stored, but are not presented as whole-system
  // history because they only represented one account per day.
  const activeHistoryByDay = new Map<string, ActiveAccountSnapshotRow>()
  for (const row of activeAccountSnapshotRows) {
    const previous = activeHistoryByDay.get(row.captured_day)
    if (!previous || Date.parse(row.captured_at) >= Date.parse(previous.captured_at)) {
      activeHistoryByDay.set(row.captured_day, row)
    }
  }
  const activeHistorySeries = [...activeHistoryByDay.values()]
    .sort((a, b) => a.captured_day.localeCompare(b.captured_day))
    .map((row) => ({
      date: row.captured_day,
      accountId: "system",
      accountLabel: "All active accounts",
      buckets: toNumber(row.buckets),
      storageBytes: toNumber(row.bytes),
      objects: toNumber(row.objects),
      capturedAt: row.captured_at,
    }))
  const legacyStorageSeries =
    activeHistorySeries.length > 0
      ? activeHistorySeries
      : activeAnalyticsBucketStats.length > 0
        ? [
            {
              date: generatedAt.slice(0, 10),
              accountId: "system",
              accountLabel: "All active accounts",
              buckets: activeAnalyticsBucketStats.length,
              storageBytes: activeAnalyticsBucketStats.reduce((sum, row) => sum + toNumber(row.bytes), 0),
              objects: activeAnalyticsBucketStats.reduce((sum, row) => sum + toNumber(row.objects), 0),
              capturedAt: generatedAt,
            },
          ]
        : []
  const storageSeriesByDay = new Map(legacyStorageSeries.map((point) => [point.date, point]))
  const activeAccountSeries = Array.from(storageSeriesByDay.values()).sort((a, b) => a.date.localeCompare(b.date))

  // Walk the sparse storage snapshots once. Each snapshot remains effective
  // until the next change; dates before the first snapshot are explicitly
  // marked unknown so fixed chart ranges can render them as zero without
  // confusing them with a real zero-value snapshot.
  const logicalStorageByDay = new Map<string, (typeof activeAccountSeries)[number] | undefined>()
  const createdMigrationsByDay = new Map<string, number>()
  const completedMigrationsByDay = new Map<string, number>()
  const itemMetricsByDay = new Map<string, { transferred: number; failed: number; verifyIssues: number }>()
  const activeRepairsByDay = new Map<string, number>()
  for (const migration of migrations) {
    const createdDay = dateKey(migration.createdAt)
    createdMigrationsByDay.set(createdDay, (createdMigrationsByDay.get(createdDay) ?? 0) + 1)
    if (migration.completedAt) {
      const completedDay = dateKey(migration.completedAt)
      completedMigrationsByDay.set(completedDay, (completedMigrationsByDay.get(completedDay) ?? 0) + 1)
    }
  }
  for (const item of itemRowsAsItems) {
    const anchor = item.lastProgressAt || item.updatedAt || item.createdAt
    const timestamp = anchor ? Date.parse(anchor) : Number.NaN
    if (!Number.isFinite(timestamp)) continue
    const key = dateKey(anchor!)
    const metrics = itemMetrics(item)
    const daily = itemMetricsByDay.get(key) ?? { transferred: 0, failed: 0, verifyIssues: 0 }
    itemMetricsByDay.set(key, {
      transferred: daily.transferred + metrics.transferred,
      failed: daily.failed + metrics.failed,
      verifyIssues: daily.verifyIssues + metrics.verifyIssues,
    })
  }
  for (const job of repairJobs) {
    if (!["pending", "claimed", "running"].includes(job.status)) continue
    const anchor = job.updatedAt || job.createdAt
    if (!anchor || !Number.isFinite(Date.parse(anchor))) continue
    const key = dateKey(anchor)
    activeRepairsByDay.set(key, (activeRepairsByDay.get(key) ?? 0) + 1)
  }
  let cumulativeTransfer = { transferred: 0, failed: 0, verifyIssues: 0 }
  let logicalStorageIndex = -1
  const series = dayKeys.map((day) => {
    while (
      logicalStorageIndex + 1 < activeAccountSeries.length &&
      activeAccountSeries[logicalStorageIndex + 1].date <= day
    ) {
      logicalStorageIndex += 1
    }
    const logicalStoragePoint =
      logicalStorageIndex >= 0 ? activeAccountSeries[logicalStorageIndex] : undefined
    logicalStorageByDay.set(day, logicalStoragePoint)
    const storageBytes = logicalStoragePoint?.storageBytes ?? 0
    const objects = logicalStoragePoint?.objects ?? 0
    const delta = itemMetricsByDay.get(day)
    if (delta) {
      cumulativeTransfer = {
        transferred: cumulativeTransfer.transferred + delta.transferred,
        failed: cumulativeTransfer.failed + delta.failed,
        verifyIssues: cumulativeTransfer.verifyIssues + delta.verifyIssues,
      }
    }
    return {
      date: day,
      storageBytes,
      objects,
      createdMigrations: createdMigrationsByDay.get(day) ?? 0,
      completedMigrations: completedMigrationsByDay.get(day) ?? 0,
      transferredObjects: cumulativeTransfer.transferred,
      failedObjects: cumulativeTransfer.failed,
      verifyIssues: cumulativeTransfer.verifyIssues,
      activeRepairs: activeRepairsByDay.get(day) ?? 0,
    }
  })
  const dailyStorageSeries = series.map((point) => {
    const source = logicalStorageByDay.get(point.date)
    return {
      date: point.date,
      accountId: source?.accountId ?? "logical-storage",
      accountLabel: source?.accountLabel ?? "Logical storage",
      buckets: source?.buckets ?? 0,
      storageBytes: point.storageBytes,
      objects: point.objects,
      capturedAt: source?.capturedAt ?? generatedAt,
      hasSnapshot: Boolean(source),
    }
  })

  // Account totals are the last atomically committed provider snapshot. Keep
  // using them during a refresh; pending bucket rows are work-in-progress and
  // must never replace a committed snapshot with placeholder zeroes.
  const activeAggregateReady = activeAccounts.length > 0 && activeAccounts.every((account) => Boolean(account.lastSyncedAt))
  const activeBucketCount = toNumber(sqlSummary.active_bucket_summary.bucket_count)
  const activeBucketObjects = toNumber(sqlSummary.active_bucket_summary.objects)
  const activeBucketBytes = toNumber(sqlSummary.active_bucket_summary.bytes)
  const totalStorageBytes = Math.max(0, activeAggregateReady
    ? activeAccounts.reduce((sum, account) => sum + toNumber(account.totalBytes), 0)
    : activeBucketBytes)
  const totalObjects = Math.max(0, activeAggregateReady
    ? activeAccounts.reduce((sum, account) => sum + toNumber(account.totalObjects), 0)
    : activeBucketObjects)
  const totalBuckets = Math.max(0, activeAggregateReady
    ? activeAccounts.reduce((sum, account) => sum + toNumber(account.totalBuckets), 0)
    : activeBucketCount)
  const migrationNeedsAttention = (migration: AnalyticsMigration) =>
    migration.status === "failed" ||
    (migration.syncStatus === "error" && migration.status !== "completed" && migration.status !== "canceled")

  const failedMigrationCount = migrations.filter(migrationNeedsAttention).length
  const activeMigrationCount = migrations.filter((m) => m.status === "running" || m.status === "verifying").length
  const failedRepairCount = repairJobs.filter((job) => job.status === "failed").length
  const activeRepairCount = repairJobs.filter((job) => ["pending", "claimed", "running"].includes(job.status)).length
  const failedBucketStats = toNumber(sqlSummary.failed_bucket_count)
  const onlineWorkers = toNumber(sqlSummary.online_worker_count)
  const topBuckets = activeAnalyticsBucketStats
    .map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountLabel: accountById.get(row.account_id)?.label ?? "Unknown account",
      name: row.bucket_name,
      objects: toNumber(row.objects),
      bytes: toNumber(row.bytes),
      status: row.status ?? "unknown",
      error: row.error ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.objects - a.objects)

  const attentionItems = [
    ...migrations
      .filter(migrationNeedsAttention)
      .map((m) => ({
        id: `migration-${m.id}`,
        severity: "critical",
        title: m.status === "failed" ? "Migration failed" : "Migration sync issue",
        detail: m.syncMessage || `Migration ${m.id} needs attention`,
        href: `/dashboard/migrations/${m.id}`,
        at: m.updatedAt || m.completedAt || m.createdAt,
      })),
    ...repairJobs
      .filter((job) => job.status === "failed")
      .map((job) => ({
        id: `repair-${job.id}`,
        severity: "critical",
        title: "Worker job failed",
        detail: job.error || job.summary || `Repair job ${job.id} failed`,
        href: `/dashboard/migrations/${job.migrationId}/jobs/${job.id}`,
        at: job.updatedAt || job.completedAt || job.createdAt,
      })),
    ...sqlSummary.attention_bucket_stats
      .map((row) => ({
        id: `bucket-${row.id}`,
        severity: "warning",
        title: "Bucket stats error",
        detail: `${row.bucket_name}: ${row.error || "Unable to sync bucket stats"}`,
        href: "/dashboard/storage",
        at: row.updated_at || generatedAt,
      })),
    ...accounts
      .filter((account) => account.syncStatus === "error" || !account.cloudflareAccountId)
      .map((account) => ({
        id: `account-${account.id}`,
        severity: account.syncStatus === "error" ? "critical" : "warning",
        title: "Account sync issue",
        detail: account.syncMessage || `${account.label} is not fully synced`,
        href: "/dashboard/accounts",
        at: account.lastSyncedAt || account.createdAt,
      })),
    ...recentDiffs.map((diff) => ({
      id: `diff-${diff.id}`,
      severity: "warning",
      title: `Verification ${diff.kind.replaceAll("_", " ")}`,
      detail: diff.key,
      href: "/dashboard/migrations",
      at: diff.created_at,
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 10)

  const newestBucketStat = sqlSummary.active_bucket_summary.newest_updated_at
    ? Date.parse(sqlSummary.active_bucket_summary.newest_updated_at)
    : Number.NaN
  const activeBucketStatsIncomplete =
    activeAccounts.length > 0 &&
    (activeBucketStats.length === 0 || sqlSummary.active_bucket_summary.incomplete)
  const staleBucketStats =
    (activeBucketStatsIncomplete && !activeAggregateReady) ||
    (activeAccounts.length > 0 && activeBucketStats.length > 0 && !Number.isFinite(newestBucketStat))

  return {
    range,
    generatedAt,
    activeAccount: activeAccount
      ? {
          id: activeAccount.id,
          label: activeAccount.label,
          email: activeAccount.email,
          status: activeAccount.status,
          lastSyncedAt: activeAccount.lastSyncedAt,
          syncStatus: activeAccount.syncStatus,
        }
      : null,
    metrics: {
      storageBytes: totalStorageBytes,
      objects: totalObjects,
      buckets: totalBuckets,
      accounts: accounts.length,
      activeAccounts: accounts.filter((account) => account.status === "active").length,
      users: users.total,
      activeUsers: users.active,
      migrations: migrations.length,
      activeMigrations: activeMigrationCount,
      failedMigrations: failedMigrationCount,
      workers: toNumber(sqlSummary.worker_total_count),
      onlineWorkers,
      repairJobs: repairJobs.length,
      activeRepairJobs: activeRepairCount,
      failedRepairJobs: failedRepairCount,
      failureRecords: failureRecordCount,
      verificationDiffs: verifyDiffCount,
      attentionItems: failedMigrationCount + failedRepairCount + failedBucketStats + failureRecordCount + verifyDiffCount,
    },
    series,
    activeAccountSeries: dailyStorageSeries,
    breakdowns: {
      migrations: migrationBreakdown,
      accounts: accountBreakdown,
      workers: workerBreakdown,
      repairs: repairBreakdown,
      bucketStats: bucketSyncBreakdown,
    },
    topBuckets,
    attentionItems,
    syncHealth: {
      partial: warnings.length > 0,
      warnings,
      staleBucketStats,
      bucketStatsUpdatedAt: Number.isFinite(newestBucketStat) ? new Date(newestBucketStat).toISOString() : null,
      unsyncedAccounts: accounts.filter((account) => !account.cloudflareAccountId).length,
      accountSyncErrors: accounts.filter((account) => account.syncStatus === "error").length,
      bucketStatsErrors: failedBucketStats,
    },
  }
}

function queueAnalyticsPayload(range: RangeKey): Promise<unknown> {
  const existing = analyticsInFlight.get(range)
  if (existing) return existing

  const promise = buildAnalyticsPayload(range)
    .then((payload) => {
      analyticsCache.set(range, {
        expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS,
        payload,
      })
      return payload
    })
    .finally(() => {
      analyticsInFlight.delete(range)
    })

  analyticsInFlight.set(range, promise)
  return promise
}

export async function GET(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const url = new URL(request.url)
    const range = asRange(url.searchParams.get("range"))
    const forceRefresh = url.searchParams.get("refresh") === "1"
    const cached = analyticsCache.get(range)

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return NextResponse.json(cached.payload)
    }

    const payload = await queueAnalyticsPayload(range)
    return NextResponse.json(payload)
  } catch (error: unknown) {
    console.error("[analytics] dashboard refresh failed", error)
    const message = error instanceof Error ? error.message : "Unable to read dashboard data"
    return NextResponse.json(
      { error: `Dashboard data is temporarily unavailable: ${message}` },
      { status: 503 }
    )
  }
}
