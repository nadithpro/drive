import { NextResponse } from "next/server"

import { ensureDriveSchema, queryDb } from "@/lib/db"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type PoolResult = Awaited<ReturnType<typeof readPool>>
const responseCache = new Map<string, { expiresAt: number; promise: Promise<PoolResult> }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function hasCompleteSnapshot(snapshot: Record<string, unknown>) {
  return Array.isArray(snapshot.buckets) && Number.isFinite(Number(snapshot.totalJobs))
}

async function readPool(id: string, pageIndex: number, pageSize: number, selectedGeneration: number) {
  await ensureDriveSchema()
  const { rows } = await queryDb<{
    snapshot: Record<string, unknown> | null
    snapshot_updated_at: string | null
    online_workers: string | number
    active_transfers: string | number
    total_jobs: string | number
    queued_jobs: string | number
    running_jobs: string | number
    remaining_jobs: string | number
    completed_jobs: string | number
    failed_jobs: string | number
    transferred_objects: string | number
    failed_objects: string | number
    skipped_objects: string | number
    canceled_jobs: string | number
    jobs: Array<Record<string, unknown>> | null
    live_files: Array<Record<string, unknown>> | null
    job_page: Array<Record<string, unknown>> | null
    job_total: string | number
    attempts: Array<Record<string, unknown>> | null
    worker_runs: Array<Record<string, unknown>> | null
    selected_generation: string | number
    migration_status: string
    buckets: Array<Record<string, unknown>> | null
    historical_buckets: Array<Record<string, unknown>> | null
    current_generation: string | number
  }>(`
    with state as materialized (
      select snapshot,updated_at
      from public.drive_migration_worker_live_state
      where migration_id=$1
      limit 1
    ), migration_meta as materialized (
      select status,greatest(1,coalesce(nullif(options->>'workerGeneration','')::int,1)) generation
      from public.drive_migrations where id=$1 limit 1
    ), selected_generation as materialized (
      select case when $4::int>0 then $4::int else generation end generation
      from migration_meta
    ), fallback_needed as materialized (
      select not exists(
        select 1 from state
        where jsonb_typeof(snapshot->'buckets')='array'
          and jsonb_typeof(snapshot->'totalJobs')='number'
      ) needs_legacy
    ), job_counts as (
      select count(*)::bigint total_jobs,
        count(*) filter(where status='pending')::bigint queued_jobs,
        count(*) filter(where status in('claimed','running'))::bigint running_jobs,
        count(*) filter(where status in('pending','claimed','running') or (status='failed' and case when result->>'retryCount' ~ '^[0-9]+$' then (result->>'retryCount')::int else 0 end<3))::bigint remaining_jobs,
        count(*) filter(where status='completed')::bigint completed_jobs,
        count(*) filter(where status='failed')::bigint failed_jobs,
        coalesce(sum(case when status='completed' then case when (result->'items'->0->>'transferred') ~ '^[0-9]+$' then (result->'items'->0->>'transferred')::bigint else 0 end when status in('claimed','running') then greatest(case when (result->'items'->0->>'transferred') ~ '^[0-9]+$' then (result->'items'->0->>'transferred')::bigint else 0 end,case when (progress->>'transferred') ~ '^[0-9]+$' then (progress->>'transferred')::bigint else 0 end) else 0 end),0)::bigint transferred_objects,
        coalesce(sum(case when (result->'items'->0->>'failed') ~ '^[0-9]+$' then (result->'items'->0->>'failed')::bigint when status='failed' and jsonb_typeof(result->'items')<>'array' then 1 else 0 end),0)::bigint failed_objects,
        coalesce(sum(case when (result->'items'->0->>'skipped') ~ '^[0-9]+$' then (result->'items'->0->>'skipped')::bigint else 0 end),0)::bigint skipped_objects,
        count(*) filter(where status='canceled')::bigint canceled_jobs
      from public.drive_repair_jobs
      where migration_id=$1 and mode='migration'
        and (select needs_legacy from fallback_needed)
    ), all_job_count as materialized (
      select count(*)::bigint job_total
      from public.drive_repair_jobs
      where migration_id=$1 and mode='migration'
        and greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))=(select generation from selected_generation)
    ), paged_jobs as materialized (
      select j.id,j.status,j.claimed_by_agent_id,j.summary,j.error,
        j.created_at,j.updated_at,j.last_heartbeat_at,j.completed_at,
        coalesce(j.payload->'inventoryObjects'->0->>'key','') object_key,
        case when j.payload->'inventoryObjects'->0->>'size' ~ '^[0-9]+$'
          then (j.payload->'inventoryObjects'->0->>'size')::bigint else 0 end object_size,
        coalesce(i.source_bucket,'') source_bucket,
        coalesce(i.target_bucket,'') target_bucket,
        case when j.status='completed' and j.result->'items'->0->>'transferred' ~ '^[0-9]+$' then (j.result->'items'->0->>'transferred')::bigint when j.status in('claimed','running') then greatest(case when j.result->'items'->0->>'transferred' ~ '^[0-9]+$' then (j.result->'items'->0->>'transferred')::bigint else 0 end,case when j.progress->>'transferred' ~ '^[0-9]+$' then (j.progress->>'transferred')::bigint else 0 end) else 0 end transferred,
        case when j.result->'items'->0->>'skipped' ~ '^[0-9]+$' then (j.result->'items'->0->>'skipped')::bigint else 0 end skipped,
        case when j.result->'items'->0->>'failed' ~ '^[0-9]+$' then (j.result->'items'->0->>'failed')::bigint else 0 end failed
      from public.drive_repair_jobs j
      left join public.drive_migration_items i
        on i.id::text=j.payload->'itemIds'->>0 and i.migration_id=j.migration_id
      where j.migration_id=$1 and j.mode='migration'
        and greatest(1,coalesce(nullif(j.payload->>'workerGeneration','')::int,1))=(select generation from selected_generation)
      order by j.created_at desc,j.id desc
      limit $2 offset $3
    ), job_page_projection as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'status',status,'claimedByAgentId',claimed_by_agent_id,
        'summary',summary,'error',error,'createdAt',created_at,'updatedAt',updated_at,
        'lastHeartbeatAt',last_heartbeat_at,'completedAt',completed_at,
        'objectKey',object_key,'objectSize',object_size,
        'sourceBucket',source_bucket,'targetBucket',target_bucket,
        'transferred',transferred,'skipped',skipped,'failed',failed
      ) order by created_at desc,id desc),'[]'::jsonb) job_page
      from paged_jobs
    ), live_file_projection as (
      select coalesce(jsonb_agg(j.progress->'currentFile' || jsonb_build_object(
        'jobId',j.id,'workerId',j.claimed_by_agent_id,'lastHeartbeatAt',j.last_heartbeat_at,'operation',j.mode
      ) order by j.updated_at desc,j.id),'[]'::jsonb) live_files
      from public.drive_repair_jobs j
      where j.migration_id=$1 and j.mode='migration' and j.status in('claimed','running')
        and j.claimed_by_agent_id is not null
        and j.last_heartbeat_at>now()-interval '90 seconds'
        and greatest(1,coalesce(nullif(j.payload->>'workerGeneration','')::int,1))=(select generation from selected_generation)
        and (select generation from selected_generation)=(select generation from migration_meta)
        and (select status from migration_meta) in('running','verifying')
        and jsonb_typeof(j.progress->'currentFile')='object'
        and nullif(j.progress->'currentFile'->>'key','') is not null
        and j.progress->'currentFile'->>'status' in('copying','transferring','running')
        and j.progress->>'active' is distinct from 'false'
    ), recent_jobs as materialized (
      select id,claimed_by_agent_id,status,mode,progress,result,created_at
      from public.drive_repair_jobs
      where migration_id=$1 and mode='migration'
        and greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))=(select generation from selected_generation)
      order by created_at desc,id desc
      limit 20
    ), telemetry as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,
        'claimed_by_agent_id',claimed_by_agent_id,
        'mode',mode,
        'status',status,
        'progress',jsonb_build_object(
          'fileEvents',coalesce((
            select jsonb_agg(event.value order by event.ordinality)
            from (
              select value,ordinality
              from jsonb_array_elements(case when jsonb_typeof(progress->'fileEvents')='array' then progress->'fileEvents' else '[]'::jsonb end) with ordinality
              order by ordinality desc limit 3
            ) event
          ),'[]'::jsonb),
          'logs',coalesce((
            select jsonb_agg(entry.value order by entry.ordinality)
            from (
              select value,ordinality
              from jsonb_array_elements(case when jsonb_typeof(progress->'logs')='array' then progress->'logs' else '[]'::jsonb end) with ordinality
              order by ordinality desc limit 3
            ) entry
          ),'[]'::jsonb)
        ),
        'result',jsonb_build_object('fileEvents',coalesce((
          select jsonb_agg(event.value order by event.ordinality)
          from (
            select value,ordinality
            from jsonb_array_elements(case when jsonb_typeof(result->'fileEvents')='array' then result->'fileEvents' else '[]'::jsonb end) with ordinality
            order by ordinality desc limit 3
          ) event
        ),'[]'::jsonb))
      ) order by created_at desc,id desc),'[]'::jsonb) jobs
      from recent_jobs
    ), attempt_generations as materialized (
      select generation from migration_meta
      union
      select greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))
      from public.drive_agent_runs where run_type='github_dispatch' and payload->>'migrationId'=($1::uuid)::text
      union
      select greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))
      from public.drive_repair_jobs where migration_id=$1 and mode='migration'
    ), attempt_projection as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'generation',summary.generation,'status',summary.status,
        'workerCount',summary.worker_count,'runningWorkers',summary.running_workers,
        'onlineWorkers',summary.online_workers,'totalJobs',summary.total_jobs,
        'queuedJobs',summary.queued_jobs,'runningJobs',summary.running_jobs,'remainingJobs',summary.remaining_jobs,
        'completedJobs',summary.completed_jobs,'failedJobs',summary.failed_jobs,
        'canceledJobs',summary.canceled_jobs,'createdAt',summary.created_at,'updatedAt',summary.updated_at
      ) order by summary.generation desc),'[]'::jsonb) attempts
      from (
        select generation.generation,
          case
            when generation.generation=(select generation from migration_meta)
              and (select status from migration_meta) in('canceled','aborted')
              and coalesce(runs.online_workers,0)=0 then 'aborted'
            when coalesce(runs.running_workers,0)>0 then 'running'
            when coalesce(runs.pending_workers,0)>0 then 'deploying'
            when coalesce(jobs.running_jobs,0)>0 then 'running'
            when coalesce(jobs.queued_jobs,0)>0 then 'queued'
            when coalesce(runs.canceled_workers,0)>0 or coalesce(jobs.canceled_jobs,0)>0 then 'aborted'
            when coalesce(runs.failed_workers,0)>0 or coalesce(jobs.failed_jobs,0)>0 then 'failed'
            when coalesce(jobs.completed_jobs,0)>0 or coalesce(runs.completed_workers,0)>0 then 'completed'
            else 'queued'
          end status,
          coalesce(runs.worker_count,0) worker_count,coalesce(runs.running_workers,0) running_workers,
          coalesce(runs.online_workers,0) online_workers,coalesce(jobs.total_jobs,0) total_jobs,
          coalesce(jobs.queued_jobs,0) queued_jobs,coalesce(jobs.running_jobs,0) running_jobs,
          coalesce(jobs.remaining_jobs,0) remaining_jobs,
          coalesce(jobs.completed_jobs,0) completed_jobs,coalesce(jobs.failed_jobs,0) failed_jobs,
          coalesce(jobs.canceled_jobs,0) canceled_jobs,
          least(runs.created_at,jobs.created_at) created_at,
          greatest(runs.updated_at,jobs.updated_at) updated_at
        from attempt_generations generation
        left join lateral (
          select count(*)::bigint worker_count,
            count(*) filter(where r.status='pending')::bigint pending_workers,
            count(*) filter(where r.status='running')::bigint running_workers,
            count(*) filter(where r.status='completed')::bigint completed_workers,
            count(*) filter(where r.status='failed')::bigint failed_workers,
            count(*) filter(where r.status='canceled')::bigint canceled_workers,
            count(*) filter(where r.status='running' and (
              (r.payload->>'workerInstanceId' is not null and coalesce(nullif(r.payload->>'workerHeartbeatAt','')::timestamptz,'-infinity'::timestamptz)>now()-interval '90 seconds')
              or (r.payload->>'workerInstanceId' is null and a.status='online' and a.last_heartbeat_at>now()-interval '90 seconds')
            ))::bigint online_workers,
            min(r.created_at) created_at,max(r.updated_at) updated_at
          from public.drive_agent_runs r left join public.drive_agents a on a.id=r.agent_id
          where r.run_type='github_dispatch' and r.payload->>'migrationId'=($1::uuid)::text
            and greatest(1,coalesce(nullif(r.payload->>'workerGeneration','')::int,1))=generation.generation
        ) runs on true
        left join lateral (
          select count(*)::bigint total_jobs,
            count(*) filter(where status='pending')::bigint queued_jobs,
            count(*) filter(where status in('claimed','running'))::bigint running_jobs,
            count(*) filter(where status in('pending','claimed','running') or (status='failed' and case when result->>'retryCount' ~ '^[0-9]+$' then (result->>'retryCount')::int else 0 end<3))::bigint remaining_jobs,
            count(*) filter(where status='completed')::bigint completed_jobs,
            count(*) filter(where status='failed')::bigint failed_jobs,
            count(*) filter(where status='canceled')::bigint canceled_jobs,
            min(created_at) created_at,max(updated_at) updated_at
          from public.drive_repair_jobs
          where migration_id=$1 and mode='migration'
            and greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))=generation.generation
        ) jobs on true
      ) summary
    ), selected_worker_runs as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',run.id,'agentId',run.agent_id,'status',case
          when (select status from migration_meta) in('canceled','aborted')
            and run.payload->>'githubAbortRequestedAt' is not null
            and not (run.status='running' and (
              (run.payload->>'workerInstanceId' is not null and coalesce(nullif(run.payload->>'workerHeartbeatAt','')::timestamptz,'-infinity'::timestamptz)>now()-interval '90 seconds')
              or (run.payload->>'workerInstanceId' is null and run.agent_status='online' and run.agent_heartbeat>now()-interval '90 seconds')
            ))
          then 'canceled' else run.status end,
        'online',run.status='running' and (
          (run.payload->>'workerInstanceId' is not null and coalesce(nullif(run.payload->>'workerHeartbeatAt','')::timestamptz,'-infinity'::timestamptz)>now()-interval '90 seconds')
          or (run.payload->>'workerInstanceId' is null and run.agent_status='online' and run.agent_heartbeat>now()-interval '90 seconds')
        ),
        'abortRequested',(run.payload->>'githubAbortRequestedAt') is not null,
        'externalRunId',run.external_run_id,'instanceId',run.payload->>'workerInstanceId',
        'jobId',run.job_reference,'currentStatus',job.status,'lastHeartbeatAt',job.last_heartbeat_at,
        'completedFiles',coalesce((run.payload->>'completedFiles')::bigint,0),
        'failedFiles',coalesce((run.payload->>'failedFiles')::bigint,0),
        'completedBytes',coalesce((run.payload->>'completedBytes')::bigint,0),
        'createdAt',run.created_at,'updatedAt',run.updated_at
      ) order by run.created_at asc),'[]'::jsonb) worker_runs
      from (
        select r.*,a.status agent_status,a.last_heartbeat_at agent_heartbeat
        from public.drive_agent_runs r left join public.drive_agents a on a.id=r.agent_id
        where r.run_type='github_dispatch' and r.payload->>'migrationId'=($1::uuid)::text
          and greatest(1,coalesce(nullif(r.payload->>'workerGeneration','')::int,1))=(select generation from selected_generation)
        order by r.created_at asc limit 100
      ) run left join public.drive_repair_jobs job on job.id::text=run.job_reference
    ), bucket_projection as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',item.id,
        'sourceBucket',item.source_bucket,
        'targetBucket',item.target_bucket,
        'status',coalesce(nullif(item.progress->'live'->>'status',''),item.slurper_status,'pending'),
        'totalObjects',case when item.progress->'live'->>'totalObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'totalObjects')::numeric else coalesce(item.source_objects,0) end,
        'queuedObjects',case when item.progress->'live'->>'queuedObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'queuedObjects')::numeric else 0 end,
        'transferredObjects',case when item.progress->'live'->>'transferredObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'transferredObjects')::numeric else 0 end,
        'failedObjects',case when item.progress->'live'->>'failedObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'failedObjects')::numeric else 0 end,
        'skippedObjects',case when item.progress->'live'->>'skippedObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'skippedObjects')::numeric else 0 end,
        'transferredBytes',case when item.progress->'live'->>'transferredBytes' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'transferredBytes')::numeric else 0 end,
        'sourceBytes',coalesce(item.source_bytes,0),
        'updatedAt',item.updated_at
      ) order by item.source_bucket,item.id),'[]'::jsonb) buckets
      from public.drive_migration_items item
      where item.migration_id=$1 and (select needs_legacy from fallback_needed)
    ), historical_bucket_projection as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',i.id,'sourceBucket',i.source_bucket,'targetBucket',i.target_bucket,
        'totalObjects',coalesce(j.total_jobs,0),
        'queuedObjects',coalesce(j.queued_jobs,0),
        'transferredObjects',coalesce(j.transferred_objects,0),
        'failedObjects',coalesce(j.failed_objects,0),
        'skippedObjects',coalesce(j.skipped_objects,0),
        'transferredBytes',coalesce(j.transferred_bytes,0),
        'sourceBytes',coalesce(j.source_bytes,0),
        'status',case when coalesce(j.running_jobs,0)>0 then 'running'
          when coalesce(j.queued_jobs,0)>0 then 'queued'
          when coalesce(j.failed_jobs,0)>0 then 'failed'
          when coalesce(j.canceled_jobs,0)>0 then 'aborted'
          when coalesce(j.total_jobs,0)>0 then 'completed' else coalesce(i.slurper_status,'queued') end,
        'updatedAt',coalesce(j.updated_at,i.updated_at)
      ) order by i.source_bucket,i.id),'[]'::jsonb) buckets
      from public.drive_migration_items i
      left join lateral (
        select count(*)::bigint total_jobs,
          count(*) filter(where status='pending')::bigint queued_jobs,
          count(*) filter(where status in('claimed','running'))::bigint running_jobs,
          count(*) filter(where status='failed')::bigint failed_jobs,
          count(*) filter(where status='canceled')::bigint canceled_jobs,
          coalesce(sum(case when status='completed' and (result->'items'->0->>'transferred') ~ '^[0-9]+$'
            then greatest(0,(result->'items'->0->>'transferred')::bigint-coalesce(nullif(result->'items'->0->>'skipped','')::bigint,0)) else 0 end),0)::bigint transferred_objects,
          coalesce(sum(case when (result->'items'->0->>'skipped') ~ '^[0-9]+$' then (result->'items'->0->>'skipped')::bigint else 0 end),0)::bigint skipped_objects,
          coalesce(sum(case when (result->'items'->0->>'failed') ~ '^[0-9]+$' then (result->'items'->0->>'failed')::bigint else 0 end),0)::bigint failed_objects,
          coalesce(sum(case when status='completed' and (result->'items'->0->>'transferred') ~ '^[0-9]+$'
            and (result->'items'->0->>'transferred')::bigint>0 then case when payload->'inventoryObjects'->0->>'size' ~ '^[0-9]+$' then (payload->'inventoryObjects'->0->>'size')::bigint else 0 end else 0 end),0)::bigint transferred_bytes,
          coalesce(sum(case when payload->'inventoryObjects'->0->>'size' ~ '^[0-9]+$' then (payload->'inventoryObjects'->0->>'size')::bigint else 0 end),0)::bigint source_bytes,
          max(updated_at) updated_at
        from public.drive_repair_jobs j
        where j.migration_id=i.migration_id and j.mode='migration'
          and j.payload->'itemIds'->>0=i.id::text
          and greatest(1,coalesce(nullif(j.payload->>'workerGeneration','')::int,1))=(select generation from selected_generation)
      ) j on true
      where i.migration_id=$1
    ), worker_counts as (
      select count(*) filter(where r.status='running' and (
          (r.payload->>'workerInstanceId' is not null and coalesce(nullif(r.payload->>'workerHeartbeatAt','')::timestamptz,'-infinity'::timestamptz)>now()-interval '90 seconds')
          or (r.payload->>'workerInstanceId' is null and a.status='online' and a.last_heartbeat_at>now()-interval '90 seconds')
        ))::bigint online_workers,
        count(*) filter(where r.status='running' and j.progress ? 'currentFile'
          and ((r.payload->>'workerInstanceId' is not null and coalesce(nullif(r.payload->>'workerHeartbeatAt','')::timestamptz,'-infinity'::timestamptz)>now()-interval '90 seconds')
            or (r.payload->>'workerInstanceId' is null and a.status='online' and a.last_heartbeat_at>now()-interval '90 seconds')))::bigint active_transfers
      from public.drive_agent_runs r
      join public.drive_agents a on a.id=r.agent_id
      left join public.drive_repair_jobs j on j.id::text=r.job_reference
      where r.run_type='github_dispatch' and r.payload->>'migrationId'=($1::uuid)::text
        and greatest(1,coalesce(nullif(r.payload->>'workerGeneration','')::int,1))=(select generation from migration_meta)
    )
    select state.snapshot,state.updated_at snapshot_updated_at,
      worker_counts.online_workers,worker_counts.active_transfers,
      job_counts.total_jobs,job_counts.queued_jobs,job_counts.running_jobs,
      job_counts.completed_jobs,job_counts.failed_jobs,job_counts.transferred_objects,job_counts.failed_objects,job_counts.canceled_jobs,
      telemetry.jobs,live_file_projection.live_files,job_page_projection.job_page,all_job_count.job_total,
      attempt_projection.attempts,selected_worker_runs.worker_runs,selected_generation.generation selected_generation,
      migration_meta.status migration_status,bucket_projection.buckets,
      historical_bucket_projection.buckets historical_buckets,migration_meta.generation current_generation
    from job_counts cross join worker_counts cross join telemetry cross join live_file_projection cross join job_page_projection cross join all_job_count
      cross join attempt_projection cross join selected_worker_runs cross join selected_generation cross join migration_meta cross join bucket_projection cross join historical_bucket_projection
    left join state on true
  `, [id, pageSize, pageIndex * pageSize, selectedGeneration])
  const stateRow = rows[0]
  if (!stateRow) throw new Error("Migration worker pool query returned no row")
  const saved = stateRow.snapshot ?? {}
  const allJobs = stateRow.jobs ?? []
  const liveFiles = stateRow.live_files ?? []
  const jobPage = stateRow.job_page ?? []
  const attempts = stateRow.attempts ?? []
  const workerRuns = stateRow.worker_runs ?? []
  const resolvedGeneration = Number(stateRow.selected_generation || 1)
  const currentGeneration = Number(stateRow.current_generation || 1)
  const migrationStatus = String(stateRow.migration_status || "")
  const jobTotal = Number(stateRow.job_total || 0)
  const jobPagination = {
    pageIndex,
    pageSize,
    pageCount: Math.max(1, Math.ceil(jobTotal / pageSize)),
    total: jobTotal,
  }
  const liveCounts = {
    onlineWorkers: Number(stateRow.online_workers || 0),
    activeTransfers: Number(stateRow.active_transfers || 0),
  }
  const normalizeTerminalBuckets = (snapshot: Record<string, unknown>) => {
    if (!["canceled", "cancelled", "aborted"].includes(migrationStatus.toLowerCase()) || !Array.isArray(snapshot.buckets)) return snapshot
    return { ...snapshot, buckets: snapshot.buckets.map((bucket) => isRecord(bucket) ? { ...bucket, status: "aborted", queuedObjects: 0 } : bucket) }
  }
  if (hasCompleteSnapshot(saved) && resolvedGeneration === currentGeneration) {
    return { snapshot: normalizeTerminalBuckets({ ...saved, ...liveCounts }), snapshotUpdatedAt: stateRow.snapshot_updated_at, jobs: allJobs, liveFiles, jobPage, jobPagination, attempts, workerRuns, selectedGeneration: resolvedGeneration, migrationStatus }
  }

  if (resolvedGeneration !== currentGeneration) {
    const attempt = attempts.find((row) => Number(row.generation) === resolvedGeneration) ?? {}
    const buckets = stateRow.historical_buckets ?? []
    const snapshot = {
      migrationId: id,
      workerGeneration: resolvedGeneration,
      totalJobs: Number(attempt.totalJobs || 0),
      queuedJobs: Number(attempt.queuedJobs || 0),
      runningJobs: Number(attempt.runningJobs || 0),
      remainingJobs: Number(attempt.remainingJobs || 0),
      completedJobs: Number(attempt.completedJobs || 0),
      failedJobs: Number(attempt.failedJobs || 0),
      canceledJobs: Number(attempt.canceledJobs || 0),
      totalObjects: buckets.reduce((sum, bucket) => sum + Number(bucket.totalObjects || 0), 0),
      transferred: buckets.reduce((sum, bucket) => sum + Number(bucket.transferredObjects || 0), 0),
      skipped: buckets.reduce((sum, bucket) => sum + Number(bucket.skippedObjects || 0), 0),
      failed: buckets.reduce((sum, bucket) => sum + Number(bucket.failedObjects || 0), 0),
      onlineWorkers: Number(attempt.onlineWorkers || 0),
      activeTransfers: 0,
      buckets,
      updatedAt: attempt.updatedAt ?? stateRow.snapshot_updated_at,
    }
    return { snapshot: normalizeTerminalBuckets(snapshot), snapshotUpdatedAt: stateRow.snapshot_updated_at, jobs: allJobs, liveFiles, jobPage, jobPagination, attempts, workerRuns, selectedGeneration: resolvedGeneration, migrationStatus }
  }

  // Legacy migrations may not have an orchestrator snapshot yet. This narrow
  // bucket projection is built in the same round trip as the live queue data.
  const buckets = stateRow.buckets ?? []
  const snapshot = {
    ...saved,
    totalJobs: Number(stateRow.total_jobs || 0),
    queuedJobs: Number(stateRow.queued_jobs || 0),
    runningJobs: Number(stateRow.running_jobs || 0),
    remainingJobs: Number(stateRow.remaining_jobs || 0),
    completedJobs: Number(stateRow.completed_jobs || 0),
    failedJobs: Number(stateRow.failed_jobs || 0),
    transferred: Number(stateRow.transferred_objects || 0),
    failed: Number(stateRow.failed_objects || 0),
    skipped: Number(stateRow.skipped_objects || 0),
    canceledJobs: Number(stateRow.canceled_jobs || 0),
    totalObjects: buckets.reduce((sum, bucket) => sum + Number(bucket.totalObjects || 0), 0),
    ...liveCounts,
    buckets,
  }
  return { snapshot: normalizeTerminalBuckets(snapshot), snapshotUpdatedAt: stateRow.snapshot_updated_at, jobs: allJobs, liveFiles, jobPage, jobPagination, attempts, workerRuns, selectedGeneration: resolvedGeneration, migrationStatus }
}

function cachedPool(id: string, pageIndex: number, pageSize: number, selectedGeneration: number) {
  const now = Date.now()
  const key = `${id}:${pageIndex}:${pageSize}:${selectedGeneration}`
  const current = responseCache.get(key)
  if (current && current.expiresAt > now) return current.promise
  const promise = readPool(id, pageIndex, pageSize, selectedGeneration).catch((error) => {
    responseCache.delete(key)
    throw error
  })
  responseCache.set(key, { expiresAt: now + 3_000, promise })
  if (responseCache.size > 100) {
    for (const [key, entry] of responseCache) if (entry.expiresAt <= now) responseCache.delete(key)
  }
  return promise
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { id } = await context.params
    const url = new URL(request.url)
    const pageIndex = Math.max(0, Math.floor(Number(url.searchParams.get("page") || 0) || 0))
    const pageSize = Math.max(10, Math.min(100, Math.floor(Number(url.searchParams.get("pageSize") || 25) || 25)))
    const selectedGeneration = Math.max(0, Math.floor(Number(url.searchParams.get("generation") || 0) || 0))
    const saved = await cachedPool(id, pageIndex, pageSize, selectedGeneration)
    return NextResponse.json({ ...saved, source: "database" }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0", "X-Drive-Worker-Failure": "1" } }
    )
  }
}
