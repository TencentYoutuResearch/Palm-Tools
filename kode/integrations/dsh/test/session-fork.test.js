import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, Session } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as factoryPlugin from '../src/native-agent-factory.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { HISTORY_CONTEXT_BYTES, editedMessage, historyEditSurface } from '../src/history-edit.js'
import { extractForkSource, forkHistoryInput } from '../src/session-fork.js'
import { hostOperation } from '../src/workspace-directory.js'

const codexFixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
const acpFixture = fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))

async function load(ctx, plugin, ...args) {
  const fiber = await ctx.plugin(plugin, ...args)
  await fiber.await?.()
  return fiber
}

const msg = (id, text) => ({ id, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text }] })

function buildCodexProfile(log, env = {}) {
  return {
    id: 'fixture-codex',
    name: 'Codex fixture',
    type: 'codex',
    executable: process.execPath,
    args: [codexFixture],
    env: { KODE_FIXTURE_RPC_LOG: log, ...env },
  }
}

function buildAcpProfile(id, type, log, env = {}) {
  return {
    id,
    name: `${type} fixture`,
    type,
    executable: process.execPath,
    args: [acpFixture],
    env: { KODE_ACP_FIXTURE_LOG: log, ...env },
  }
}

async function createHost({ profiles, adapter, official = false, resolveProfile } = {}) {
  const ctx = new Context()
  const stored = new Map()
  const writers = new Map()
  const createCalls = []
  const errors = []
  await load(ctx, SessionStore)
  await load(ctx, AgentRegistry)
  await load(ctx, ProjectionRegistry)
  ctx.provide('tools', { schemas: () => [], resolve: async () => ({ tools: [], schemas: [], dispose() {} }) })
  ctx.provide('agentPresets', { register: async () => () => {} })

  const makeHandle = (row, write) => {
    const handle = {
      header: row.header,
      inheritedEventCount: row.inheritedEventCount ?? 0,
      read: async () => ({ events: [...row.events] }),
      append: async events => {
        assert.equal(events[0]?.seq ?? row.events.length, row.events.length)
        row.events.push(...events)
      },
      flush: async () => {},
      close: async () => { if (writers.get(row.header.id) === handle) writers.delete(row.header.id) },
    }
    if (write) {
      if (writers.has(row.header.id)) throw new Error('already owned')
      writers.set(row.header.id, handle)
    }
    return handle
  }

  ctx.provide('sessionPersistence', {
    create: async (header, opts = {}) => {
      if (stored.has(header.id)) throw new Error('already exists')
      createCalls.push({ header, opts })
      const events = opts.parentSource?.events ? [...opts.parentSource.events] : []
      const row = { header, inheritedEventCount: opts.inheritedEventCount ?? 0, events }
      stored.set(header.id, row)
      return makeHandle(row, true)
    },
    open: async (id, access) => {
      if (!stored.has(id)) throw new Error('not found')
      return makeHandle(stored.get(id), access === 'write')
    },
  })
  ctx.on('session/event', (session, event) => {
    const row = stored.get(session.id)
    if (row && writers.has(session.id)) {
      assert.equal(event.seq, row.events.length)
      row.events.push(event)
    }
  })
  ctx.on('session/flush', async () => {})
  ctx.on('agent/error', payload => errors.push(payload.error))

  const runtime = adapter ?? new AgentRuntimeAdapter(ctx, profiles, {
    cwd: () => '/tmp',
    policy: () => ({ mode: 'workspace-write', workspaceRoot: '/tmp' }),
    approvalPolicy: () => 'never',
    ...(resolveProfile ? { resolveProfile } : {}),
  })
  ctx.provide('kodeAgents', { adapter: runtime, profiles, recordBinding: () => {} })

  if (official) {
    await load(ctx, LlmRuntime)
    await load(ctx, SystemPrompt)
    await load(ctx, AgentLoop, { agents: [], maxParallelToolCalls: 10 })
  } else {
    ctx.agents.setFactory({ createAgent() { throw new Error('official create') }, resume() { throw new Error('official resume') } })
    ctx.provide('agentLoop', {})
  }

  const fiber = await load(ctx, factoryPlugin)
  return { ctx, stored, writers, createCalls, errors, runtime, fiber, close: async () => { await runtime.close(); await ctx.fiber.dispose() } }
}

async function forkLikeController(ctx, parentId, childId, { atSeq, globalDefault = { provider: 'openai', model: 'gpt-5' }, cwd = '/tmp', agentPreset } = {}) {
  const live = ctx.sessions.get(parentId)
  assert.ok(live, 'parent session must be active')
  const events = live.snapshotEvents()
  const boundary = atSeq ?? events.findLast(event => event.type === 'turn/end')?.seq
  assert.ok(boundary !== undefined, 'parent must have a completed turn')
  const seed = buildForkSeed(events, boundary)
  const endSeq = boundary + 1
  const preset = agentPreset ?? live.header.agentPreset
  const created = await ctx.agents.create({
    sessionId: childId,
    seed,
    parentSource: { sessionId: parentId, endSeq },
    inheritedEventCount: endSeq,
    meta: { cwd, isSeeded: true, ...(preset ? { agentPreset: preset } : {}) },
    agentOptions: globalDefault,
  })
  return { ...created, boundary, endSeq }
}

async function readLog(path) {
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.trim() ? raw.trim().split('\n').map(JSON.parse) : []
}

function turnEndSeqs(session) {
  return session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.seq)
}

test('fork routing preserves native vs official ownership independent of global default model and persists V4 parentSource', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-routing-'))
  const log = join(root, 'codex.jsonl')
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = buildCodexProfile(log)
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([profile])
  const h = await createHost({ profiles, official: true })
  t.after(() => h.close())

  // 1. Native Kode session forked when global default is a non-Kode model
  const { agent: nativeParent } = await h.ctx.agents.create({
    sessionId: 'native-parent',
    agentOptions: { provider: profileRoute(profile.id), model: 'fixture', reasoningEffort: 'high' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  nativeParent.followup(msg('u1', 'First native turn'))
  await nativeParent.whenIdle()
  assert.equal(profiles.binding('native-parent').threadId, 'same-native-id')

  const { agent: nativeChild, endSeq } = await forkLikeController(h.ctx, 'native-parent', 'native-child', {
    globalDefault: { provider: 'openai', model: 'gpt-4o' },
    cwd: root,
  })
  assert.equal(nativeChild.constructor.name, 'NativeAgentDriver')
  assert.equal(nativeChild.options.provider, profileRoute(profile.id))
  assert.equal(nativeChild.options.model, 'fixture')
  assert.equal(nativeChild.options.reasoningEffort, 'high')

  const createCall = h.createCalls.find(call => call.header.id === 'native-child')
  assert.ok(createCall.opts.parentSource)
  assert.equal(createCall.opts.parentSource.sessionId, 'native-parent')
  assert.equal(createCall.opts.parentSource.endSeq, endSeq)
  assert.equal(createCall.opts.inheritedEventCount, endSeq)
  assert.equal(h.stored.get('native-child').events.length, createCall.opts.parentSource.events.length)
  assert.doesNotThrow(() => assertReleasedV4Relationships({
    header: nativeChild.session.header,
    events: h.stored.get('native-child').events,
    inheritedEventCount: endSeq,
  }, KNOWN_SESSION_EVENT_TYPES))

  const childBinding = profiles.binding('native-child')
  assert.equal(childBinding.threadId, undefined)
  assert.equal(childBinding.forkPending, true)
  assert.deepEqual(childBinding.seenInputs, ['u1'])
  assert.equal(childBinding.forkSource.sessionId, 'native-parent')
  assert.equal(childBinding.forkSource.threadId, 'same-native-id')
  assert.ok(childBinding.forkSource.lastNativeTurnId)

  // 2. Non-Kode official session forked when global default is Kode must NOT be hijacked
  const { agent: officialParent } = await h.ctx.agents.create({
    sessionId: 'official-parent',
    agentOptions: { provider: 'openai', model: 'gpt-4o' },
    meta: { cwd: root, agentPreset: 'default' },
  })
  officialParent.session.append('model/selection', { provider: 'openai', model: 'gpt-4o' })
  officialParent.session.append('turn/start', { turn: 1 })
  officialParent.session.append('step/start', { turn: 1, step: 1 })
  officialParent.session.append('user/message', msg('ou1', 'Hello official'), { surfaceOp: 'append' })
  officialParent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'oa1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-4o' }, content: [{ type: 'text', text: 'Hi from official' }] }, finishReason: { kind: 'stop' }, interrupted: false }, { surfaceOp: 'append' })
  officialParent.session.append('step/end', { turn: 1, step: 1 })
  officialParent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const { agent: officialChild } = await forkLikeController(h.ctx, 'official-parent', 'official-child', {
    globalDefault: { provider: profileRoute(profile.id), model: 'fixture' },
    cwd: root,
    agentPreset: 'default',
  })
  assert.notEqual(officialChild.constructor.name, 'NativeAgentDriver')
  assert.equal(profiles.binding('official-child'), undefined)

  // 3. Unload fail-closed sentinel blocks forked Kode child when Kode plugin is reloading
  const parentEvents = nativeParent.session.snapshotEvents()
  const parentBoundary = parentEvents.findLast(event => event.type === 'turn/end').seq
  await h.fiber.dispose()
  await assert.rejects(() => h.ctx.agents.create({
    sessionId: 'native-child-reloading',
    seed: buildForkSeed(parentEvents, parentBoundary),
    parentSource: { sessionId: 'native-parent', endSeq: parentBoundary + 1 },
    inheritedEventCount: parentBoundary + 1,
    meta: { cwd: root, isSeeded: true, agentPreset: 'kode-native' },
    agentOptions: { provider: 'openai', model: 'gpt-4o' },
  }), /正在重载/)
})

test('Codex native thread/fork cuts precisely at lastTurnId even after parent advances and keeps parent untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-codex-'))
  const log = join(root, 'codex.jsonl')
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = buildCodexProfile(log, { KODE_FIXTURE_UNIQUE_THREAD: '1' })
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([profile])
  const h = await createHost({ profiles })
  t.after(() => h.close())

  const { agent: parent } = await h.ctx.agents.create({
    sessionId: 'codex-parent',
    agentOptions: { provider: profileRoute(profile.id), model: 'fixture' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parent.followup(msg('u1', 'Turn one'))
  await parent.whenIdle()
  const turn1End = turnEndSeqs(parent.session)[0]
  parent.followup(msg('u2', 'Turn two'))
  await parent.whenIdle()
  const parentThreadId = profiles.binding('codex-parent').threadId

  // Fork at turn 1 (mid-history)
  const { agent: child } = await forkLikeController(h.ctx, 'codex-parent', 'codex-child-mid', { atSeq: turn1End, cwd: root })
  // Also fork at latest (turn 2), then advance parent with turn 3 BEFORE child prompts
  const { agent: childAfterAdvance } = await forkLikeController(h.ctx, 'codex-parent', 'codex-child-adv', { cwd: root })
  parent.followup(msg('u3', 'Turn three on parent'))
  await parent.whenIdle()

  // Prompt mid-history child
  child.followup(msg('c1', 'Explore branch A'))
  await child.whenIdle()
  const midBinding = profiles.binding('codex-child-mid')
  assert.equal(midBinding.forkPending, false)
  assert.equal(midBinding.forkBootstrap, false)
  assert.ok(midBinding.threadId && midBinding.threadId !== parentThreadId)
  assert.equal(midBinding.nativeToolNames, undefined) // ensures MCP proxy re-mounts on restart

  // Prompt child whose parent advanced after fork
  childAfterAdvance.followup(msg('c2', 'Explore branch B'))
  await childAfterAdvance.whenIdle()

  const rows = await readLog(log)
  const forks = rows.filter(row => row.method === 'thread/fork')
  assert.equal(forks.length, 2)
  assert.equal(forks[0].params.threadId, parentThreadId)
  assert.equal(forks[0].params.lastTurnId, 'turn-1')
  assert.equal(forks[0].params.excludeTurns, true)
  assert.equal(forks[1].params.threadId, parentThreadId)
  assert.equal(forks[1].params.lastTurnId, 'turn-2')

  const childTurns = rows.filter(row => row.method === 'turn/start' && row.params.threadId === midBinding.threadId)
  assert.equal(childTurns.length, 1)
  assert.equal(childTurns[0].params.input.length, 1)
  assert.equal(childTurns[0].params.input[0].text, 'Explore branch A')
  assert.equal(rows.some(row => row.method === 'thread/revert' && row.params.threadId === parentThreadId), false)
})

test('Codex legacy fallback: rejects lastTurnId -> forks and reverts only child thread; unsupported -> bounded 12 KiB bootstrap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-codex-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  // Sub-case A: server rejects lastTurnId, supports thread/fork + thread/revert on child
  const logA = join(root, 'codex-a.jsonl')
  const profileA = buildCodexProfile(logA, {
    KODE_FIXTURE_FORK_MODE: 'no-last-turn-id',
    KODE_FIXTURE_HISTORY_REVERT: 'current',
    KODE_FIXTURE_FORK_ID: 'child-reverted-thread',
  })
  const profilesA = await new AgentProfiles(join(root, 'profiles-a.json')).open([profileA])
  const hA = await createHost({ profiles: profilesA })
  t.after(() => hA.close())

  const { agent: parentA } = await hA.ctx.agents.create({
    sessionId: 'parent-a',
    agentOptions: { provider: profileRoute(profileA.id), model: 'fixture' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parentA.followup(msg('u1', 'Keep me'))
  await parentA.whenIdle()
  const turn1End = turnEndSeqs(parentA.session)[0]
  parentA.followup(msg('u2', 'After fork'))
  await parentA.whenIdle()

  const { agent: childA } = await forkLikeController(hA.ctx, 'parent-a', 'child-a', { atSeq: turn1End, cwd: root })
  childA.followup(msg('c1', 'Continue after revert'))
  await childA.whenIdle()

  const rowsA = await readLog(logA)
  const reverts = rowsA.filter(r => r.method === 'thread/revert')
  assert.equal(reverts.length, 1)
  assert.equal(reverts[0].params.threadId, 'child-reverted-thread')
  assert.equal(reverts[0].params.beforeTurnId, 'turn-2')
  assert.equal(profilesA.binding('child-a').threadId, 'child-reverted-thread')
  assert.equal(profilesA.binding('child-a').forkBootstrap, false)

  // Sub-case B: Codex server does not implement thread/fork (-32601) -> graceful bounded bootstrap
  const logB = join(root, 'codex-b.jsonl')
  const profileB = buildCodexProfile(logB, { KODE_FIXTURE_FORK_MODE: 'unsupported', KODE_FIXTURE_UNIQUE_THREAD: '1' })
  const profilesB = await new AgentProfiles(join(root, 'profiles-b.json')).open([profileB])
  const hB = await createHost({ profiles: profilesB })
  t.after(() => hB.close())

  const { agent: parentB } = await hB.ctx.agents.create({
    sessionId: 'parent-b',
    agentOptions: { provider: profileRoute(profileB.id), model: 'fixture' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parentB.followup(msg('u1', 'Context fact 42'))
  await parentB.whenIdle()

  const { agent: childB } = await forkLikeController(hB.ctx, 'parent-b', 'child-b', { cwd: root })
  childB.followup(msg('c1', 'First child prompt'))
  await childB.whenIdle()
  childB.followup(msg('c2', 'Second child prompt'))
  await childB.whenIdle()

  const rowsB = await readLog(logB)
  const childBThread = profilesB.binding('child-b').threadId
  const childBTurns = rowsB.filter(r => r.method === 'turn/start' && r.params.threadId === childBThread)
  assert.equal(childBTurns.length, 2)
  assert.equal(childBTurns[0].params.input.length, 2)
  assert.match(childBTurns[0].params.input[0].text, /Context fact 42/)
  assert.equal(childBTurns[0].params.input[1].text, 'First child prompt')
  assert.equal(childBTurns[1].params.input.length, 1)
  assert.equal(childBTurns[1].params.input[0].text, 'Second child prompt')
})

test('Claude ACP native session/fork: direct at latest with returned state, and mid-history checkpoint with duplicate occurrence disambiguation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-claude-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  // Sub-case A: Latest fork with returned modes/configOptions (no extra session/load!)
  const logLatest = join(root, 'claude-latest.jsonl')
  const profileLatest = buildAcpProfile('claude-latest', 'claude', logLatest, {
    KODE_ACP_FORK_AT: '1',
    KODE_ACP_FORK_RETURNS_STATE: '1',
    KODE_ACP_FORK_ID: 'claude-branch-latest',
  })
  const profilesLatest = await new AgentProfiles(join(root, 'profiles-latest.json')).open([profileLatest])
  const hLatest = await createHost({ profiles: profilesLatest, resolveProfile: async p => ({ ...p, type: 'custom', protocol: 'acp' }) })
  t.after(() => hLatest.close())

  const { agent: parentLatest } = await hLatest.ctx.agents.create({
    sessionId: 'claude-parent-latest',
    agentOptions: { provider: profileRoute(profileLatest.id), model: 'fixture-fast' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parentLatest.followup(msg('u1', 'Initial question'))
  await parentLatest.whenIdle()

  const { agent: childLatest } = await forkLikeController(hLatest.ctx, 'claude-parent-latest', 'claude-child-latest', { cwd: root })
  childLatest.followup(msg('c1', 'Branch latest question'))
  await childLatest.whenIdle()

  const latestRows = await readLog(logLatest)
  const latestFork = latestRows.find(r => r.method === 'session/fork')
  assert.ok(latestFork)
  assert.equal(latestFork.params.sessionId, 'same-native-session')
  assert.equal(latestFork.params._meta?.jetbrains, undefined) // direct latest fork
  assert.equal(latestRows.some(r => r.method === 'session/load'), false)
  assert.equal(profilesLatest.binding('claude-child-latest').threadId, 'claude-branch-latest')
  const latestPrompt = latestRows.find(r => r.method === 'session/prompt' && r.params.sessionId === 'claude-branch-latest')
  assert.equal(latestPrompt.params.prompt.length, 1)
  assert.equal(latestPrompt.params.prompt[0].text, 'Branch latest question')

  // Sub-case B: Mid-history fork with duplicate assistant text disambiguated by occurrence & nextUserText
  const logMid = join(root, 'claude-mid.jsonl')
  const replayRows = [
    ['user', 'u-1', 'Say ok'],
    ['agent', 'a-1', 'acp: Say ok'],
    ['user', 'u-2', 'Say ok'],
    ['agent', 'a-2', 'acp: Say ok'],
    ['user', 'u-3', 'Future question'],
    ['agent', 'a-3', 'acp: Future question'],
  ]
  const profileMid = buildAcpProfile('claude-mid', 'claude', logMid, {
    KODE_ACP_FORK_AT: '1',
    KODE_ACP_FORK_RETURNS_STATE: '1',
    KODE_ACP_FORK_ID: 'claude-branch-mid',
    KODE_ACP_REPLAY_ROWS: JSON.stringify(replayRows),
  })
  const profilesMid = await new AgentProfiles(join(root, 'profiles-mid.json')).open([profileMid])
  const hMid = await createHost({ profiles: profilesMid, resolveProfile: async p => ({ ...p, type: 'custom', protocol: 'acp' }) })
  t.after(() => hMid.close())

  const { agent: parentMid } = await hMid.ctx.agents.create({
    sessionId: 'claude-parent-mid',
    agentOptions: { provider: profileRoute(profileMid.id), model: 'fixture-fast' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parentMid.followup(msg('u1', 'Say ok'))
  await parentMid.whenIdle()
  parentMid.followup(msg('u2', 'Say ok'))
  await parentMid.whenIdle()
  const turn2End = turnEndSeqs(parentMid.session)[1]
  parentMid.followup(msg('u3', 'Future question'))
  await parentMid.whenIdle()

  const { agent: childMid } = await forkLikeController(hMid.ctx, 'claude-parent-mid', 'claude-child-mid', { atSeq: turn2End, cwd: root })
  childMid.followup(msg('c2', 'Diverge after second ok'))
  await childMid.whenIdle()

  const midRows = await readLog(logMid)
  const midFork = midRows.find(r => r.method === 'session/fork')
  assert.ok(midFork)
  assert.equal(midFork.params._meta?.jetbrains?.air?.fork?.messageId, 'a-2')
  assert.equal(midFork.params._meta?.jetbrains?.air?.fork?.messageOccurrence, 2)
  assert.match(midFork.params._meta?.jetbrains?.air?.fork?.messageFingerprint, /^sha256:[0-9a-f]{64}$/)
  assert.equal(profilesMid.binding('claude-child-mid').threadId, 'claude-branch-mid')
  const midPrompt = midRows.find(r => r.method === 'session/prompt' && r.params.sessionId === 'claude-branch-mid')
  assert.equal(midPrompt.params.prompt.length, 1)
  assert.equal(midPrompt.params.prompt[0].text, 'Diverge after second ok')
})

test('Generic ACP with sessionCapabilities.fork uses native fork at latest, but falls back to bounded bootstrap mid-history so future turns never leak', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-generic-acp-'))
  const log = join(root, 'acp.jsonl')
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = buildAcpProfile('custom-fork-acp', 'custom', log, {
    KODE_ACP_FORK_AT: '1',
    KODE_ACP_FORK_ID: 'generic-forked-session',
  })
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([profile])
  const h = await createHost({ profiles })
  t.after(() => h.close())

  const { agent: parent } = await h.ctx.agents.create({
    sessionId: 'gen-parent',
    agentOptions: { provider: profileRoute(profile.id), model: 'fixture-fast' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parent.followup(msg('u1', 'Keep only this'))
  await parent.whenIdle()
  const turn1End = turnEndSeqs(parent.session)[0]

  // At latest (parent unchanged) -> uses standard ACP session/fork, then loads returned sessionId
  const { agent: childLatest } = await forkLikeController(h.ctx, 'gen-parent', 'gen-child-latest', { cwd: root })
  childLatest.followup(msg('c-latest', 'Continue at latest'))
  await childLatest.whenIdle()
  assert.equal(profiles.binding('gen-child-latest').threadId, 'generic-forked-session')

  // Advance parent, then fork at turn 1 -> MUST NOT call generic session/fork (would leak turn 2!)
  parent.followup(msg('u2', 'SECRET_FUTURE_TURN'))
  await parent.whenIdle()
  const { agent: childMid } = await forkLikeController(h.ctx, 'gen-parent', 'gen-child-mid', { atSeq: turn1End, cwd: root })
  childMid.followup(msg('c-mid', 'Branch from turn 1'))
  await childMid.whenIdle()

  const rows = await readLog(log)
  const forkCalls = rows.filter(r => r.method === 'session/fork')
  assert.equal(forkCalls.length, 1) // ONLY childLatest called session/fork!
  const midPrompt = rows.filter(r => r.method === 'session/prompt').at(-1)
  assert.equal(midPrompt.params.prompt.length, 2)
  assert.match(midPrompt.params.prompt[0].text, /Keep only this/)
  assert.doesNotMatch(midPrompt.params.prompt[0].text, /SECRET_FUTURE_TURN/)
  assert.equal(midPrompt.params.prompt[1].text, 'Branch from turn 1')
})

test('ACP without fork capability (CodeBuddy/Cursor) injects bounded 12 KiB history once and continues natively', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-nofork-'))
  const log = join(root, 'codebuddy.jsonl')
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = buildAcpProfile('codebuddy-fixture', 'codebuddy', log)
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([profile])
  const h = await createHost({ profiles })
  t.after(() => h.close())

  const { agent: parent } = await h.ctx.agents.create({
    sessionId: 'cb-parent',
    agentOptions: { provider: profileRoute(profile.id), model: 'fixture-fast' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parent.followup(msg('u1', 'Large background ' + 'x'.repeat(20_000)))
  await parent.whenIdle()
  parent.followup(msg('u2', 'Recent context fact'))
  await parent.whenIdle()

  const { agent: child } = await forkLikeController(h.ctx, 'cb-parent', 'cb-child', { cwd: root })
  const preview = forkHistoryInput(child.session)
  assert.equal(preview.length, 1)
  assert.ok(Buffer.byteLength(preview[0].text) <= HISTORY_CONTEXT_BYTES)
  assert.match(preview[0].text, /Recent context fact/)

  child.followup(msg('c1', 'First question on branch'))
  await child.whenIdle()
  child.followup(msg('c2', 'Follow-up on branch'))
  await child.whenIdle()

  const rows = await readLog(log)
  assert.equal(rows.some(r => r.method === 'session/fork'), false)
  const prompts = rows.filter(r => r.method === 'session/prompt')
  const firstChildPrompt = prompts[2]
  const secondChildPrompt = prompts[3]
  assert.equal(firstChildPrompt.params.prompt.length, 2)
  assert.ok(Buffer.byteLength(firstChildPrompt.params.prompt[0].text) <= HISTORY_CONTEXT_BYTES)
  assert.match(firstChildPrompt.params.prompt[0].text, /Recent context fact/)
  assert.equal(firstChildPrompt.params.prompt[1].text, 'First question on branch')
  assert.equal(secondChildPrompt.params.prompt.length, 1)
  assert.equal(secondChildPrompt.params.prompt[0].text, 'Follow-up on branch')
})

test('fork-of-a-fork before first prompt, restart before first prompt, and pre-first-turn history edit on forked child', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fork-edge-'))
  const log = join(root, 'codex-edge.jsonl')
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = buildCodexProfile(log, { KODE_FIXTURE_UNIQUE_THREAD: '1' })
  const profilesPath = join(root, 'profiles.json')
  let profiles = await new AgentProfiles(profilesPath).open([profile])
  const h = await createHost({ profiles })
  t.after(() => h.close())

  const { agent: parent } = await h.ctx.agents.create({
    sessionId: 'edge-parent',
    agentOptions: { provider: profileRoute(profile.id), model: 'fixture' },
    meta: { cwd: root, agentPreset: 'kode-native' },
  })
  parent.followup(msg('u1', 'Origin turn 1'))
  await parent.whenIdle()
  const turn1End = turnEndSeqs(parent.session)[0]
  parent.followup(msg('u2', 'Origin turn 2'))
  await parent.whenIdle()
  const parentThread = profiles.binding('edge-parent').threadId

  // 1. Fork A -> B, then immediately fork B -> C (at turn 1) BEFORE B runs anything
  const { agent: childB } = await forkLikeController(h.ctx, 'edge-parent', 'edge-child-b', { cwd: root })
  const { agent: childC } = await forkLikeController(h.ctx, 'edge-child-b', 'edge-child-c', { atSeq: turn1End, cwd: root })
  assert.equal(profiles.binding('edge-child-c').forkSource.threadId, parentThread)
  assert.equal(profiles.binding('edge-child-c').forkSource.originSessionId, 'edge-parent')
  assert.equal(profiles.binding('edge-child-c').forkSource.lastNativeTurnId, 'turn-1')

  childC.followup(msg('cc1', 'Prompt on grandchild'))
  await childC.whenIdle()
  const rows1 = await readLog(log)
  const grandFork = rows1.find(r => r.method === 'thread/fork')
  assert.equal(grandFork.params.threadId, parentThread)
  assert.equal(grandFork.params.lastTurnId, 'turn-1')

  // 2. In-place edit on forked child BEFORE its first prompt must NEVER revert parent thread
  const { agent: childD } = await forkLikeController(h.ctx, 'edge-parent', 'edge-child-d', { cwd: root })
  const targetEvent = childD.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.content[0].text === 'Origin turn 2')
  const edited = { ...editedMessage(childD.session.snapshotEvents(), targetEvent.seq, 'Edited turn 2 on child D'), id: 'edit-d-1' }
  childD.session.append('turn/start', { turn: 3 })
  childD.session.append('step/start', { turn: 3, step: 1 })
  childD.session.append('user/message', edited, historyEditSurface(childD.session, edited))
  childD.session.append('step/end', { turn: 3, step: 1 })
  childD.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

  childD.followup(msg('cd1', 'After edit on child D'))
  await childD.whenIdle()
  const rows2 = await readLog(log)
  assert.equal(rows2.some(r => r.method === 'thread/revert' && r.params.threadId === parentThread), false)
  const liveChildDBinding = h.runtime.profiles.binding('edge-child-d')
  assert.equal(liveChildDBinding.forkPending, false)
  assert.ok(liveChildDBinding.threadId && liveChildDBinding.threadId !== parentThread)

  // 3. Simulate restart for childB (persisted forkPending + forkSource reload from disk)
  await h.runtime.close()
  const reopened = await new AgentProfiles(profilesPath).open([profile])
  assert.equal(reopened.binding('edge-child-b').forkPending, true)
  assert.equal(reopened.binding('edge-child-b').forkSource.threadId, parentThread)
  assert.equal(reopened.binding('edge-child-b').forkSource.lastNativeTurnId, 'turn-2')
  assert.equal(reopened.binding('edge-child-d').forkPending, false)
})

test('hostOperation supports fork-session for unified/remote workspace directory', async () => {
  const calls = []
  const ctx = {
    get: name => name === 'sessionController' ? { fork: async req => { calls.push(req); return { sessionId: 'forked-remote' } } } : undefined,
  }
  const res = await hostOperation(ctx, { operation: 'fork-session', args: { sessionId: 'parent-1', atSeq: 12 } })
  assert.deepEqual(res, { sessionId: 'forked-remote' })
  assert.deepEqual(calls, [{ sessionId: 'parent-1', atSeq: 12, increaseTitle: true }])
})

test('extractForkSource handles empty parent binding gracefully', () => {
  const session = Session.create('p', [])
  const source = extractForkSource({ parentId: 'p', parentBinding: undefined, inheritedEvents: [], parentEvents: session.snapshotEvents() })
  assert.equal(source.threadId, null)
  assert.equal(source.lastNativeTurnId, null)
  assert.equal(source.claudeBoundary, null)
})
