const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function load(source, names, globals = {}) {
  const context = { exports: {}, ...globals }
  vm.runInNewContext(ts.transpileModule(source + `\nexports.subject = { ${names.join(',')} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return context.exports.subject
}
const orchestrator = fs.readFileSync('workers/migration-orchestrator/src/index.ts', 'utf8')

test('transfer percentage reaches 100 only when every file is accounted for', () => {
  const { migrationProgressPercent: percent } = load(fs.readFileSync('src/lib/migration-progress.ts', 'utf8'), ['migrationProgressPercent'])
  assert.equal(percent(6657, 6660), 99.9)
  assert.equal(percent(6659, 6660), 99.9)
  assert.equal(percent(6660, 6660), 100)
  assert.equal(percent(9, 9), 100)
  assert.equal(percent(0, 9), 0)
  assert.equal(percent(0, 0), 0)
  assert.equal(percent(NaN, 9), 0)
})

test('endpoint quota failure pauses dispatch and clears only its own error after recovery', async () => {
  let now = 0, requests = 0, healthy = false
  const source = orchestrator.slice(orchestrator.indexOf('let endpointHealth:'), orchestrator.indexOf('async function dispatchWorkers'))
  const { workerEndpointAvailable } = load(source, ['workerEndpointAvailable'], {
    Date: { now: () => now }, AbortSignal,
    fetch: async () => { requests++; return { ok: healthy, status: healthy ? 200 : 429, text: async () => healthy ? '{"ok":true,"service":"migration-orchestrator"}' : '<h1>Error 1027</h1>' } },
  })
  const writes = []
  const db = { query: async (...args) => { writes.push(args); return { rows: [] } } }
  const config = { orchestratorUrl: 'https://worker.example' }
  assert.equal(await workerEndpointAvailable(db, 'migration', config), false)
  assert.match(writes[0][1][1], /daily request limit.*1027/)
  assert.equal(await workerEndpointAvailable(db, 'migration', config), false)
  assert.equal(requests, 1)
  healthy = true; now = 61000
  assert.equal(await workerEndpointAvailable(db, 'migration', config), true)
  assert.equal(requests, 2)
  assert.match(writes.at(-1)[0], /sync_message like 'Cloudflare Workers daily request limit reached%'/)
  assert.match(writes.at(-1)[0], /workerEndpointRecoveryUntil.*6 minutes/)
})

test('invalid health responses fail closed instead of dispatching workers', async () => {
  const source = orchestrator.slice(orchestrator.indexOf('let endpointHealth:'), orchestrator.indexOf('async function dispatchWorkers'))
  for (const body of ['null', '<html>Unavailable</html>', '{"ok":false,"service":"migration-orchestrator"}', '{"ok":true,"service":"other"}']) {
    const { workerEndpointAvailable } = load(source, ['workerEndpointAvailable'], {
      AbortSignal, fetch: async () => ({ ok: true, text: async () => body }),
    })
    assert.equal(await workerEndpointAvailable({ query: async () => ({ rows: [] }) }, 'migration', { orchestratorUrl: 'https://worker.example' }), false)
  }
})

test('recovery grace protects stale workers before GitHub cancellation', () => {
  const dispatch = orchestrator.slice(orchestrator.indexOf('async function dispatchWorkers'), orchestrator.indexOf('async function abortMigrationWorkers'))
  const stale = dispatch.slice(dispatch.indexOf('const heartbeatStale'))
  assert.match(dispatch, /select options->>'workerEndpointRecoveryUntil' recovery_until/)
  assert.match(stale, /if \(endpointRecoveryGrace\) \{\s*agentOccupancy \+= 1\s*continue\s*\}/)
  assert.ok(stale.indexOf('if (endpointRecoveryGrace)') < stale.indexOf('/cancel`'))
})

test('one unfinished bucket cannot prevent finished buckets entering verification', async () => {
  const source = orchestrator.slice(orchestrator.indexOf('async function ensureBucketVerification'), orchestrator.indexOf('async function finalizeVerifiedBuckets'))
  const { ensureBucketVerification } = load(source, ['ensureBucketVerification'])
  const queries = []
  const db = { query: async (sql, values) => {
    queries.push({ sql, values })
    if (sql.includes('select i.id,coalesce')) return { rows: [{ id: 'done', ready: true }, { id: 'copying', ready: false }] }
    if (sql.startsWith('select 1 from drive_migration_verification_state')) return { rows: [{}], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  } }
  await ensureBucketVerification(db, { id: 'migration' }, 1)
  const resets = queries.filter(q => q.sql.startsWith("update drive_migration_verification_state set status='blocked'"))
  assert.ok(resets.length > 0)
  for (const reset of resets) assert.equal(JSON.stringify(reset.values[2]), '["copying"]')
  const pending = queries.find(q => q.sql.startsWith("update drive_migration_verification_state set status='pending'"))
  assert.equal(JSON.stringify(pending.values[2]), '["done"]')
  assert.ok(queries.some(q => q.sql.includes('insert into drive_migration_verification_state')))
  assert.equal(queries.at(-1).sql, 'commit')
})

test('worker shares quota cooldown between API calls and accepts HTML provider failures', async () => {
  const runtime = fs.readFileSync('workers/migration-worker/migration-worker.mjs', 'utf8')
  const source = 'let apiBlockedUntil = 0;\n' + runtime.slice(runtime.indexOf('async function api('), runtime.indexOf('async function heartbeat('))
  let now = 0, requests = 0
  const waits = []
  const { api } = load(source, ['api'], {
    Date: { now: () => now }, AbortController, setTimeout, clearTimeout,
    API_TIMEOUT_MS: 30000, API_RETRIES: 1, SERVER_URL: 'https://worker.example',
    WorkerAuthenticationError: class extends Error {},
    withRetries: async (_label, fn) => fn(),
    sleep: async ms => { waits.push(ms); now += ms },
    fetch: async () => {
      requests++
      return { ok: requests > 1, status: requests > 1 ? 200 : 429, headers: { get: () => null },
        text: async () => requests > 1 ? '{"ok":true}' : '<h1>Error 1027</h1>' }
    },
  })
  await assert.rejects(api('/claim', {}), /daily request limit reached/)
  const result = await api('/heartbeat', {})
  assert.equal(result.ok, true)
  assert.equal(requests, 2)
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 300000)
})

test('worker rejects malformed success responses and respects Retry-After', async () => {
  const runtime = fs.readFileSync('workers/migration-worker/migration-worker.mjs', 'utf8')
  const source = 'let apiBlockedUntil = 0;\n' + runtime.slice(runtime.indexOf('async function api('), runtime.indexOf('async function heartbeat('))
  for (const [status, body, retryAfter, expectedWait] of [
    [200, '<html>Proxy unavailable</html>', null, 30000],
    [200, 'null', null, 30000],
    [200, '{"ok":false}', null, 30000],
    [429, 'null', '120', 120000],
    [503, '{}', 'Thu, 01 Jan 1970 00:02:00 GMT', 120000],
  ]) {
    let now = 0, requests = 0
    const { api } = load(source, ['api'], {
      Date: { now: () => now, parse: Date.parse }, AbortController, setTimeout, clearTimeout,
      API_TIMEOUT_MS: 30000, API_RETRIES: 1, SERVER_URL: 'https://worker.example',
      WorkerAuthenticationError: class extends Error {},
      withRetries: async (_label, fn) => fn(), sleep: async ms => { now += ms },
      fetch: async () => {
        requests++
        return { ok: requests > 1 || status === 200, status, headers: { get: () => retryAfter }, text: async () => requests > 1 ? '{"ok":true}' : body }
      },
    })
    await assert.rejects(api('/claim', {}))
    assert.equal((await api('/heartbeat', {})).ok, true)
    assert.equal(now, expectedWait)
  }
})
