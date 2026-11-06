import test from 'node:test'
import assert from 'node:assert/strict'
import { closeBuilder } from '../src/builder-close.js'

test('Builder close maps only exact unresolved-usage rejection to nonretryable accounting status', async () => {
  const operation = { id: 'creation', attempt: 1, epoch: 1, revision: 3, state: 'active', worker: { node_id: 'home', session_id: 'builder' } }
  const intent = { operation_id: 'creation', draft_id: 'draft', request: { request_id: 'close', attempt: 1, epoch: 1, price_id: 'price', settlement: 'internal_price' }, state: 'closing' }
  const diagnostic = { operation, accounting: { state: 'waiting_accounting', reason: 'needs_reconciliation', retryable: false,
    unresolved_calls: [{ call_id: 'missing-call', state: 'finished', accounting_status: 'usage_unresolved' }],
    budget: { reservation_id: 'reservation', unit: 'credits', charged: 2, held: 8, finalized: false, frozen: true } } }
  const scope = { operation_id: 'creation', home_hub: 'home', worker: operation.worker, request: { attempt: 1, epoch: 1 } }
  let finish = 0, dispose = 0, finalize = 0, otherFailure = false
  const profiles = { binding: () => ({ managedOperation: { id: 'creation', attempt: 1, epoch: 1 }, managedBuilder: { draft_id: 'draft' } }), patchBinding: async () => {} }
  const host = { handles: new Map(), execution: { host: 'home', profiles, client: { call: async (path, body) => {
    if (path.endsWith('/builder-scope')) return { scope }
    if (path.endsWith('/builder-close')) {
      if (body) return intent
      return { ...diagnostic, intent, operation, pending_inputs: 0 }
    }
    if (path.endsWith('/builder-accounting')) {
      finalize++
      if (otherFailure) throw Object.assign(new Error('kode backend (403): permission denied'), { status: 403 })
      throw Object.assign(new Error('kode backend (400): official usage remains unresolved'), { status: 400 })
    }
    return operation
  } } } }
  host.handles.set('builder', { agent: { whenIdle: async () => {} }, run: { finish: async () => { finish++; operation.state = 'reported'; operation.revision = 4 } }, dispose: async () => { dispose++; host.handles.delete('builder') } })
  const input = { operation_id: 'creation', command: intent.request }
  const result = await closeBuilder(host, input)
  assert.equal(result.state, 'waiting_accounting')
  assert.equal(result.reason, 'needs_reconciliation')
  assert.equal(result.retryable, false)
  assert.deepEqual(result.accounting, diagnostic.accounting)
  assert.deepEqual({ finish, dispose, finalize }, { finish: 1, dispose: 1, finalize: 1 })

  const recovered = await closeBuilder(host, input)
  assert.equal(recovered.state, 'waiting_accounting')
  assert.deepEqual({ finish, dispose, finalize }, { finish: 1, dispose: 1, finalize: 2 }, 'recovering status never replays the execution')

  otherFailure = true
  await assert.rejects(closeBuilder(host, input), /permission denied/)
  assert.deepEqual({ finish, dispose, finalize }, { finish: 1, dispose: 1, finalize: 3 }, '403 is not disguised as a usage blocker')
})
