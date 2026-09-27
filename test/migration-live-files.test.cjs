const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function load(path) {
  const context = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return context.exports
}

test('pool bucket status describes transfer completion without verification or settings', () => {
  const { poolBucketTransferStatus } = load('src/lib/migration-pool-transfer-status.ts')
  const bucket = { status: 'running', totalObjects: 177, transferredObjects: 177, skippedObjects: 0, failedObjects: 0, queuedObjects: 0 }
  assert.equal(poolBucketTransferStatus(bucket), 'completed')
  assert.equal(poolBucketTransferStatus({ ...bucket, totalObjects: 6474, transferredObjects: 6471, queuedObjects: 1 }), 'running')
  assert.equal(poolBucketTransferStatus({ ...bucket, transferredObjects: 176, skippedObjects: 1 }), 'completed')
  for (const status of ['verifying', 'verification_failed', 'settings_syncing', 'settings_failed']) {
    assert.equal(poolBucketTransferStatus({ ...bucket, status }), 'completed')
    assert.equal(poolBucketTransferStatus({ ...bucket, status, transferredObjects: 176, queuedObjects: 1 }), 'queued')
  }
  assert.equal(poolBucketTransferStatus({ ...bucket, status: 'completed', transferredObjects: 176 }), 'pending')
  assert.equal(poolBucketTransferStatus({ ...bucket, status: 'aborted', transferredObjects: 176 }), 'aborted')
  assert.notEqual(poolBucketTransferStatus({ ...bucket, transferredObjects: 176, failedObjects: 1 }), 'completed')
  assert.notEqual(poolBucketTransferStatus({ ...bucket, transferredObjects: Infinity }), 'completed')
  assert.equal(poolBucketTransferStatus({ ...bucket, status: undefined, transferredObjects: 0 }), 'pending')
})

test('live activity excludes finished, stale, malformed and future-dated files', () => {
  const { currentMigrationFiles } = load('src/lib/migration-live-files.ts')
  const now = Date.parse('2026-09-26T12:00:00Z')
  const file = { key: 'video.mp4', status: 'copying', lastHeartbeatAt: new Date(now - 10000).toISOString() }
  const results = currentMigrationFiles([
    file,
    { ...file, status: 'completed' },
    { ...file, status: 'failed' },
    { ...file, status: 'skipped' },
    { ...file, lastHeartbeatAt: new Date(now - 90000).toISOString() },
    { ...file, lastHeartbeatAt: new Date(now + 1000000).toISOString() },
    { ...file, lastHeartbeatAt: 'invalid' },
    { ...file, key: '' },
  ], now)
  assert.equal(results.length, 1)
  assert.equal(results[0], file)
  assert.equal(currentMigrationFiles([file], now + 90000).length, 0)
})

test('migration stages use readable transfer terminology', () => {
  const { formatLogStage } = load('src/lib/dashboard-log-format.ts')
  assert.equal(formatLogStage('repair_copy', 'migration'), 'Transfer')
  assert.equal(formatLogStage('repair_copy', 'repair_only'), 'Repair copy')
  assert.equal(formatLogStage('repair_copy'), 'Repair copy')
  assert.equal(formatLogStage('repair_copy', 'move'), 'Move')
  assert.equal(formatLogStage('move_file'), 'Move file')
  assert.equal(formatLogStage('repair_verify', 'migration'), 'Verifying')
  assert.equal(formatLogStage('repair_copy · generation 2', 'migration'), 'Transfer · generation 2')
  assert.equal(formatLogStage('worker_dispatch'), 'Worker dispatch')
  assert.equal(formatLogStage('awaiting_independent_verification'), 'Waiting for verification')
  assert.equal(formatLogStage(''), '—')
})

test('live file query is separate from history and fenced to the active generation', () => {
  const route = fs.readFileSync('src/app/api/migrations/[id]/worker-pool/route.ts', 'utf8')
  const query = route.slice(route.indexOf('live_file_projection as ('), route.indexOf('recent_jobs as materialized'))
  assert.match(query, /j\.status in\('claimed','running'\)/)
  assert.match(query, /last_heartbeat_at>now\(\)-interval '90 seconds'/)
  assert.match(query, /\(select generation from selected_generation\)=\(select generation from migration_meta\)/)
  assert.match(query, /\(select status from migration_meta\) in\('running','verifying'\)/)
  assert.match(query, /progress->'currentFile'/)
  assert.doesNotMatch(query, /fileEvents|j\.result|limit 20/)
  assert.equal((route.match(/jobs: allJobs, liveFiles,/g) || []).length, 3)
})
