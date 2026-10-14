import { NextResponse } from "next/server"
import { authenticateMigrationOrchestrator } from "@/lib/migration-orchestrator-auth"
import { queryDb } from "@/lib/db"
import { getMigrationWorkerSettings } from "@/lib/migration-worker-settings-store"
import { ensureMigrationQueueSchema, withMigrationQueueDatabase } from "@/lib/migration-queue-database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// SQL rows are dynamically shaped across the primary and queue databases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

async function seedQueue(db: import("pg").Client, migrationId: string, generation: number, limit: number) {
  // A retry creates a new fenced generation. Stop old queue rows before
  // publishing the new one so an old GitHub runner cannot keep processing it.
  await db.query(`update drive_migration_queue_meta set status='superseded',updated_at=now()
    where migration_id=$1 and generation<$2 and status not in('completed','failed','canceled','aborted','superseded')`, [migrationId, generation])
  await db.query(`update drive_migration_queue_jobs set status='canceled',completed_at=coalesce(completed_at,now()),
    lease_expires_at=null,updated_at=now() where migration_id=$1 and generation<$2 and status not in('completed','failed','canceled')`, [migrationId, generation])
  await db.query(`insert into drive_migration_queue_meta(migration_id,generation,status) values($1,$2,'seeding') on conflict(migration_id,generation) do nothing`, [migrationId, generation])
  const meta = (await db.query(`select seed_cursor,seed_complete from drive_migration_queue_meta where migration_id=$1 and generation=$2 for update`, [migrationId, generation])).rows[0]
  let cursorAt: string | null = null
  let cursorId: string | null = null
  if (meta.seed_cursor) {
    const split = String(meta.seed_cursor).split("|")
    cursorAt = split[0] || null
    cursorId = split[1] || null
  }
  if (meta.seed_complete) {
    const lateJobs = await queryDb<Row>(`select exists(select 1 from drive_repair_jobs j
      where j.migration_id=$1 and j.mode='migration'
        and greatest(1,coalesce(nullif(j.payload->>'workerGeneration','')::int,1))=$2
        and ($3::timestamptz is null or (j.created_at,j.id)>($3::timestamptz,$4::uuid))) has_late_jobs`,
    [migrationId, generation, cursorAt, cursorId])
    if (!lateJobs.rows[0]?.has_late_jobs) return { inserted: 0, complete: true }
    await db.query(`update drive_migration_queue_meta set seed_complete=false,status='seeding',updated_at=now()
      where migration_id=$1 and generation=$2`, [migrationId, generation])
  }
  const { rows } = await queryDb<Row>(`
    select j.id,j.migration_id,j.status,j.mode,j.work_key,j.payload job_payload,j.progress,j.result,j.summary,j.error,j.claimed_by_agent_id,j.claim_token,j.created_at,j.created_at::text seed_created_at,j.updated_at,
      m.options,m.source_account_id,m.target_account_id,
      s.cloudflare_account_id source_account,s.r2_access_key_id source_key,s.r2_secret_access_key source_secret,
      t.cloudflare_account_id target_account,t.r2_access_key_id target_key,t.r2_secret_access_key target_secret,
      i.items job_items
    from drive_repair_jobs j join drive_migrations m on m.id=j.migration_id
    join drive_accounts s on s.id=m.source_account_id join drive_accounts t on t.id=m.target_account_id
    left join lateral (
      select jsonb_agg(jsonb_build_object('id',i.id,'sourceBucket',i.source_bucket,'targetBucket',i.target_bucket,
        'sourceObjects',i.source_objects,'sourceBytes',i.source_bytes,'slurperStatus',i.slurper_status,'progress',i.progress)
        order by i.created_at,i.id) items
      from jsonb_array_elements_text(coalesce(j.payload->'itemIds','[]'::jsonb)) item_ref(item_id)
      join drive_migration_items i on i.id::text=item_ref.item_id and i.migration_id=j.migration_id
    ) i on true
    where j.migration_id=$1 and j.mode='migration'
      and greatest(1,coalesce(nullif(j.payload->>'workerGeneration','')::int,1))=$2
      and ($3::timestamptz is null or (j.created_at,j.id)>($3::timestamptz,$4::uuid))
    order by j.created_at,j.id limit $5
  `, [migrationId, generation, cursorAt, cursorId, limit + 1])
  const page = rows.slice(0, limit)
  if (!page.length) {
    await db.query(`update drive_migration_queue_meta set seed_complete=true,status='ready',updated_at=now() where migration_id=$1 and generation=$2`, [migrationId, generation])
    return { inserted: 0, complete: true }
  }
  const first = page[0]
  if (!first.source_account || !first.target_account || !first.source_key || !first.source_secret || !first.target_key || !first.target_secret) throw new Error(`Migration ${migrationId} has incomplete R2 credentials; queue seeding stopped before dispatch`)
  const existing = await db.query(`select count(*)::int count from drive_migration_queue_jobs where migration_id=$1 and generation=$2 and id=any($3::uuid[])`, [migrationId, generation, page.map((row) => row.id)])
  const inserted = Math.max(0, page.length - Number(existing.rows[0]?.count || 0))
  await db.query(`update drive_migration_queue_meta set execution_config=coalesce(execution_config,$3::jsonb),updated_at=now() where migration_id=$1 and generation=$2`, [migrationId, generation, JSON.stringify({
    migration: { id: migrationId, options: first.options || {}, pathPrefix: (first.options || {}).pathPrefix || null },
    source: { accountId: first.source_account, accessKeyId: first.source_key, secretAccessKey: first.source_secret },
    target: { accountId: first.target_account, accessKeyId: first.target_key, secretAccessKey: first.target_secret },
  })])
  try {
    for (const row of page) {
      if (!row.source_account || !row.target_account || !row.source_key || !row.source_secret || !row.target_key || !row.target_secret) throw new Error(`Migration ${migrationId} has incomplete R2 credentials; queue seeding stopped before dispatch`)
      const executionPayload = {
        job: { id: row.id, mode: "migration", migrationId, verifyAllBuckets: true, strictCompletion: true, kind: row.job_payload?.kind, progress: row.progress || {} },
        ...(row.job_payload?.workerShard ? { workerShard: row.job_payload.workerShard } : {}),
        ...(typeof row.job_payload?.workerGeneration === "number" ? { workerGeneration: row.job_payload.workerGeneration } : {}),
        ...(Array.isArray(row.job_payload?.inventoryObjects) ? { inventoryObjects: row.job_payload.inventoryObjects } : {}),
        items: Array.isArray(row.job_items) ? row.job_items : [],
      }
      await db.query(`insert into drive_migration_queue_jobs(id,migration_id,generation,status,payload,progress,result,summary,error,agent_id,claim_token,attempts,created_at,updated_at)
        values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
        on conflict(id) do update set payload=excluded.payload where drive_migration_queue_jobs.status='pending'`,
        [row.id, migrationId, generation, row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "pending", JSON.stringify(executionPayload), JSON.stringify(row.progress || {}), JSON.stringify(row.result || {}), row.summary, row.error, row.claimed_by_agent_id, row.claim_token, 0, row.created_at, row.updated_at])
    }
    const last = page[page.length - 1]
    const complete = rows.length <= limit
    await db.query(`update drive_migration_queue_meta set seed_cursor=$3,seed_complete=$4,status=case when $4 then 'ready' else 'seeding' end,
      total_jobs=(select count(*) from drive_migration_queue_jobs where migration_id=$1 and generation=$2),updated_at=now()
      where migration_id=$1 and generation=$2`, [migrationId, generation, `${last.seed_created_at}|${last.id}`, complete])
    return { inserted, complete }
  } catch (error) { throw error }
}

async function syncQueue(db: import("pg").Client, migrationId: string, generation: number, limit: number) {
  await queryDb(`update drive_repair_jobs j set status='canceled',updated_at=now(),completed_at=coalesce(j.completed_at,now())
    from drive_migrations m where j.migration_id=$1 and m.id=j.migration_id and m.status in('canceled','aborted','failed','verification_failed') and j.mode='migration' and j.status not in('completed','failed','canceled')`, [migrationId])
  const { rows: main } = await queryDb<Row>(`select status,greatest(1,coalesce(nullif(options->>'workerGeneration','')::int,1)) generation from drive_migrations where id=$1`, [migrationId])
  const canceled = await queryDb<Row>(`select id from drive_repair_jobs where migration_id=$1 and mode='migration' and status='canceled' and greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))=$2`, [migrationId, generation])
  for (let offset = 0; offset < canceled.rows.length; offset += 250) {
    await db.query(`update drive_migration_queue_jobs set status='canceled',completed_at=coalesce(completed_at,now()),lease_expires_at=null,updated_at=now()
      where migration_id=$1 and generation=$2 and id=any($3::uuid[]) and status not in('completed','failed','canceled')`, [migrationId, generation, canceled.rows.slice(offset, offset + 250).map((row) => row.id)])
  }
  const recovered = await queryDb<Row>(`select id,progress,result from drive_repair_jobs where migration_id=$1 and mode='migration' and status='pending'
    and greatest(1,coalesce(nullif(payload->>'workerGeneration','')::int,1))=$2
    and case when result->>'retryCount' ~ '^[0-9]+$' then (result->>'retryCount')::int else 0 end>0`, [migrationId, generation])
  for (let offset = 0; offset < recovered.rows.length; offset += 250) {
    const page = recovered.rows.slice(offset, offset + 250)
    await db.query(`update drive_migration_queue_jobs q set status='pending',claimed_by=null,agent_id=null,claim_token=null,lease_expires_at=null,
      completed_at=null,progress=x.progress,result=x.result,error=null,updated_at=now()
      from jsonb_to_recordset($3::jsonb) as x(id uuid,progress jsonb,result jsonb)
      where q.id=x.id and q.migration_id=$1 and q.generation=$2 and q.status in('failed','running')
        and (q.status='failed' or q.lease_expires_at<now())
        and case when q.result->>'retryCount' ~ '^[0-9]+$' then (q.result->>'retryCount')::int else 0 end < case when x.result->>'retryCount' ~ '^[0-9]+$' then (x.result->>'retryCount')::int else 0 end`,
      [migrationId, generation, JSON.stringify(page.map((row) => ({ ...row, progress: row.progress || {}, result: row.result || {} })))])
  }
  await db.query(`update drive_migration_queue_meta set status=$3,updated_at=now() where migration_id=$1 and generation=$2`, [migrationId, generation, main[0]?.status || "running"])
  const meta = (await db.query(`select sync_cursor from drive_migration_queue_meta where migration_id=$1 and generation=$2 for update`, [migrationId, generation])).rows[0]
  let cursorAt: string | null = null
  let cursorId: string | null = null
  if (meta?.sync_cursor) { const split = String(meta.sync_cursor).split("|"); cursorAt = split[0] || null; cursorId = split[1] || null }
  const result = await db.query(`select id,status,payload,progress,result,summary,error,agent_id,claim_token,attempts,last_heartbeat_at,completed_at,created_at,updated_at,updated_at::text sync_updated_at
    from drive_migration_queue_jobs where migration_id=$1 and generation=$2 and status in('completed','failed','canceled')
      and ($3::timestamptz is null or (updated_at,id)>($3::timestamptz,$4::uuid))
    order by updated_at,id limit $5`, [migrationId, generation, cursorAt, cursorId, limit])
  if (result.rowCount) {
    await queryDb(`update drive_repair_jobs j set status=x.status,progress=x.progress,result=x.result,summary=x.summary,error=x.error,
      claimed_by_agent_id=x.agent_id,claim_token=x.claim_token,last_heartbeat_at=x.last_heartbeat_at,
      completed_at=x.completed_at,updated_at=x.updated_at from jsonb_to_recordset($2::jsonb) as x(id uuid,status text,progress jsonb,result jsonb,summary text,error text,agent_id uuid,claim_token uuid,attempts int,last_heartbeat_at timestamptz,completed_at timestamptz,updated_at timestamptz)
      where j.id=x.id and j.migration_id=$1`, [migrationId, JSON.stringify(result.rows.map((row) => ({ ...row, progress: row.progress || {}, result: row.result || {} })))])
    const last = result.rows[result.rows.length - 1]
    await db.query(`update drive_migration_queue_meta set sync_cursor=$3,updated_at=now() where migration_id=$1 and generation=$2`, [migrationId, generation, `${last.sync_updated_at}|${last.id}`])
  }
  const { rows: workers } = await db.query(`select worker_instance_id,agent_id,status,current_job_id,last_heartbeat_at,metadata
    from drive_migration_queue_workers where migration_id=$1 and generation=$2`, [migrationId, generation])
  for (let offset = 0; offset < workers.length; offset += 250) {
    const batch = workers.slice(offset, offset + 250)
    const records = JSON.stringify(batch.filter((worker) => worker.agent_id).map((worker) => ({ ...worker,
      effective_status: worker.status === "online" && Date.now() - Date.parse(worker.last_heartbeat_at) < 90_000 ? "online" : "offline",
    })))
    if (records === "[]") continue
    await queryDb(`update drive_agents a set status=x.effective_status,last_heartbeat_at=x.last_heartbeat_at,
      last_seen_version='worker-v3-queue-db',metadata=coalesce(a.metadata,'{}'::jsonb)||jsonb_build_object(
        'queueWorkerInstanceId',x.worker_instance_id,'currentQueueJobId',x.current_job_id),updated_at=now()
      from jsonb_to_recordset($1::jsonb) as x(worker_instance_id text,agent_id uuid,status text,effective_status text,current_job_id uuid,last_heartbeat_at timestamptz)
      where a.id=x.agent_id`, [records])
    await queryDb(`update drive_agent_runs r set status=case when x.effective_status='online' then 'running' else 'completed' end,
      job_reference=coalesce(x.current_job_id::text,r.job_reference),summary=case when x.effective_status='online' then 'Worker heartbeat synchronized from migration queue database' else 'Worker retired or heartbeat expired in migration queue database' end,
      completed_at=case when x.effective_status='online' then null else coalesce(r.completed_at,x.last_heartbeat_at) end,
      payload=r.payload||jsonb_build_object('phase',case when x.effective_status='online' then 'working' else 'retired' end,'queueWorkerStatus',x.effective_status,'queueHeartbeatAt',x.last_heartbeat_at),
      updated_at=now() from jsonb_to_recordset($1::jsonb) as x(worker_instance_id text,agent_id uuid,status text,effective_status text,current_job_id uuid,last_heartbeat_at timestamptz)
      where r.agent_id=x.agent_id and r.payload->>'workerInstanceId'=x.worker_instance_id and r.status in('pending','running')`, [records])
  }
  const aggregate = (await db.query(`select count(*)::bigint total_jobs,
      count(*) filter(where status='pending')::bigint queued_jobs,
      count(*) filter(where status in('claimed','running'))::bigint running_jobs,
      count(*) filter(where status in('pending','claimed','running'))::bigint remaining_jobs,
      count(*) filter(where status='completed')::bigint completed_jobs,
      count(*) filter(where status='failed')::bigint failed_jobs,
      count(*) filter(where status='canceled')::bigint canceled_jobs,
      coalesce(sum(case when status='completed' then case when result->'items'->0->>'transferred' ~ '^[0-9]+$' then (result->'items'->0->>'transferred')::bigint else 0 end else greatest(case when result->'items'->0->>'transferred' ~ '^[0-9]+$' then (result->'items'->0->>'transferred')::bigint else 0 end,case when progress->>'transferred' ~ '^[0-9]+$' then (progress->>'transferred')::bigint else 0 end) end),0)::bigint transferred,
      coalesce(sum(case when result->'items'->0->>'skipped' ~ '^[0-9]+$' then (result->'items'->0->>'skipped')::bigint else 0 end),0)::bigint skipped,
      coalesce(sum(case when result->'items'->0->>'failed' ~ '^[0-9]+$' then (result->'items'->0->>'failed')::bigint else 0 end),0)::bigint failed
    from drive_migration_queue_jobs where migration_id=$1 and generation=$2`, [migrationId, generation])).rows[0] || {}
  const { rows: queueWorkers } = await db.query(`select count(*) filter(where status='online' and last_heartbeat_at>now()-interval '90 seconds')::bigint online_workers,
      count(*) filter(where status='online' and current_job_id is not null and last_heartbeat_at>now()-interval '90 seconds')::bigint active_transfers
    from drive_migration_queue_workers where migration_id=$1 and generation=$2`, [migrationId, generation])
  const { rows: items } = await db.query(`with item_rows as (
      select distinct on (item->>'id') item->>'sourceBucket' source_bucket,item->>'targetBucket' target_bucket,
        case when item->>'sourceObjects' ~ '^[0-9]+$' then (item->>'sourceObjects')::bigint else 0 end source_objects,
        case when item->>'sourceBytes' ~ '^[0-9]+$' then (item->>'sourceBytes')::bigint else 0 end source_bytes
      from drive_migration_queue_jobs q cross join lateral jsonb_array_elements(case when jsonb_typeof(q.payload->'items')='array' then q.payload->'items' else '[]'::jsonb end) item
      where q.migration_id=$1 and q.generation=$2 and nullif(item->>'id','') is not null order by item->>'id',q.created_at
    ) select source_bucket,target_bucket,sum(source_objects)::bigint total_objects,sum(source_bytes)::bigint source_bytes
      from item_rows group by source_bucket,target_bucket order by source_bucket,target_bucket`, [migrationId, generation])
  const bucketStats = items.map((item, index) => ({ id: `${item.source_bucket || ""}:${item.target_bucket || ""}:${index}`, sourceBucket: item.source_bucket || "", targetBucket: item.target_bucket || "", totalObjects: Number(item.total_objects || 0), sourceBytes: Number(item.source_bytes || 0) }))
  const snapshot = {
    migrationId, workerGeneration: generation, totalJobs: Number(aggregate.total_jobs || 0), queuedJobs: Number(aggregate.queued_jobs || 0),
    runningJobs: Number(aggregate.running_jobs || 0), remainingJobs: Number(aggregate.remaining_jobs || 0),
    completedJobs: Number(aggregate.completed_jobs || 0), failedJobs: Number(aggregate.failed_jobs || 0), canceledJobs: Number(aggregate.canceled_jobs || 0),
    transferred: Number(aggregate.transferred || 0), skipped: Number(aggregate.skipped || 0), failed: Number(aggregate.failed || 0),
    totalObjects: bucketStats.reduce((sum, item) => sum + item.totalObjects, 0), onlineWorkers: Number(queueWorkers[0]?.online_workers || 0),
    activeTransfers: Number(queueWorkers[0]?.active_transfers || 0), buckets: bucketStats, updatedAt: new Date().toISOString(),
  }
  await queryDb(`insert into drive_migration_worker_live_state(migration_id,snapshot,updated_at) values($1,$2::jsonb,now())
    on conflict(migration_id) do update set snapshot=excluded.snapshot,updated_at=now()`, [migrationId, JSON.stringify(snapshot)])
  return { synced: result.rowCount || 0, syncedWorkers: workers.length, aggregate: { totalJobs: snapshot.totalJobs, completedJobs: snapshot.completedJobs, runningJobs: snapshot.runningJobs, onlineWorkers: snapshot.onlineWorkers } }
}

export async function POST(request: Request) {
  const auth = await authenticateMigrationOrchestrator(request)
  if (!auth.ok) return NextResponse.json({ error: "Invalid orchestration secret" }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({})) as Row
    const migrationId = typeof body.migrationId === "string" ? body.migrationId : ""
    const generation = Math.max(1, Math.trunc(Number(body.generation) || 1))
    const action = body.action === "sync" ? "sync" : "seed"
    if (!/^[0-9a-f-]{36}$/i.test(migrationId)) return NextResponse.json({ error: "Valid migrationId is required" }, { status: 400 })
    const { queueDatabaseUrl, queueDatabaseSsl } = await getMigrationWorkerSettings()
    if (!queueDatabaseUrl) return NextResponse.json({ error: "Migration queue database is not configured in Settings" }, { status: 503 })
    const limit = Math.max(50, Math.min(1000, Math.trunc(Number(body.limit) || 500)))
    const result = await withMigrationQueueDatabase(queueDatabaseUrl, async (db) => {
      await ensureMigrationQueueSchema(db)
      await db.query("begin")
      try {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`drive-migration-queue:${migrationId}:${generation}`])
        const value = action === "seed" ? await seedQueue(db, migrationId, generation, limit) : await syncQueue(db, migrationId, generation, limit)
        await db.query("commit")
        return value
      } catch (error) {
        await db.query("rollback").catch(() => undefined)
        throw error
      }
    }, queueDatabaseSsl)
    return NextResponse.json({ ok: true, action, ...result }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 })
  }
}
