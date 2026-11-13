// 恢复编排纯决策层的用例。`sessions.ts` 顶层依赖 Tauri/svelte,Node 测试无法
// 直接 import,所以决策逻辑放在零依赖的 restore_plan.ts;这里覆盖
// dedupe / shared 认领 / runtime 拒绝 / 参数收窄 / progress / 收尾判定。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dedupePersistedTabs,
  finalizeRestore,
  planRestoreTabs,
  type EndpointIdLike,
  type RestoreTabInput,
  type SharedRow,
} from '../src/lib/restore_plan.ts'

const LOCAL: EndpointIdLike = { kind: 'local' }
const REMOTE: EndpointIdLike = { kind: 'remote', id: 'remote-one' }

function tab(overrides: Partial<RestoreTabInput> = {}): RestoreTabInput {
  return {
    backend_key: 'codebuddy',
    title: 'My tab',
    cwd: '/tmp/example-project',
    ...overrides,
  }
}

function shared(overrides: Partial<SharedRow> = {}): SharedRow {
  return {
    id: 7,
    backend_key: 'codebuddy',
    status: 'idle',
    runtime_session_id: 'other',
    ...overrides,
  }
}

const deps = {
  sanitizeModelName: (raw: string) => raw.trim(),
  localEndpoint: LOCAL,
}

test('dedupe keeps session_id-less tabs and separates endpoints', () => {
  const list = [
    tab({ session_id: null }),
    tab({ session_id: null }),
    tab({ session_id: 's', endpoint_id: LOCAL }),
    tab({ session_id: 's', endpoint_id: LOCAL }),
    tab({ session_id: 's', endpoint_id: REMOTE }),
  ]
  assert.equal(dedupePersistedTabs(list).length, 4)
})

test('shared owner claims by native_thread_id / runtime_session_id / dsh_session_id', () => {
  for (const row of [
    shared({ native_thread_id: 'sid-1' }),
    shared({ runtime_session_id: 'sid-1' }),
    shared({ runtime_session_id: 'dsh-1' }),
  ]) {
    const steps = planRestoreTabs(
      [tab({ session_id: 'sid-1', dsh_session_id: 'dsh-1' })],
      [row],
      deps,
    )
    assert.equal(steps.length, 1)
    assert.equal(steps[0].kind, 'shared', `row ${JSON.stringify(row)} should claim`)
  }
})

test('exited or foreign owners are ignored and fall back to spawn', () => {
  for (const row of [
    shared({ status: 'exited', runtime_session_id: 'sid-1' }),
    shared({ backend_key: 'codex', runtime_session_id: 'sid-1' }),
    shared({ native_thread_id: 'nope' }),
  ]) {
    const steps = planRestoreTabs([tab({ session_id: 'sid-1' })], [row], deps)
    assert.equal(steps[0].kind, 'spawn', `row ${JSON.stringify(row)} must not claim`)
  }
})

test('runtime transport without an owner becomes a failed step', () => {
  const steps = planRestoreTabs(
    [tab({ transport_kind: 'runtime', session_id: 'sid-1' })],
    [],
    deps,
  )
  assert.equal(steps[0].kind, 'failed')
  if (steps[0].kind === 'failed') {
    assert.match(steps[0].reason, /owning runtime is unavailable/)
  }
})

test('spawn options narrow persisted fields and pass session_id through as resume', () => {
  const [step] = planRestoreTabs(
    [
      tab({
        session_id: 'sid-1',
        transport_kind: 'acp',
        permission_mode: 'bypass',
        model: 'opus-4.7',
        endpoint_id: REMOTE,
      }),
    ],
    [],
    deps,
  )
  assert.equal(step.kind, 'spawn')
  if (step.kind !== 'spawn') return
  assert.deepEqual(step.options, {
    cwd: '/tmp/example-project',
    transportKind: 'acp',
    resumeSessionId: 'sid-1',
    permissionMode: 'bypass',
    model: 'opus-4.7',
    endpointId: REMOTE,
  })
})

test('placeholder model / unknown permission / missing endpoint fall back safely', () => {
  for (const model of [undefined, '', 'auto']) {
    const [step] = planRestoreTabs(
      [tab({ model, permission_mode: 'weird', endpoint_id: null })],
      [],
      deps,
    )
    assert.equal(step.kind, 'spawn')
    if (step.kind !== 'spawn') continue
    assert.equal(step.options.model, null)
    assert.equal(step.options.permissionMode, null)
    assert.deepEqual(step.options.endpointId, LOCAL)
    assert.equal(step.options.transportKind, 'pty')
    assert.equal(step.options.resumeSessionId, null)
  }
})

test('model is sanitized before being injected into --model', () => {
  const calls: string[] = []
  const [step] = planRestoreTabs([tab({ model: 'opus-4.7 note: dirty' })], [], {
    sanitizeModelName: (raw) => {
      calls.push(raw)
      return raw.split(' note:')[0]
    },
    localEndpoint: LOCAL,
  })
  assert.deepEqual(calls, ['opus-4.7 note: dirty'])
  assert.equal(step.kind, 'spawn')
  if (step.kind === 'spawn') assert.equal(step.options.model, 'opus-4.7')
})

test('progress reports 1-based index, deduped total and tab title', () => {
  const steps = planRestoreTabs(
    [
      tab({ session_id: 'a', title: 'First' }),
      tab({ session_id: 'a', title: 'Duplicate' }),
      tab({ session_id: 'b', title: '' }),
    ],
    [],
    deps,
  )
  assert.equal(steps.length, 2)
  assert.deepEqual(steps[0].progress, { current: 1, total: 2, name: 'First' })
  assert.deepEqual(steps[1].progress, { current: 2, total: 2, name: 'codebuddy' })
})

test('finalizeRestore clears failed tabs and persists only on full success', () => {
  assert.deepEqual(finalizeRestore(0, 0), { clearFailed: false, persist: false })
  assert.deepEqual(finalizeRestore(2, 2), { clearFailed: true, persist: true })
  assert.deepEqual(finalizeRestore(2, 1), { clearFailed: false, persist: false })
  assert.deepEqual(finalizeRestore(3, 0), { clearFailed: false, persist: false })
})
