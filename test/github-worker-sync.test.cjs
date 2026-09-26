/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { createHash } = require('node:crypto')
function load(file) {
  const filename = path.resolve(file)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = name => name.startsWith('./github-worker-') ? load(`src/lib/${name.slice(2)}.ts`) : require(name)
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
  return mod.exports
}
const { syncWorkerRepository } = load('src/lib/github-worker-sync.ts')
const workflowPath = '.github/workflows/migration-worker.yml'
const runtimePath = 'workers/migration-worker/'
const sourceSha = 'a'.repeat(40)
const initialSha = 'b'.repeat(40)
const mergedSha = 'c'.repeat(40)
const committedSha = 'd'.repeat(40)
function fixture(options = {}) {
  const blobs = new Map()
  const entry = (path, content) => {
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex')
    blobs.set(sha, content)
    return { path, sha, mode: '100644', type: 'blob' }
  }
  const sourceEntries = [
    entry(workflowPath, fs.readFileSync(workflowPath, 'utf8')),
    entry(runtimePath + 'package.json', 'current package'),
    entry(runtimePath + 'package-lock.json', 'current lock'),
    entry(runtimePath + 'migration-worker.mjs', 'current runtime'),
    entry('.drive-worker.json', JSON.stringify({ workflow: 'auto' })),
  ].filter(e => e.path !== options.missing)
  const selectedWorkflow = options.alias || workflowPath
  let targetEntries = sourceEntries.map(e => ({ ...e }))
  if (options.stale || options.merge) {
    targetEntries = targetEntries.filter(e => e.path !== runtimePath + 'migration-worker.mjs')
    targetEntries.push(entry(runtimePath + 'migration-worker.mjs', 'old runtime'))
  }
  if (options.alias) targetEntries.push(entry(options.alias, 'old custom workflow'))
  const unrelated = entry('personal.txt', 'preserve my personal file')
  targetEntries.push(unrelated)
  if (options.obsolete) targetEntries.push(entry(runtimePath + 'obsolete.js', 'delete stale worker file'))
  let targetSha = initialSha
  let behind = options.merge ? 2 : 0
  let currentSource = sourceSha
  let actionState = options.actionState || 'active'
  let actionsEnabled = !options.actionsDisabled
  let activated = false
  let nextTree
  let raced = false
  const calls = []
  const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status })
  const fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body) : undefined
    const method = init.method || 'GET'
    calls.push({ pathname, method, body })
    if (options.fail && options.fail(pathname, method)) return response({ message: 'denied' }, 403)
    if (pathname === '/repos/iamnadith/Drive') return response({ id: 1, default_branch: 'main' })
    if (pathname === '/repos/me/renamed') return response({ id: 2, default_branch: 'custom', source: options.copy ? undefined : { id: 1 }, archived: options.archived })
    const source = pathname.startsWith('/repos/iamnadith/Drive/')
    if (pathname.includes('/git/ref/heads/')) return response({ object: { sha: source ? currentSource : targetSha } })
    if (pathname.includes('/compare/')) return response({ behind_by: behind })
    if (pathname.endsWith('/merges')) {
      if (options.conflict) return response({ message: 'Merge conflict' }, 409)
      assert.equal(body.base, 'custom')
      assert.equal(body.head, sourceSha)
      behind = 0
      targetSha = mergedSha
      targetEntries = [...sourceEntries, unrelated]
      return response({ sha: targetSha })
    }
    if (pathname.includes('/git/commits/') && method === 'GET') return response({ sha: source ? currentSource : targetSha, tree: { sha: source ? 'source-tree' : 'target-tree' } })
    if (pathname.includes('/git/trees/') && method === 'GET') return response({ tree: source ? sourceEntries : targetEntries, truncated: options.truncated })
    if (pathname.includes('/git/blobs/') && method === 'GET') {
      const content = blobs.get(pathname.split('/').at(-1))
      assert.notEqual(content, undefined)
      return response({ encoding: 'base64', content: Buffer.from(content).toString('base64') })
    }
    if (pathname.endsWith('/git/blobs') && method === 'POST') return response(entry('unused', Buffer.from(body.content, 'base64').toString()))
    if (pathname.endsWith('/git/trees') && method === 'POST') {
      nextTree = targetEntries.filter(e => !body.tree.some(t => t.path === e.path))
      nextTree.push(...body.tree.filter(e => e.sha))
      return response({ sha: 'new-tree' })
    }
    if (pathname.endsWith('/git/commits') && method === 'POST') {
      assert.equal(body.parents[0], targetSha)
      return response({ sha: committedSha })
    }
    if (pathname.includes('/git/refs/heads/') && method === 'PATCH') {
      assert.equal(body.force, false)
      if (options.race && !raced) { raced = true; targetSha = 'e'.repeat(40); return response({ message: 'not a fast forward' }, 422) }
      targetSha = committedSha
      if (!options.corrupt) targetEntries = nextTree
      if (options.sourceMoves) currentSource = 'f'.repeat(40)
      return response({ object: { sha: targetSha } })
    }
    if (pathname.endsWith('/actions/permissions')) {
      if (options.permissionsDenied) return response({ message: 'Not Found' }, 404)
      if (method === 'PUT') { assert.deepEqual(body, { enabled: true, allowed_actions: 'selected' }); actionsEnabled = true; return response(null, 204) }
      return response({ enabled: actionsEnabled, allowed_actions: 'selected' })
    }
    if (pathname.endsWith('/actions/workflows')) return response({ workflows: options.numericWorkflow ? [{ id: 123, path: selectedWorkflow, state: actionState }] : [] })
    if (pathname.endsWith('/enable')) {
      if (options.neverIndexed) return response({ message: 'Not Found' }, 404)
      activated = true; actionState = 'active'; return response(null, 204)
    }
    if (pathname.includes('/actions/workflows/')) {
      if (!actionsEnabled || options.neverIndexed || (options.activateFirst && !activated) || (options.numericWorkflow && !pathname.endsWith('/123'))) return response({ message: 'Not Found' }, 404)
      return response({ path: selectedWorkflow, state: actionState })
    }
    throw new Error(`Unhandled ${method} ${pathname}`)
  }
  return { calls, fetch, entries: () => targetEntries, input: { token: 'test', owner: 'me', repo: 'renamed', workflow: selectedWorkflow } }
}
async function run(options, check) {
  const f = fixture(options)
  const original = global.fetch
  global.fetch = f.fetch
  try { await check(f) } finally { global.fetch = original }
}
test('current renamed fork is verified without a write and uses its actual default branch', () => run({}, async f => {
  assert.deepEqual(await syncWorkerRepository(f.input), { sourceSha, targetSha: initialSha, defaultBranch: 'custom' })
  assert.ok(f.calls.every(c => c.method === 'GET'))
}))
test('behind fork merges the configured source commit before returning a verified head', () => run({ merge: true }, async f => {
  assert.equal((await syncWorkerRepository(f.input)).targetSha, mergedSha)
  assert.equal(f.calls.filter(c => c.pathname.endsWith('/merges')).length, 1)
  assert.ok(!f.calls.some(c => c.method === 'PATCH'))
}))
test('renamed saved workflow and stale copied worker files are updated atomically, preserving other files', () => run({ copy: true, stale: true, alias: '.github/workflows/my-worker.yaml', obsolete: true }, async f => {
  assert.equal((await syncWorkerRepository(f.input)).targetSha, committedSha)
  assert.ok(!f.calls.some(c => c.pathname.endsWith('/merges')))
  assert.ok(f.entries().some(e => e.path === 'personal.txt'))
  assert.ok(!f.entries().some(e => e.path.endsWith('obsolete.js')))
  const canonical = f.entries().find(e => e.path === workflowPath)
  assert.equal(f.entries().find(e => e.path === f.input.workflow).sha, canonical.sha)
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1)
}))
test('local worker modifications are refreshed even if upstream is already an ancestor', () => run({ stale: true }, async f => {
  assert.equal((await syncWorkerRepository(f.input)).targetSha, committedSha)
  assert.ok(!f.calls.some(c => c.pathname.endsWith('/merges')))
}))
test('concurrent destination update retries from the new head without force pushing', () => run({ stale: true, race: true }, async f => {
  assert.equal((await syncWorkerRepository(f.input)).targetSha, committedSha)
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 2)
}))
test('source movement during synchronization is rechecked before success', () => run({ stale: true, sourceMoves: true }, async f => {
  assert.equal((await syncWorkerRepository(f.input)).sourceSha, 'f'.repeat(40))
}))
test('merge conflicts stop launches without forcing or replacing history', () => run({ merge: true, conflict: true }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /409.*Merge conflict/)
  assert.ok(!f.calls.some(c => c.method === 'PATCH'))
}))
test('branch protection or permission failures cannot report sync success', () => run({ stale: true, fail: (p, m) => m === 'PATCH' }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /403/)
}))
test('verification detects GitHub writes that did not produce the requested files', () => run({ stale: true, corrupt: true }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /did not match/)
}))
test('truncated source trees stop before any write', () => run({ truncated: true }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /incomplete/)
  assert.ok(f.calls.every(c => c.method === 'GET'))
}))
test('missing required source runtime stops before any write', () => run({ missing: runtimePath + 'package-lock.json' }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /missing package-lock/)
  assert.ok(f.calls.every(c => c.method === 'GET'))
}))
test('fork-disabled workflow is enabled and verified by filename before launch', () => run({ actionState: 'disabled_fork' }, async f => {
  await syncWorkerRepository(f.input)
  assert.ok(f.calls.some(c => c.pathname === '/repos/me/renamed/actions/workflows/migration-worker.yml/enable' && c.method === 'PUT'))
}))
test('manually disabled workflows remain blocked', () => run({ actionState: 'disabled_manually' }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /disabled/)
  assert.ok(!f.calls.some(c => c.method === 'PUT'))
}))
test('archived destination fails before writing', () => run({ archived: true }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /archived/)
  assert.ok(f.calls.every(c => c.method === 'GET'))
}))
test('every production dispatch path synchronizes before sending and pins the verified worker commit', () => {
  const panel = fs.readFileSync('src/app/api/agents/[id]/dispatch/route.ts', 'utf8')
  const worker = fs.readFileSync('workers/migration-orchestrator/src/index.ts', 'utf8')
  for (const code of [panel, worker]) {
    assert.ok(code.indexOf('await syncWorkerRepository(') < code.indexOf('/dispatches`'))
    assert.match(code, /code_ref: codeSync\.targetSha/)
    assert.match(code, /sourceCommit: codeSync\.sourceSha/)
  }
  assert.match(fs.readFileSync(workflowPath, 'utf8'), /ref: \$\{\{ github\.event\.client_payload\.code_ref \|\| github\.sha \}\}/)
})

test('queued dispatch does not contact GitHub dispatch when code sync fails', async () => {
  const vm = require('node:vm')
  const source = fs.readFileSync('workers/migration-orchestrator/src/index.ts', 'utf8')
  const functionSource = source.slice(source.indexOf('async function consumeDispatch('), source.indexOf('async function wakeFileScanner('))
  const intent = { id: 'intent', agent_id: 'agent', status: 'pending', github_token: 'token', github_repo_owner: 'me', github_repo_name: 'renamed', github_workflow_file: workflowPath, payload: { workerInstanceId: 'instance' } }
  for (const fail of [true, false]) {
    const queries = [], dispatches = []
    const db = { query: async (sql, values) => {
      queries.push({ sql, values })
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('select r.*')) return { rows: [intent] }
      return { rows: [] }
    } }
    const context = { exports: {}, Date, JSON, String, Number, Error, AbortSignal,
      database: async (env, operation) => operation(db),
      reconcileGitHubIntent: async () => false,
      syncWorkerRepository: async () => { if (fail) throw new Error('sync conflict'); return { sourceSha, targetSha: committedSha, defaultBranch: 'custom' } },
      GITHUB_WORKER_MAX_RUNTIME_SECONDS: 21300,
      fetch: async (url, options) => { dispatches.push({ url, body: JSON.parse(options.body) }); return { ok: true } },
    }
    vm.runInNewContext(ts.transpileModule(functionSource + '\nexports.consumeDispatch = consumeDispatch', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
    if (fail) {
      await assert.rejects(context.exports.consumeDispatch({}, 'intent', 1), /sync conflict/)
      assert.equal(dispatches.length, 0)
      assert.ok(queries.some(q => q.sql === 'rollback'))
      assert.ok(!queries.some(q => q.sql.includes("Submitting GitHub workflow dispatch")))
    } else {
      assert.equal(await context.exports.consumeDispatch({}, 'intent', 1), 'accepted')
      assert.equal(dispatches.length, 1)
      assert.equal(dispatches[0].body.client_payload.code_ref, committedSha)
      assert.ok(queries.some(q => q.values?.includes('custom')))
    }
  }
})

test('fresh fork with workflow files and disabled repository Actions is enabled before checking the workflow', () => run({ actionsDisabled: true, actionState: 'disabled_fork' }, async f => {
  await syncWorkerRepository(f.input)
  const enableRepository = f.calls.findIndex(c => c.pathname.endsWith('/actions/permissions') && c.method === 'PUT')
  const enableWorkflow = f.calls.findIndex(c => c.pathname.endsWith('/enable'))
  assert.ok(enableRepository >= 0 && enableWorkflow > enableRepository)
  assert.ok(!f.calls.some(c => c.pathname.endsWith('/dispatches')))
}))
test('unlisted fork workflow is activated directly rather than waiting before attempting enablement', () => run({ activateFirst: true }, async f => {
  await syncWorkerRepository(f.input)
  assert.ok(f.calls.some(c => c.pathname.endsWith('/enable') && c.method === 'PUT'))
}))
test('workflow filename lookup failure resolves the exact listed path by numeric ID', () => run({ numericWorkflow: true, actionState: 'disabled_fork' }, async f => {
  await syncWorkerRepository(f.input)
  assert.ok(f.calls.some(c => c.pathname.endsWith('/workflows/123/enable')))
}))
test('inaccessible Actions permissions report an actionable error rather than indexing pending', () => run({ neverIndexed: true, permissionsDenied: true }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /Reconnect GitHub.*administration and Actions access/)
}))
test('genuinely unindexed workflow stays blocked after activation is attempted', () => run({ neverIndexed: true }, async f => {
  await assert.rejects(syncWorkerRepository(f.input), /Actions is enabled, but has not exposed/)
  assert.ok(f.calls.some(c => c.pathname.endsWith('/enable')))
  assert.ok(!f.calls.some(c => c.pathname.endsWith('/dispatches')))
}))

test('scheduled tick only enqueues a durable scheduling cycle without opening the database', async () => {
  const vm = require('node:vm')
  const source = fs.readFileSync('workers/migration-orchestrator/src/index.ts', 'utf8')
  const method = source.slice(source.indexOf('  async scheduled('), source.indexOf('  async queue('))
  const context = { exports: {}, cycle: () => { throw new Error('cron must not run database cycle') } }
  vm.runInNewContext(ts.transpileModule('exports.handler = {' + method + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const messages = [], pending = []
  await context.exports.handler.scheduled({}, { GITHUB_DISPATCH_QUEUE: { send: async (body, options) => messages.push({ body, options }) } }, { waitUntil: promise => pending.push(promise) })
  await Promise.all(pending)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].body.control, 'cycle')
  assert.equal(messages[0].options.contentType, 'json')
  await assert.rejects(context.exports.handler.scheduled({}, { GITHUB_DISPATCH_QUEUE: { send: async () => { throw new Error('queue unavailable') } } }, { waitUntil: promise => pending.push(promise) }).then(() => Promise.all(pending)), /queue unavailable/)
})

test('newly registered fork reasserts repository and workflow activation even when GitHub reports active', () => run({}, async f => {
  await syncWorkerRepository({ ...f.input, activateActions: true })
  assert.ok(f.calls.some(c => c.pathname.endsWith('/actions/permissions') && c.method === 'PUT'))
  assert.ok(f.calls.some(c => c.pathname.endsWith('/workflows/migration-worker.yml/enable') && c.method === 'PUT'))
}))
test('registration activates and synchronizes before the workflow becomes eligible for automatic dispatch', () => {
  const route = fs.readFileSync('src/app/api/agents/route.ts', 'utf8')
  assert.ok(route.indexOf('await syncWorkerRepository({') < route.indexOf('await createAgent({'))
  assert.match(route, /activateActions: true/)
  assert.match(route, /githubRef = codeSync.defaultBranch/)
})
