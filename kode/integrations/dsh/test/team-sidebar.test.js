import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pure helpers only: bare UI imports resolve to an inert stub, nothing renders here.
const stub = { name: 'stub', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const any=new Proxy(function(){},{get:(t,k)=>k==="__esModule"?false:any,apply:()=>any});module.exports=any', loader: 'js' })) } }
const out = await build({ entryPoints: ['packages/collab/team-sidebar.js'], bundle: true, format: 'esm', platform: 'node', loader: { '.png': 'dataurl' }, plugins: [stub], write: false })
const dir = await mkdtemp(join(tmpdir(), 'team-sidebar-')), file = join(dir, 'team-sidebar.mjs')
await writeFile(file, out.outputFiles[0].text)
const { teamScope, draftScope, parseScope, sessionAddress, parseSessionAddress, sessionResourceProvider, createScopeSource, SIDEBAR_RETAIN_SOURCE } = await import(file)
test.after(() => rm(dir, { recursive: true, force: true }))

test('host scopes name exactly one real team or draft and nothing else', () => {
  assert.equal(teamScope({ id: 'team/a', home_hub: 'home' }), 'team/home/team%2Fa')
  assert.deepEqual(parseScope(teamScope({ id: 'team/a', home_hub: 'home' })), { kind: 'team', home_hub: 'home', team_id: 'team/a' })
  assert.deepEqual(parseScope(draftScope({ id: 'd1', home_hub: 'home' })), { kind: 'draft', home_hub: 'home', draft_id: 'd1' })
  for (const value of [teamScope({ id: '', home_hub: 'home' }), teamScope({ id: 'x' }), draftScope(null)]) assert.equal(value, undefined, 'no invented id')
  for (const value of ['', 'session/home/x', 'team/home', 'team/home/x/y', 'team/%E0/x', 'team//x', undefined]) assert.equal(parseScope(value), undefined, String(value))
  assert.notEqual(teamScope({ id: 'a', home_hub: 'h1' }), teamScope({ id: 'a', home_hub: 'h2' }), 'same id on another Hub is another scope')
})

test('session addresses round-trip and reject anything that is not one Session', () => {
  assert.equal(parseSessionAddress(sessionAddress('s 1/2')), 's 1/2')
  for (const value of ['dsh-resource://other/session/x', 'dsh-resource://kode-collab-session/session/', 'dsh-resource://kode-collab-session/session/a/b',
    'dsh-resource://kode-collab-session/session/a?x=1', 'https://kode-collab-session/session/a', 'not a url']) assert.equal(parseSessionAddress(value), undefined, value)
})

test('the session resource retains the real Session while held and releases it on abort', async () => {
  const rows = []
  const sessions = { retain(id, options) { const row = { id, source: options.source, released: false }; rows.push(row); return { release: () => { row.released = true } } } }
  const provider = sessionResourceProvider(sessions), controller = new AbortController()
  const stream = provider.open(sessionAddress('s1'), { signal: controller.signal })
  const first = await stream.next()
  assert.equal(first.value.ok, true); assert.equal(first.value.value.sessionId, 's1')
  assert.deepEqual(rows, [{ id: 's1', source: SIDEBAR_RETAIN_SOURCE, released: false }])
  const done = stream.next(); controller.abort()
  assert.equal((await done).done, true); assert.equal(rows[0].released, true)
  const bad = await sessionResourceProvider(sessions).open('dsh-resource://kode-collab-session/x', { signal: new AbortController().signal }).next()
  assert.equal(bad.value.ok, false); assert.equal(rows.length, 1, 'an invalid address retains nothing')
  const failing = { retain() { throw Error('gone') } }
  const failed = await sessionResourceProvider(failing).open(sessionAddress('s2'), { signal: new AbortController().signal }).next()
  assert.equal(failed.value.ok, false, 'a retain failure is a failure frame, never a throw')
})

test('the scope source publishes only real changes', () => {
  const source = createScopeSource(); let calls = 0
  source.subscribe(() => calls++)
  source.set('team/h/a'); source.set('team/h/a'); source.set(''); source.set(undefined)
  assert.equal(calls, 2); assert.equal(source.getSnapshot(), undefined)
})
