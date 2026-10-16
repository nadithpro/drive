import { createHash } from "node:crypto"
import { Pool } from "pg"
import type { PoolClient, QueryResultRow } from "pg"

const DRIVE_SCHEMA_VERSION = 2026101601

const DRIVE_USER_INDEXES = [
  { name: "drive_users_status_role_idx", sql: "create index concurrently if not exists drive_users_status_role_idx on public.drive_users (status, role)" },
  { name: "drive_users_name_trgm_idx", sql: "create index concurrently if not exists drive_users_name_trgm_idx on public.drive_users using gin (name gin_trgm_ops)" },
  { name: "drive_users_email_trgm_idx", sql: "create index concurrently if not exists drive_users_email_trgm_idx on public.drive_users using gin (email gin_trgm_ops)" },
  { name: "drive_users_username_trgm_idx", sql: "create index concurrently if not exists drive_users_username_trgm_idx on public.drive_users using gin (username gin_trgm_ops)" },
] as const

const DRIVE_PROJECT_SEARCH_INDEXES = [
  { name: "drive_projects_name_trgm_idx", sql: "create index concurrently if not exists drive_projects_name_trgm_idx on public.drive_projects using gin (lower(name) gin_trgm_ops)" },
  { name: "drive_projects_project_id_trgm_idx", sql: "create index concurrently if not exists drive_projects_project_id_trgm_idx on public.drive_projects using gin (lower(project_id) gin_trgm_ops)" },
  { name: "drive_projects_bucket_name_trgm_idx", sql: "create index concurrently if not exists drive_projects_bucket_name_trgm_idx on public.drive_projects using gin (lower(coalesce(bucket_name,'')) gin_trgm_ops)" },
] as const

const DRIVE_AGENT_RUN_INDEXES = [
  { name: "drive_agent_runs_job_reference_created_idx", sql: "create index concurrently if not exists drive_agent_runs_job_reference_created_idx on public.drive_agent_runs (job_reference, created_at desc, id desc)" },
] as const

const DRIVE_MIGRATION_ANALYTICS_INDEXES = [
  { name: "drive_migration_items_progress_time_idx", sql: "create index concurrently if not exists drive_migration_items_progress_time_idx on public.drive_migration_items (coalesce(last_progress_at, updated_at, created_at))" },
] as const

const DRIVE_PROJECT_API_EVENT_INDEXES = [
  { name: "drive_project_api_events_recent_objects_idx", sql: "create index concurrently if not exists drive_project_api_events_recent_objects_idx on public.drive_project_api_events (project_id, action, occurred_at desc, object_key) where outcome = 'success' and object_key is not null" },
] as const

declare global {
  var __drivePgPool: Pool | undefined
  var __drivePgAdvisoryLockPool: Pool | undefined
  var __driveEnsureSchema: Promise<void> | undefined
}

function getEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim().length > 0 ? value : undefined
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes")
    return true
  if (normalized === "0" || normalized === "false" || normalized === "no")
    return false
  return undefined
}

export function postgresSslDisabled(connectionString = getEnv("POSTGRES_URL")): boolean {
  if (parseBooleanEnv(getEnv("POSTGRES_SSL")) === false) return true
  if (parseBooleanEnv(getEnv("DISABLE_POSTGRES_SSL")) === true) return true
  if (!connectionString) return false
  try {
    return new URL(connectionString).searchParams.get("sslmode")?.trim().toLowerCase() === "disable"
  } catch {
    return false
  }
}

function buildSslConfig(): false | {
  rejectUnauthorized: boolean
  checkServerIdentity?: () => undefined
  servername?: string
} {
  if (postgresSslDisabled()) return false

  const rejectUnauthorized =
    parseBooleanEnv(getEnv("POSTGRES_SSL_REJECT_UNAUTHORIZED")) ?? false

  const disableHostnameVerification =
    parseBooleanEnv(getEnv("POSTGRES_SSL_DISABLE_HOSTNAME_VERIFICATION")) ?? true

  const servername = getEnv("POSTGRES_SSL_SERVERNAME")

  return {
    rejectUnauthorized,
    checkServerIdentity: disableHostnameVerification ? () => undefined : undefined,
    servername: servername ?? undefined,
  }
}

function getPoolMax(): number {
  const raw = getEnv("POSTGRES_POOL_MAX")
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed > 0) {
    return process.env.NODE_ENV === "production" ? 1 : Math.max(1, Math.floor(parsed))
  }
  // Each serverless instance owns one process-local pool, so production stays
  // at one client even when an oversized pool setting is present.
  return 1
}

export function isPostgresConnectionCapacityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const maybe = error as { code?: unknown; message?: unknown }
  const code = typeof maybe.code === "string" ? maybe.code : ""
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : ""
  return code === "53300" || message.includes("remaining connection slots are reserved")
}

function getSlowQueryThresholdMs(): number {
  const parsed = Number(getEnv("POSTGRES_SLOW_QUERY_MS"))
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(50, Math.floor(parsed)) : 1_000
}

const SLOW_QUERY_LOG_WINDOW_MS = 30_000
let slowQueryWindowStartedAt = 0
let suppressedSlowQueryCount = 0
const slowQueriesByFingerprint = new Map<string, { calls: number; maxDurationMs: number }>()

function reportSlowQuery(durationMs: number, pool: Pool, waitingAtStart: number, queryText: string) {
  if (durationMs < getSlowQueryThresholdMs()) return
  const now = Date.now()
  const fingerprint = createHash("sha256").update(queryText).digest("hex").slice(0, 12)
  const sample = slowQueriesByFingerprint.get(fingerprint)
  if (sample) {
    sample.calls += 1
    sample.maxDurationMs = Math.max(sample.maxDurationMs, Math.round(durationMs))
  } else if (slowQueriesByFingerprint.size < 32) {
    slowQueriesByFingerprint.set(fingerprint, { calls: 1, maxDurationMs: Math.round(durationMs) })
  }
  if (now - slowQueryWindowStartedAt < SLOW_QUERY_LOG_WINDOW_MS) {
    suppressedSlowQueryCount += 1
    return
  }

  console.warn("[postgres] slow query summary", {
    durationMs: Math.round(durationMs),
    suppressedSlowQueries: suppressedSlowQueryCount,
    slowQueries: [...slowQueriesByFingerprint.entries()]
      .map(([queryFingerprint, summary]) => ({ queryFingerprint, ...summary }))
      .sort((left, right) => right.maxDurationMs - left.maxDurationMs)
      .slice(0, 10),
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waitingAtStart,
      waiting: pool.waitingCount,
    },
  })
  slowQueryWindowStartedAt = now
  suppressedSlowQueryCount = 0
  slowQueriesByFingerprint.clear()
}

function attachPoolErrorHandler(pool: Pool) {
  // Prevent process crashes from idle client errors (e.g. server terminating connections).
  pool.on("error", (error) => {
    console.error("Postgres pool error:", error)
    if (global.__drivePgPool === pool) {
      global.__drivePgPool = undefined
    }
    pool.end().catch(() => {})
  })
}

function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const maybe = error as { code?: unknown; message?: unknown }
  const code = typeof maybe.code === "string" ? maybe.code : ""
  const message = typeof maybe.message === "string" ? maybe.message : ""
  const normalizedMessage = message.toLowerCase()

  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "57P01" || // admin_shutdown
    code === "57P02" || // crash_shutdown
    code === "57P03" || // cannot_connect_now
    normalizedMessage.includes("timeout exceeded when trying to connect") ||
    normalizedMessage.includes("connection timeout") ||
    normalizedMessage.includes("connection terminated unexpectedly") ||
    normalizedMessage.includes("terminating connection due to administrator command") ||
    normalizedMessage.includes("{:shutdown, :db_termination}")
  )
}

export async function queryDb<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[]
) {
  const attempt = async () => {
    const pool = getDbPool()
    const startedAt = performance.now()
    const waitingAtStart = pool.waitingCount
    try {
      return await pool.query<T>(text, params as unknown[] | undefined)
    } finally {
      reportSlowQuery(performance.now() - startedAt, pool, waitingAtStart, text)
    }
  }

  try {
    return await attempt()
  } catch (error) {
    if (!isTransientConnectionError(error)) {
      throw error
    }

    const existing = global.__drivePgPool
    global.__drivePgPool = undefined
    await existing?.end().catch(() => {})

    return attempt()
  }
}

export async function withDbAdvisoryLock<T>(namespace: string, resource: string, operation: () => Promise<T>, options: { wait?: boolean } = {}) {
  if (!global.__drivePgAdvisoryLockPool) {
    const connectionString = getEnv("POSTGRES_URL")
    if (!connectionString) throw new Error("POSTGRES_URL is not configured")
    const pool = new Pool({
      connectionString,
      ssl: buildSslConfig(),
      keepAlive: true,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 5_000,
      max: 1,
    })
    global.__drivePgAdvisoryLockPool = pool
    pool.on("error", (error) => {
      console.error("Postgres advisory-lock pool error:", error)
      if (global.__drivePgAdvisoryLockPool === pool) {
        global.__drivePgAdvisoryLockPool = undefined
      }
      pool.end().catch(() => {})
    })
  }
  // Advisory locks may span slow Cloudflare calls. Reserve their connection
  // separately so those waits cannot consume the dashboard query pool.
  const client = await global.__drivePgAdvisoryLockPool.connect()
  let transactionOpen = false
  try {
    // Supabase's port 6543 is a transaction pooler. Session advisory locks can
    // outlive the client that acquired them because the backend session is
    // returned to Supavisor, leaving a phantom lock behind. Keep a dedicated
    // read-only transaction open so the lock is pinned to one backend and is
    // released automatically even if the operation or connection fails.
    await client.query(`begin read only`)
    transactionOpen = true
    if (options.wait === false) {
      const result = await client.query<{ locked: boolean }>(`select pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) as locked`, [namespace, resource])
      if (!result.rows[0]?.locked) {
        throw Object.assign(new Error("A Cloudflare Worker operation is already running; wait for it to finish, then refresh status"), { code: "DRIVE_ADVISORY_LOCK_BUSY" })
      }
    } else {
      await client.query(`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [namespace, resource])
    }
    return await operation()
  } finally {
    if (transactionOpen) await client.query(`rollback`).catch(() => undefined)
    client.release()
  }
}

export async function withDbTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await getDbPool().connect()
  try {
    await client.query("begin")
    const result = await operation(client)
    await client.query("commit")
    return result
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export function isPostgresConfigured(): boolean {
  return Boolean(getEnv("POSTGRES_URL"))
}

export function getDbPool(): Pool {
  if (!global.__drivePgPool) {
    const connectionString = getEnv("POSTGRES_URL")
    if (!connectionString) throw new Error("POSTGRES_URL is not configured")

    global.__drivePgPool = new Pool({
      connectionString,
      ssl: buildSslConfig(),
      keepAlive: true,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 5_000,
      max: getPoolMax(),
    })
    attachPoolErrorHandler(global.__drivePgPool)
  }

  return global.__drivePgPool
}

async function ensureConcurrentIndexes(resource: string, indexes: readonly { name: string; sql: string }[]) {
  await withDbAdvisoryLock("drive-schema-index", resource, async () => {
    const client = await getDbPool().connect()
    try {
      await client.query("set search_path to public, extensions")
      for (const index of indexes) {
        const existing = await client.query<{ valid: boolean }>(`
          select i.indisvalid as valid
          from pg_index i
          where i.indexrelid=to_regclass($1)
        `, [`public.${index.name}`])
        if (existing.rows[0] && !existing.rows[0].valid) {
          await client.query(`drop index concurrently if exists public.${index.name}`)
        }
        await client.query(index.sql)
      }
    } finally {
      await client.query("reset search_path").catch(() => undefined)
      client.release()
    }
  })
}

export async function ensureDriveSchema(): Promise<void> {
  if (!isPostgresConfigured()) return

  if (!global.__driveEnsureSchema) {
    const schemaPromise = (async () => {
      const registry = await queryDb<{ registry: string | null }>(`select to_regclass('public.drive_schema_meta')::text registry`)
      if (registry.rows[0]?.registry) {
        const current = await queryDb<{ version: string | number }>(`select version from drive_schema_meta where id=true limit 1`)
        if (Number(current.rows[0]?.version || 0) >= DRIVE_SCHEMA_VERSION) return
      }
      await queryDb(`create extension if not exists pgcrypto;`)
      await queryDb(`create extension if not exists pg_trgm;`)

      await queryDb(`
        create table if not exists drive_users (
          id uuid primary key,
          name text not null,
          first_name text not null,
          last_name text,
          username text,
          email text not null,
          role text not null,
          status text not null,
          quota_limit_mb integer not null default 500,
          quota_used_mb integer not null default 0,
          profile_image_url text not null default '',
          google_linked boolean not null default false,
          google_sub text,
          email_verified boolean not null default false,
          email_verified_at timestamptz,
          password_source text not null default 'local',
          two_factor_enabled boolean not null default false,
          totp_enabled boolean not null default false,
          totp_secret text,
          totp_last_used_counter bigint,
          password_hash text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_users_email_key on drive_users (email);`
      )
      await queryDb(
        `create unique index if not exists drive_users_username_key on drive_users (username) where username is not null;`
      )
      await queryDb(`create index if not exists drive_users_created_id_idx on drive_users (created_at, id);`)
      await ensureConcurrentIndexes("users", DRIVE_USER_INDEXES)
      await queryDb(`alter table if exists drive_users add column if not exists email_verified boolean not null default true;`)
      await queryDb(`alter table if exists drive_users add column if not exists email_verified_at timestamptz;`)
      await queryDb(`alter table if exists drive_users add column if not exists two_factor_enabled boolean not null default false;`)
      await queryDb(`alter table if exists drive_users add column if not exists totp_enabled boolean not null default false;`)
      await queryDb(`alter table if exists drive_users add column if not exists totp_secret text;`)
      await queryDb(`alter table if exists drive_users add column if not exists totp_last_used_counter bigint;`)
      await queryDb(`do $$ begin
        if to_regclass('public.drive_bucket_stat_history') is not null
           and to_regclass('public.drive_storage_stats_history') is null then
          alter table public.drive_bucket_stat_history rename to drive_storage_stats_history;
        end if;
      end $$`)
      await queryDb(`
        create table if not exists drive_email_verification_tokens (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references drive_users(id) on delete cascade,
          token_hash text not null,
          email text not null,
          purpose text not null default 'signup',
          attempts integer not null default 0,
          expires_at timestamptz not null,
          consumed_at timestamptz,
          created_at timestamptz not null default now()
        );
      `)
      await queryDb(`drop index if exists drive_email_verification_tokens_hash_key;`)
      await queryDb(`create index if not exists drive_email_verification_tokens_hash_idx on drive_email_verification_tokens (token_hash);`)
      await queryDb(`alter table if exists drive_email_verification_tokens add column if not exists purpose text not null default 'signup';`)
      await queryDb(`alter table if exists drive_email_verification_tokens add column if not exists attempts integer not null default 0;`)
      await queryDb(`create index if not exists drive_email_verification_tokens_user_idx on drive_email_verification_tokens (user_id, purpose, created_at desc);`)
      await queryDb(`create index if not exists drive_email_verification_tokens_expires_idx on drive_email_verification_tokens (expires_at);`)
      await queryDb(`create index if not exists drive_email_verification_tokens_email_purpose_idx on drive_email_verification_tokens (email, purpose, created_at desc);`)

      await queryDb(`
        create table if not exists drive_sms_verification_tokens (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references drive_users(id) on delete cascade,
          token_hash text not null,
          mobile_number text not null,
          purpose text not null default 'signup',
          attempts integer not null default 0,
          expires_at timestamptz not null,
          consumed_at timestamptz,
          created_at timestamptz not null default now()
        );
      `)
      await queryDb(`create index if not exists drive_sms_verification_tokens_hash_idx on drive_sms_verification_tokens (token_hash);`)
      await queryDb(`create index if not exists drive_sms_verification_tokens_user_idx on drive_sms_verification_tokens (user_id,purpose,created_at desc);`)
      await queryDb(`create index if not exists drive_sms_verification_tokens_expires_idx on drive_sms_verification_tokens (expires_at);`)
      await queryDb(`create index if not exists drive_sms_verification_tokens_mobile_purpose_idx on drive_sms_verification_tokens (mobile_number,purpose,created_at desc);`)

      await queryDb(`
        create table if not exists drive_accounts (
          id uuid primary key,
          label text not null,
          email text not null,
          password text not null,
          created_at timestamptz not null default now(),
          two_factor_secret text,
          api_token text not null,
          r2_access_key_id text not null,
          r2_secret_access_key text not null,
          cloudflare_account_id text,
          cloudflare_account_name text,
          status text not null default 'available',
          last_migrated text default '-',
          total_buckets integer not null default 0,
          total_objects integer not null default 0,
          total_bytes bigint not null default 0,
          last_synced_at timestamptz,
          sync_status text default 'idle',
          sync_message text,
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_accounts_email_key on drive_accounts (email);`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_api_token_key on drive_accounts (api_token);`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_r2_access_key_id_key on drive_accounts (r2_access_key_id);`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_label_ci_key on drive_accounts ((lower(label)));`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_one_active_key on drive_accounts ((status)) where status = 'active';`
      )

      await queryDb(`
        create table if not exists drive_bucket_stats (
          id uuid primary key,
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          continuation_token text,
          status text not null default 'pending',
          error text,
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_bucket_stats_unique on drive_bucket_stats (account_id, bucket_name);`
      )
      await queryDb(
        `create index if not exists drive_bucket_stats_account_idx on drive_bucket_stats (account_id);`
      )
      await queryDb(
        `create index if not exists drive_bucket_stats_status_idx on drive_bucket_stats (status);`
      )

      await queryDb(`
        create table if not exists drive_bucket_settings_snapshots (
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          bucket_created_at timestamptz,
          jurisdiction text not null default 'default',
          location text,
          storage_class text not null default 'Standard',
          public_access jsonb not null default '{"enabled":false,"domain":null,"bucketId":null}'::jsonb,
          cors_rules jsonb not null default '[]'::jsonb,
          settings_status text not null default 'pending',
          settings_error text,
          settings_last_attempted_at timestamptz,
          settings_last_synced_at timestamptz,
          inventory_synced_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(
        `create index if not exists drive_bucket_settings_snapshots_account_idx on drive_bucket_settings_snapshots (account_id);`
      )

      await queryDb(`
        create table if not exists drive_projects (
          id uuid primary key default gen_random_uuid(),
          project_id text not null,
          name text not null,
          bucket_name text not null,
          status text not null default 'active',
          created_account_id uuid references drive_accounts(id) on delete set null,
          created_account_label text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table public.drive_projects add column if not exists created_account_id uuid references drive_accounts(id) on delete set null;`)
      await queryDb(`alter table public.drive_projects add column if not exists created_account_label text;`)
      await queryDb(`alter table public.drive_projects alter column bucket_name drop not null;`)
      await queryDb(`update public.drive_projects set bucket_name = '' where bucket_name is null;`)
      await queryDb(`alter table public.drive_projects alter column bucket_name set default '';`)
      await queryDb(`alter table public.drive_projects alter column bucket_name set not null;`)
      await queryDb(`
        do $$
        declare
          id_data_type text;
          pk_name text;
        begin
          select c.data_type
          into id_data_type
          from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = 'drive_projects'
            and c.column_name = 'id';

          if id_data_type is not null and id_data_type <> 'uuid' then
            alter table public.drive_projects add column if not exists legacy_id text;

            update public.drive_projects
            set legacy_id = id::text
            where legacy_id is null;

            select conname
            into pk_name
            from pg_constraint
            where conrelid = 'public.drive_projects'::regclass
              and contype = 'p'
            limit 1;

            if pk_name is not null then
              execute format('alter table public.drive_projects drop constraint %I', pk_name);
            end if;

            alter table public.drive_projects rename column id to old_text_id;
            alter table public.drive_projects alter column old_text_id drop not null;
            alter table public.drive_projects add column id uuid default gen_random_uuid();

            update public.drive_projects
            set id = case
              when old_text_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then old_text_id::text::uuid
              else gen_random_uuid()
            end;

            alter table public.drive_projects alter column id set not null;
            alter table public.drive_projects add primary key (id);
          end if;
        end $$;
      `)
      await queryDb(`
        do $$
        begin
          if exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'drive_projects'
              and column_name = 'active_account_id'
          ) then
            update public.drive_projects
            set created_account_id = active_account_id
            where created_account_id is null
              and active_account_id is not null;

            if exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'drive_projects'
                and column_name = 'active_account_id'
                and is_nullable = 'NO'
            ) then
              alter table public.drive_projects alter column active_account_id drop not null;
            end if;
          end if;
        end $$;
      `)
      await queryDb(`
        do $$
        begin
          if exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'drive_projects'
              and column_name = 'old_text_id'
              and is_nullable = 'NO'
          ) then
            alter table public.drive_projects alter column old_text_id drop not null;
          end if;
        end $$;
      `)
      await queryDb(`
        do $$
        declare
          legacy_column text;
        begin
          foreach legacy_column in array array['api_key_hash', 'api_key_prefix', 'api_key_name', 'api_key', 'bucket_id']
          loop
            if exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'drive_projects'
                and column_name = legacy_column
                and is_nullable = 'NO'
            ) then
              execute format(
                'alter table public.drive_projects alter column %I drop not null',
                legacy_column
              );
            end if;
          end loop;
        end $$;
      `)
      await queryDb(`alter table if exists drive_projects drop constraint if exists drive_projects_bucket_name_key;`)
      await queryDb(`drop index if exists drive_projects_bucket_name_key;`)
      await queryDb(`create unique index if not exists drive_projects_project_id_key on drive_projects (project_id);`)
      await queryDb(`create index if not exists drive_projects_bucket_name_idx on drive_projects (bucket_name) where bucket_name <> '';`)
      await queryDb(`create index if not exists drive_projects_status_idx on drive_projects (status);`)
      await ensureConcurrentIndexes("projects", DRIVE_PROJECT_SEARCH_INDEXES)
      await queryDb(`
        create table if not exists drive_project_bucket_assignments (
          project_id uuid not null references drive_projects(id) on delete cascade,
          account_id uuid references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          is_primary boolean not null default false,
          created_at timestamptz not null default now(),
          primary key (project_id, bucket_name)
        );
      `)
      await queryDb(`alter table public.drive_project_bucket_assignments add column if not exists account_id uuid references public.drive_accounts(id) on delete cascade;`)
      await queryDb(`
        update drive_project_bucket_assignments assignment
        set account_id = project.created_account_id
        from drive_projects project
        where assignment.project_id = project.id
          and assignment.account_id is null
          and project.created_account_id is not null;
      `)
      await queryDb(`
        update drive_project_bucket_assignments assignment
        set account_id = active.id
        from (select id from drive_accounts where status = 'active' order by updated_at desc limit 1) active
        where assignment.account_id is null;
      `)
      await queryDb(`alter table public.drive_project_bucket_assignments drop column if exists media_allowed_origins;`)
      await queryDb(`alter table public.drive_project_bucket_assignments drop column if exists public_access_enabled;`)
      await queryDb(`alter table if exists drive_project_bucket_assignments drop constraint if exists drive_project_bucket_assignments_bucket_key;`)
      await queryDb(`drop index if exists drive_project_bucket_assignments_bucket_key;`)
      await queryDb(`drop index if exists drive_project_bucket_assignments_bucket_idx;`)
      await queryDb(`create index if not exists drive_project_bucket_assignments_account_bucket_idx on drive_project_bucket_assignments (account_id, bucket_name);`)
      await queryDb(`create unique index if not exists drive_project_bucket_assignments_primary_idx on drive_project_bucket_assignments (project_id) where is_primary = true;`)
      await queryDb(`
        create table if not exists drive_bucket_delivery_settings (
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          public_access_enabled boolean not null default true,
          media_allowed_origins text[],
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(`
        create table if not exists drive_project_delivery_settings (
          project_id uuid primary key references drive_projects(id) on delete cascade,
          media_allowed_origins text[],
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`
        create table if not exists drive_project_delivery_sync_state (
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          status text not null default 'pending',
          cursor text,
          lease_owner text,
          lease_expires_at timestamptz,
          attempt_count integer not null default 0,
          desired_origins text[] not null default '{}',
          changed boolean not null default false,
          last_checked_at timestamptz,
          last_synced_at timestamptz,
          failure_count integer not null default 0,
          next_attempt_at timestamptz,
          error text,
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(`alter table drive_project_delivery_sync_state add column if not exists failure_count integer not null default 0;`)
      await queryDb(`alter table drive_project_delivery_sync_state add column if not exists next_attempt_at timestamptz;`)
      await queryDb(`
        insert into drive_project_bucket_assignments (project_id, account_id, bucket_name, is_primary)
        select p.id, coalesce(p.created_account_id, (select id from drive_accounts where status = 'active' order by updated_at desc limit 1)), p.bucket_name, true
        from drive_projects p
        where p.bucket_name <> ''
          and not exists (
            select 1
            from drive_project_bucket_assignments a
            where a.project_id = p.id
              and a.bucket_name = p.bucket_name
          );
      `)

      await queryDb(`
        create table if not exists drive_project_api_keys (
          id uuid primary key default gen_random_uuid(),
          name text not null,
          key_prefix text not null,
          key_hash text not null,
          status text not null default 'active',
          expires_at timestamptz,
          last_used_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`create unique index if not exists drive_project_api_keys_hash_key on drive_project_api_keys (key_hash);`)
      await queryDb(`create index if not exists drive_project_api_keys_status_idx on drive_project_api_keys (status);`)

      await queryDb(`
        create table if not exists drive_project_api_key_assignments (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          api_key_id uuid not null references drive_project_api_keys(id) on delete cascade,
          permissions jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`
        create unique index if not exists drive_project_api_key_assignments_unique
          on drive_project_api_key_assignments (project_id, api_key_id);
      `)
      await queryDb(`create index if not exists drive_project_api_key_assignments_key_idx on drive_project_api_key_assignments (api_key_id);`)

      await queryDb(`
        create table if not exists drive_project_file_links (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          file_id text,
          object_key text not null,
          bucket_name text,
          token_hash text not null,
          mode text not null,
          expires_at timestamptz,
          revoked_at timestamptz,
          created_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table public.drive_project_file_links add column if not exists file_id text;`)
      await queryDb(`alter table public.drive_project_file_links add column if not exists bucket_name text;`)
      await queryDb(`
        update drive_project_file_links l
        set bucket_name = p.bucket_name
        from drive_projects p
        where l.project_id = p.id
          and l.bucket_name is null;
      `)
      await queryDb(`create unique index if not exists drive_project_file_links_token_hash_key on drive_project_file_links (token_hash);`)
      await queryDb(`create index if not exists drive_project_file_links_file_idx on drive_project_file_links (file_id);`)
      await queryDb(`create index if not exists drive_project_file_links_project_idx on drive_project_file_links (project_id, object_key);`)
      await queryDb(`create index if not exists drive_project_file_links_active_idx on drive_project_file_links (mode, revoked_at, expires_at);`)

      await queryDb(`
        create table if not exists drive_project_operation_jobs (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          type text not null,
          status text not null default 'queued',
          payload jsonb not null default '{}'::jsonb,
          progress jsonb not null default '{}'::jsonb,
          result jsonb not null default '{}'::jsonb,
          error text,
          idempotency_key text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          started_at timestamptz,
          completed_at timestamptz
        );
      `)
      await queryDb(`create index if not exists drive_project_operation_jobs_project_idx on drive_project_operation_jobs (project_id, created_at desc);`)
      await queryDb(`create index if not exists drive_project_operation_jobs_status_idx on drive_project_operation_jobs (status, created_at);`)
      await queryDb(`
        create unique index if not exists drive_project_operation_jobs_idempotency_key
          on drive_project_operation_jobs (project_id, idempotency_key)
          where idempotency_key is not null;
      `)

      await queryDb(`
        create table if not exists drive_project_api_events (
          id uuid primary key default gen_random_uuid(),
          occurred_at timestamptz not null default now(),
          project_id uuid references drive_projects(id) on delete cascade,
          api_key_id uuid references drive_project_api_keys(id) on delete set null,
          action text not null,
          object_key text,
          status integer,
          outcome text not null default 'success',
          ip_address text,
          user_agent text,
          request_id text,
          metadata jsonb not null default '{}'::jsonb
        );
      `)
      await queryDb(`create index if not exists drive_project_api_events_project_time_idx on drive_project_api_events (project_id, occurred_at desc);`)
      await queryDb(`create index if not exists drive_project_api_events_key_time_idx on drive_project_api_events (api_key_id, occurred_at desc);`)
      await queryDb(`create index if not exists drive_project_api_events_action_time_idx on drive_project_api_events (action, occurred_at desc);`)
      await queryDb(`create index if not exists drive_project_api_events_occurred_id_idx on drive_project_api_events (occurred_at desc, id desc);`)
      await ensureConcurrentIndexes("project-api-events", DRIVE_PROJECT_API_EVENT_INDEXES)

      await queryDb(`
        create table if not exists drive_project_object_inventory (
          project_id uuid not null references drive_projects(id) on delete cascade,
          bucket_name text not null,
          object_key text not null,
          size bigint not null default 0,
          etag text,
          content_type text,
          metadata jsonb not null default '{}'::jsonb,
          last_modified timestamptz,
          deleted_at timestamptz,
          updated_at timestamptz not null default now(),
          primary key (project_id, bucket_name, object_key)
        );
      `)
      await queryDb(`alter table public.drive_project_object_inventory add column if not exists bucket_name text;`)
      await queryDb(`alter table public.drive_project_object_inventory add column if not exists file_id text;`)
      await queryDb(`
        update drive_project_object_inventory i
        set bucket_name = coalesce(nullif(p.bucket_name, ''), '')
        from drive_projects p
        where p.id = i.project_id
          and i.bucket_name is null;
      `)
      await queryDb(`update public.drive_project_object_inventory set bucket_name = '' where bucket_name is null;`)
      await queryDb(`update public.drive_project_object_inventory set file_id = encode(gen_random_bytes(12), 'hex') where file_id is null or file_id = '';`)
      await queryDb(`alter table public.drive_project_object_inventory alter column bucket_name set default '';`)
      await queryDb(`alter table public.drive_project_object_inventory alter column bucket_name set not null;`)
      await queryDb(`alter table public.drive_project_object_inventory alter column file_id set default encode(gen_random_bytes(12), 'hex');`)
      await queryDb(`alter table public.drive_project_object_inventory alter column file_id set not null;`)
      await queryDb(`alter table public.drive_project_object_inventory drop constraint if exists drive_project_object_inventory_pkey;`)
      await queryDb(`alter table public.drive_project_object_inventory add constraint drive_project_object_inventory_pkey primary key (project_id, bucket_name, object_key);`)
      await queryDb(`create unique index if not exists drive_project_object_inventory_file_id_key on drive_project_object_inventory (file_id);`)
      await queryDb(`drop index if exists drive_project_object_inventory_search_idx;`)
      await queryDb(`drop index if exists drive_project_object_inventory_updated_idx;`)
      await queryDb(`create index if not exists drive_project_object_inventory_search_idx on drive_project_object_inventory (project_id, bucket_name, object_key text_pattern_ops) where deleted_at is null;`)
      await queryDb(`create index if not exists drive_project_object_inventory_updated_idx on drive_project_object_inventory (project_id, bucket_name, updated_at desc);`)
      await queryDb(`create index if not exists drive_project_object_inventory_project_file_id_idx on drive_project_object_inventory (project_id, file_id) where deleted_at is null;`)

      await queryDb(`
        create table if not exists drive_project_object_locks (
          project_id uuid not null references drive_projects(id) on delete cascade,
          bucket_name text not null,
          object_key text not null,
          lock_token_hash text not null,
          reason text,
          expires_at timestamptz,
          created_at timestamptz not null default now(),
          primary key (project_id, bucket_name, object_key)
        );
      `)
      await queryDb(`alter table public.drive_project_object_locks add column if not exists bucket_name text;`)
      await queryDb(`
        update drive_project_object_locks l
        set bucket_name = coalesce(nullif(p.bucket_name, ''), '')
        from drive_projects p
        where p.id = l.project_id
          and l.bucket_name is null;
      `)
      await queryDb(`update public.drive_project_object_locks set bucket_name = '' where bucket_name is null;`)
      await queryDb(`alter table public.drive_project_object_locks alter column bucket_name set default '';`)
      await queryDb(`alter table public.drive_project_object_locks alter column bucket_name set not null;`)
      await queryDb(`alter table public.drive_project_object_locks drop constraint if exists drive_project_object_locks_pkey;`)
      await queryDb(`alter table public.drive_project_object_locks add constraint drive_project_object_locks_pkey primary key (project_id, bucket_name, object_key);`)

      await queryDb(`
        create table if not exists drive_project_webhooks (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          target_url text not null,
          events jsonb not null default '[]'::jsonb,
          secret text,
          status text not null default 'active',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`
        create table if not exists drive_analytics_bucket_snapshots (
          account_id uuid not null,
          account_label text,
          account_email text,
          bucket_name text not null,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          status text,
          source_updated_at timestamptz,
          captured_at timestamptz not null default now(),
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(
        `create index if not exists drive_analytics_bucket_snapshots_captured_idx on drive_analytics_bucket_snapshots (captured_at desc);`
      )

      await queryDb(`
        create table if not exists drive_analytics_active_account_snapshots (
          captured_day date not null,
          account_id uuid,
          scope text not null default 'account',
          account_label text,
          account_email text,
          buckets integer not null default 0,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          bucket_fingerprint text,
          captured_at timestamptz not null default now(),
          primary key (scope, captured_day)
        );
      `)
      await queryDb(`alter table public.drive_analytics_active_account_snapshots add column if not exists scope text not null default 'account';`)
      await queryDb(`alter table public.drive_analytics_active_account_snapshots add column if not exists bucket_fingerprint text;`)
      await queryDb(`alter table public.drive_analytics_active_account_snapshots alter column account_id drop not null;`)
      await queryDb(`alter table public.drive_analytics_active_account_snapshots drop constraint if exists drive_analytics_active_account_snapshots_pkey;`)
      await queryDb(`alter table public.drive_analytics_active_account_snapshots add constraint drive_analytics_active_account_snapshots_pkey primary key (scope, captured_day);`)
      await queryDb(`drop index if exists public.drive_analytics_active_account_snapshots_one_per_day_idx;`)
      await queryDb(`create index if not exists drive_analytics_active_account_snapshots_day_idx on public.drive_analytics_active_account_snapshots (captured_day desc);`)

      await queryDb(`
        create table if not exists drive_storage_stats_history (
          id bigint generated always as identity primary key,
          account_id uuid not null,
          account_label text,
          account_email text,
          bucket_name text not null,
          previous_objects bigint,
          objects bigint not null default 0,
          object_delta bigint not null default 0,
          previous_bytes bigint,
          bytes bigint not null default 0,
          byte_delta bigint not null default 0,
          change_type text not null,
          changed_at timestamptz not null default now()
        );
      `)
      await queryDb(`create index if not exists drive_storage_stats_history_bucket_time_idx on drive_storage_stats_history (account_id, bucket_name, changed_at desc);`)
      await queryDb(`create index if not exists drive_storage_stats_history_time_idx on drive_storage_stats_history (changed_at desc);`)
      await queryDb(`
        create table if not exists drive_maintenance_state (
          task_name text primary key,
          last_run_at timestamptz not null default now(),
          last_result jsonb not null default '{}'::jsonb
        );
      `)
      await queryDb(`
        create table if not exists drive_backend_orchestrator_state (
          id boolean primary key default true check (id),
          status text not null default 'idle',
          orchestrator_url text,
          last_started_at timestamptz,
          last_completed_at timestamptz,
          last_error text,
          last_result jsonb not null default '{}'::jsonb,
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`
        create table if not exists drive_migrations (
          id uuid primary key,
          source_account_id uuid not null references drive_accounts(id) on delete restrict,
          target_account_id uuid not null references drive_accounts(id) on delete restrict,
          status text not null default 'draft',
          options jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          started_at timestamptz,
          completed_at timestamptz,
          last_synced_at timestamptz,
          sync_status text default 'idle',
          sync_message text,
          summary_item_count integer not null default 0,
          summary_objects bigint not null default 0,
          summary_bytes bigint not null default 0,
          worker_summary jsonb not null default '{}'::jsonb,
          details_compacted_at timestamptz,
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table if exists drive_migrations add column if not exists summary_item_count integer not null default 0;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists summary_objects bigint not null default 0;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists summary_bytes bigint not null default 0;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists worker_summary jsonb not null default '{}'::jsonb;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists details_compacted_at timestamptz;`)

      await queryDb(
        `create index if not exists drive_migrations_created_at_idx on drive_migrations (created_at desc);`
      )
      await queryDb(
        `create index if not exists drive_migrations_status_idx on drive_migrations (status);`
      )
      await queryDb(
        `create index if not exists drive_migrations_source_idx on drive_migrations (source_account_id);`
      )
      await queryDb(
        `create index if not exists drive_migrations_target_idx on drive_migrations (target_account_id);`
      )

      await queryDb(`
        create table if not exists drive_migration_items (
          id uuid primary key,
          migration_id uuid not null references drive_migrations(id) on delete cascade,
          source_bucket text not null,
          target_bucket text not null,
          source_jurisdiction text,
          source_storage_class text,
          source_objects bigint,
          source_bytes bigint,
          slurper_job_id text,
          slurper_status text,
          progress jsonb not null default '{}'::jsonb,
          last_progress_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table public.drive_migration_items add column if not exists last_progress_at timestamptz;`)

      await queryDb(
        `create unique index if not exists drive_migration_items_unique_bucket on drive_migration_items (migration_id, source_bucket);`
      )
      await queryDb(
        `create index if not exists drive_migration_items_migration_idx on drive_migration_items (migration_id);`
      )
      await queryDb(
        `create index if not exists drive_migration_items_job_idx on drive_migration_items (slurper_job_id);`
      )
      await ensureConcurrentIndexes("migration-analytics", DRIVE_MIGRATION_ANALYTICS_INDEXES)

      await queryDb(`
        create table if not exists drive_migration_item_failure_records (
          id uuid primary key,
          migration_item_id uuid not null references drive_migration_items(id) on delete cascade,
          object_key text not null,
          message text not null default '',
          occurred_at_text text not null default '',
          occurred_at timestamptz,
          raw_log jsonb,
          source_probe jsonb,
          destination_probe jsonb,
          diagnosis jsonb,
          download jsonb,
          fetched_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create index if not exists drive_migration_item_failure_records_item_idx on drive_migration_item_failure_records (migration_item_id);`
      )
      await queryDb(
        `create index if not exists drive_migration_item_failure_records_key_idx on drive_migration_item_failure_records (migration_item_id, object_key);`
      )

      await queryDb(`
        create table if not exists drive_agents (
          id uuid primary key,
          name text not null,
          category text not null default 'worker',
          provider text not null default 'self_hosted',
          status text not null default 'pending_registration',
          capabilities jsonb not null default '[]'::jsonb,
          endpoint_domain text,
          endpoint_ip text,
          github_repo_owner text,
          github_repo_name text,
          github_workflow_file text,
          github_ref text,
          github_repository_id text,
          github_token text,
          worker_count integer not null default 1 check (worker_count between 1 and 5),
          notes text,
          runtime_instance_id text,
          registration_token text,
          registration_token_hash text,
          last_heartbeat_at timestamptz,
          last_seen_ip text,
          last_seen_host text,
          last_seen_version text,
          last_error text,
          metadata jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`create index if not exists drive_agents_status_idx on drive_agents (status);`)
      await queryDb(`create index if not exists drive_agents_provider_idx on drive_agents (provider);`)
      await queryDb(`create index if not exists drive_agents_category_idx on drive_agents (category);`)
      // `create table if not exists` does not evolve existing installations.
      // The runtime identity is how an autonomous worker recovers its durable
      // registration without creating another dashboard worker after a restart.
      await queryDb(`alter table if exists drive_agents add column if not exists runtime_instance_id text;`)
      await queryDb(`alter table if exists drive_agents add column if not exists worker_count integer not null default 1;`)
      await queryDb(`alter table if exists drive_agents drop constraint if exists drive_agents_worker_count_check;`)
      await queryDb(`alter table if exists drive_agents add constraint drive_agents_worker_count_check check (worker_count between 1 and 5);`)
      await queryDb(`create unique index if not exists drive_agents_runtime_instance_unique on drive_agents (runtime_instance_id) where runtime_instance_id is not null;`)
      await queryDb(`
        update drive_agents
        set github_workflow_file = '.github/workflows/migration-worker.yml', updated_at = now()
        where github_workflow_file = '.github/workflows/agent-worker.yml';
      `)

      await queryDb(`
        create table if not exists drive_agent_runs (
          id uuid primary key,
          agent_id uuid not null references drive_agents(id) on delete cascade,
          run_type text not null default 'manual',
          status text not null default 'pending',
          external_run_id text,
          job_reference text,
          summary text,
          payload jsonb not null default '{}'::jsonb,
          started_at timestamptz,
          completed_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`alter table if exists public.drive_agent_runs add column if not exists job_reference text;`)
      await queryDb(`create index if not exists drive_agent_runs_agent_idx on drive_agent_runs (agent_id, created_at desc);`)
      await queryDb(`create index if not exists drive_agent_runs_migration_idx on drive_agent_runs ((payload->>'migrationId'), status) where run_type='github_dispatch';`)
      await ensureConcurrentIndexes("agent-runs", DRIVE_AGENT_RUN_INDEXES)

      await queryDb(`
        create table if not exists drive_repair_jobs (
          id uuid primary key,
          migration_id uuid not null references drive_migrations(id) on delete cascade,
          requested_by_agent_id uuid references drive_agents(id) on delete set null,
          claimed_by_agent_id uuid references drive_agents(id) on delete set null,
          claim_token uuid,
          status text not null default 'pending',
          mode text not null default 'repair_and_verify',
          work_key text,
          payload jsonb not null default '{}'::jsonb,
          progress jsonb not null default '{}'::jsonb,
          result jsonb not null default '{}'::jsonb,
          summary text,
          error text,
          claimed_at timestamptz,
          started_at timestamptz,
          completed_at timestamptz,
          last_heartbeat_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`create index if not exists drive_repair_jobs_status_idx on drive_repair_jobs (status, created_at);`)
      await queryDb(`create index if not exists drive_repair_jobs_migration_idx on drive_repair_jobs (migration_id, created_at desc);`)
      await queryDb(`create index if not exists drive_repair_jobs_claimed_idx on drive_repair_jobs (claimed_by_agent_id, status);`)
      await queryDb(`alter table if exists drive_repair_jobs add column if not exists work_key text;`)
      await queryDb(`alter table if exists drive_repair_jobs add column if not exists claim_token uuid;`)
      await queryDb(`create unique index if not exists drive_repair_jobs_work_key_unique on drive_repair_jobs (work_key) where work_key is not null;`)

      await queryDb(`
        create table if not exists drive_app_settings (
          key text primary key,
          value jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`
        create table if not exists drive_backend_orchestrator_metric_candidates (
          account_id uuid not null,
          bucket_name text not null,
          objects bigint not null,
          bytes bigint not null,
          observed_at timestamptz not null,
          confirmations integer not null default 1,
          first_observed_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(`
        create table if not exists drive_backend_orchestrator_progress (
          id boolean primary key default true check (id),
          account_id uuid not null,
          bucket_names jsonb not null default '[]'::jsonb,
          bucket_offset integer not null default 0 check (bucket_offset >= 0),
          reconciled boolean not null default false,
          metrics_incomplete boolean not null default false,
          pending_decreases boolean not null default false,
          started_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table drive_backend_orchestrator_progress add column if not exists reconciled boolean not null default false;`)
      await queryDb(`alter table drive_backend_orchestrator_progress add column if not exists metrics_incomplete boolean not null default false;`)
      await queryDb(`alter table drive_backend_orchestrator_progress add column if not exists pending_decreases boolean not null default false;`)
      await queryDb(`
        create table if not exists drive_bucket_scans (
          id uuid primary key,
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          kind text not null default 'source',
          migration_id uuid references drive_migrations(id) on delete cascade,
          migration_item_id uuid references drive_migration_items(id) on delete cascade,
          prefix text,
          status text not null default 'pending',
          last_key text,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          error text,
          started_at timestamptz,
          completed_at timestamptz,
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`create index if not exists drive_bucket_scans_account_bucket_idx on drive_bucket_scans (account_id, bucket_name);`)
      await queryDb(`alter table if exists drive_bucket_scans add column if not exists cursor text;`)
      await queryDb(`alter table if exists drive_bucket_scans add column if not exists lease_owner text;`)
      await queryDb(`alter table if exists drive_bucket_scans add column if not exists lease_expires_at timestamptz;`)
      await queryDb(`alter table if exists drive_bucket_scans add column if not exists attempt_count integer not null default 0;`)
      await queryDb(`create index if not exists drive_bucket_scans_migration_idx on drive_bucket_scans (migration_id);`)
      await queryDb(`create index if not exists drive_bucket_scans_item_idx on drive_bucket_scans (migration_item_id);`)
      await queryDb(`create index if not exists drive_bucket_scans_status_idx on drive_bucket_scans (status);`)
      await queryDb(`
        create table if not exists drive_bucket_scan_objects (
          scan_id uuid not null references drive_bucket_scans(id) on delete cascade,
          key text not null,
          size bigint not null default 0,
          is_dir_marker boolean not null default false,
          etag text,
          last_modified timestamptz,
          created_at timestamptz not null default now(),
          primary key (scan_id, key)
        );
      `)
      await queryDb(`drop index concurrently if exists public.drive_bucket_scan_objects_key_idx;`)
      await queryDb(`
        create table if not exists drive_bucket_verify_diffs (
          id uuid primary key,
          migration_item_id uuid not null references drive_migration_items(id) on delete cascade,
          source_scan_id uuid not null references drive_bucket_scans(id) on delete cascade,
          dest_scan_id uuid not null references drive_bucket_scans(id) on delete cascade,
          kind text not null,
          key text not null,
          source_size bigint,
          dest_size bigint,
          created_at timestamptz not null default now()
        );
      `)
      await queryDb(`create index if not exists drive_bucket_verify_diffs_item_idx on drive_bucket_verify_diffs (migration_item_id);`)
      await queryDb(`create index if not exists drive_bucket_verify_diffs_kind_idx on drive_bucket_verify_diffs (kind);`)
      await queryDb(`create index concurrently if not exists drive_bucket_verify_diffs_created_idx on drive_bucket_verify_diffs (created_at desc);`)
      await queryDb(`
        create table if not exists drive_migration_orchestrator_state (
          id boolean primary key default true check (id),
          status text not null default 'idle',
          lease_owner text,
          lease_expires_at timestamptz,
          orchestrator_url text,
          last_started_at timestamptz,
          last_completed_at timestamptz,
          last_error text,
          last_migration_id uuid references drive_migrations(id) on delete set null,
          last_result jsonb not null default '{}'::jsonb,
          cycle_count bigint not null default 0,
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table if exists drive_migration_orchestrator_state add column if not exists lease_owner text;`)
      await queryDb(`alter table if exists drive_migration_orchestrator_state add column if not exists lease_expires_at timestamptz;`)
      await queryDb(`
        create table if not exists drive_migration_worker_live_state (
          migration_id uuid primary key references drive_migrations(id) on delete cascade,
          snapshot jsonb not null default '{}'::jsonb,
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`
        create table if not exists drive_migration_verification_state (
          migration_item_id uuid primary key references drive_migration_items(id) on delete cascade,
          migration_id uuid not null references drive_migrations(id) on delete cascade,
          generation integer not null default 1,
          source_scan_id uuid references drive_bucket_scans(id) on delete set null,
          destination_scan_id uuid references drive_bucket_scans(id) on delete set null,
          phase text not null default 'source',
          status text not null default 'pending',
          source_cursor text,
          destination_cursor text,
          source_objects bigint not null default 0,
          source_bytes bigint not null default 0,
          destination_objects bigint not null default 0,
          destination_bytes bigint not null default 0,
          missing_objects bigint not null default 0,
          mismatched_objects bigint not null default 0,
          extra_objects bigint not null default 0,
          attempt_count integer not null default 0,
          attempt_generation integer,
          last_error text,
          lease_owner text,
          lease_expires_at timestamptz,
          completed_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table if exists drive_migration_verification_state add column if not exists attempt_generation integer;`)
      await queryDb(`create index if not exists drive_migration_verification_state_queue_idx on drive_migration_verification_state (status, updated_at);`)
      await queryDb(`create index if not exists drive_migration_verification_state_migration_idx on drive_migration_verification_state (migration_id, generation);`)
      await queryDb(`
        create table if not exists drive_file_scanner_state (
          id boolean primary key default true check (id),
          status text not null default 'idle',
          lease_owner text,
          last_started_at timestamptz,
          last_completed_at timestamptz,
          last_error text,
          last_migration_item_id uuid references drive_migration_items(id) on delete set null,
          last_result jsonb not null default '{}'::jsonb,
          cycle_count bigint not null default 0,
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table if exists drive_file_scanner_state add column if not exists lease_owner text;`)
      await queryDb(`
        create table if not exists drive_cloudflare_worker_installations (
          id uuid primary key,
          state jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`create index if not exists drive_cloudflare_worker_installations_updated_idx on drive_cloudflare_worker_installations(updated_at desc);`)
      await queryDb(`create table if not exists drive_schema_meta (id boolean primary key default true check(id),version bigint not null,updated_at timestamptz not null default now());`)
      await queryDb(`insert into drive_schema_meta(id,version,updated_at) values(true,$1,now()) on conflict(id) do update set version=excluded.version,updated_at=now();`, [DRIVE_SCHEMA_VERSION])
    })()
    global.__driveEnsureSchema = schemaPromise.catch((error) => {
      global.__driveEnsureSchema = undefined
      throw error
    })
  }

  return global.__driveEnsureSchema
}
