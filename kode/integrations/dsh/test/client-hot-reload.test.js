import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Context, Service } from '@deepseek-ai/cordis'
import { readAgentClientSource } from '../scripts/build-agent-client.js'

const source = await readAgentClientSource()
const start = source.indexOf("    ctx.slots.inject('tool.call.toolview', function* () {")
const end = source.indexOf("    ctx.effect(", start)

test('input adapters unload and reactivate through real Cordis service proxies', async () => {
  const ctx = new Context(), tracks = []
  ctx.provide('sessions', { sessionOf: () => ({ sessionId: 'hot-reload' }) })
  ctx.provide('remote', { commands: { list: async () => ({ ok: true, value: [] }) } })
  ctx.provide('slots', { inject() {} })
  class Controller extends Service {
    static inject = ['sessions']
    constructor(ctx) { super(ctx, 'testController') }
    track(...args) { this.ctx.sessions.sessionOf(); tracks.push(args) }
    dismiss() {}
    toggleSource() {}
  }
  class Input extends Service {
    static inject = ['testController']
    constructor(ctx) { super(ctx, 'inputTriggers') }
    sessionOf() { return this.ctx.testController }
    registerSource() { return () => {} }
  }
  class Commands extends Service {
    static inject = ['sessions']
    constructor(ctx) { super(ctx, 'commandUi') }
    async candidates() { this.ctx.sessions.sessionOf(); return [{ name: 'file' }] }
  }
  await ctx.plugin(Controller)
  await ctx.plugin(Input)
  await ctx.plugin(Commands)
  const scope = {
    transport: undefined,
    directory: () => ({ getSnapshot: () => ({ data: { currentProfile: { type: 'codex' } } }) }),
    fetchHost: async () => ({ ok: true, json: async () => ({ skills: [] }) }),
  }
  vm.runInNewContext(source.slice(source.indexOf('  const methodOf ='), source.indexOf('  let sharedTarget')), scope)
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const fiber = await ctx.plugin({
        inject: ['inputTriggers', 'commandUi', 'sessions', 'remote', 'slots', 'testController'],
        apply(child) { scope.installInputPresentation({ inject: (_deps, callback) => callback(child) }) },
      })
      ctx.inputTriggers.sessionOf(ctx).track('plain', 5, { tier: 'plain' }, cycle)
      await fiber.dispose()
      // Getter reads intentionally return different Proxy identities.
      assert.notEqual(ctx.inputTriggers.sessionOf, ctx.inputTriggers.sessionOf)
      assert.doesNotThrow(() => ctx.inputTriggers.sessionOf(ctx).track('restored', 8, { tier: 'plain' }, cycle))
      assert.equal((await ctx.commandUi.candidates())[0].name, 'file')
    }
    assert.equal(tracks.length, 6)
  } finally { await ctx.fiber.dispose() }
})

test('fork guard installs, deduplicates and unloads through real Cordis service proxies', async () => {
  const ctx = new Context(), opened = []
  let forks = 0
  class Sessions extends Service {
    constructor(ctx) { super(ctx, 'sessions') }
    async fork(options) { forks++; await null; options.onCreated?.('child'); throw new Error('fork child rename failed') }
  }
  class Ui extends Service {
    static inject = ['sessions']
    constructor(ctx) { super(ctx, 'uiWorkspace') }
    async forkSession(sessionId, onCreated) { return this.ctx.sessions.fork({ sessionId, onCreated }) }
    openSession(id) { opened.push(id) }
  }
  await ctx.plugin(Sessions)
  await ctx.plugin(Ui)
  const scope = { transport: undefined, refreshWorkspaceDirectory: async () => {}, console: { warn() {} } }
  vm.runInNewContext(source.slice(source.indexOf('  const methodOf ='), source.indexOf('  function installInputPresentation')), scope)
  try {
    for (let cycle = 1; cycle <= 3; cycle++) {
      const fiber = await ctx.plugin({ inject: ['sessions', 'uiWorkspace'], apply(child) {
        child.effect(() => scope.installForkGuard(child.sessions, child.uiWorkspace), 'test.fork-guard')
      } })
      assert.deepEqual(await Promise.all([ctx.uiWorkspace.forkSession('a'), ctx.uiWorkspace.forkSession('a')]), ['child', 'child'])
      assert.equal(forks, cycle * 2 - 1)
      await fiber.dispose()
      await assert.rejects(() => ctx.uiWorkspace.forkSession('a'), /rename failed/)
    }
    assert.equal(opened.length, 6)
  } finally { await ctx.fiber.dispose() }
})

for (const officialFirst of [true, false]) {
  test(`tool renderers survive repeated activation with official renderers ${officialFirst ? 'before' : 'after'} Kode`, () => {
    const entries = [], official = () => {}, kode = () => {}
    const register = (options, component) => {
      // DSH keyed seats reject duplicate (key, priority), independently of order.
      assert.equal(entries.some(entry => entry.options.key === options.key &&
        (entry.options.priority ?? 0) === (options.priority ?? 0)), false, `duplicate renderer: ${options.key}`)
      const entry = { options, component }
      entries.push(entry)
      return () => { const index = entries.indexOf(entry); if (index !== -1) entries.splice(index, 1) }
    }
    const activateOfficial = () => ['apply_patch', 'exec_command'].map(key => register({ key }, official))
    let disposeOfficial = officialFirst ? activateOfficial() : undefined
    const activateKode = () => {
      let disposers
      vm.runInNewContext(source.slice(start, end), {
        ctx: { slots: { register, inject: (_seat, callback) => { disposers = [...callback()] } } },
        MessagingTool: () => {}, NativeOperationTool: kode, NativeSubagentTool: kode,
      })
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const disposeKode = activateKode()
      disposeOfficial ??= activateOfficial()
      for (const key of ['apply_patch', 'exec_command']) {
        const matching = entries.filter(entry => entry.options.key === key)
        assert.equal(matching.length, 2)
        assert.equal(matching.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0].component, kode)
      }
      disposeKode()
      assert.equal(entries.length, 2, 'disabling Kode restores only the official renderers')
      assert.ok(entries.every(entry => entry.component === official))
    }
    for (const dispose of disposeOfficial) dispose()
    assert.equal(entries.length, 0)
  })
}

// Loader entries use the last declaration for a stable id. A separate transport
// id plus a disabled base entry leaves the client without its Connection while
// the bundle is replaced; downstream session/UI services then disappear.
test('bundle activation replaces the same Connection entry and removal restores the base', () => {
  const base = [{ insert: [{ id: 'connection', name: '@deepseek-ai/dsh-client-connection' }] }]
  const kode = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  for (const enabled of [false, true, false, true, false]) {
    const entries = new Map(composeEntries(enabled ? [base, kode] : [base]).map(row => [row.id, row]))
    const connection = entries.get('connection')
    assert.equal(Boolean(connection.disabled), false)
    assert.equal(connection.name, enabled ? '@kode/dsh-transport' : '@deepseek-ai/dsh-client-connection')
    assert.equal([...entries.values()].filter(row => row.name === '@kode/dsh-transport').length, enabled ? 1 : 0)
  }
})
