/** SIGKILL the real execution Host at durable stop boundaries, retain its generated Hub. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackendClient } from '../src/backend-client.js'

for (const topology of ['local', 'remote']) for (const phase of ['stopping', 'drained']) test(`execution Host SIGKILL preserves cancellation evidence (${topology}/${phase})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: topology === 'remote' ? 150000 : 45000,
}, async () => {
  let child, fixture
  const killChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  const start = (file, args, env) => new Promise((resolve, reject) => {
    child = fork(fileURLToPath(new URL(file, import.meta.url)), args, {
      execPath: process.env.KODE_TEST_HOST_NODE, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const timer = setTimeout(() => finish(new Error('Cancellation crash fixture timed out')), topology === 'remote' ? 60000 : 20000)
    const exited = () => finish(new Error('Cancellation crash fixture exited before evidence'))
    const message = value => { if (value.type === 'fixture-resources') { fixture = value; return } finish(null, value) }
    const finish = (error, value) => { clearTimeout(timer); child.off('exit', exited); child.off('message', message); error ? reject(error) : resolve(value) }
    child.once('exit', exited); child.on('message', message)
  })
  try {
    const env = { ...process.env, KODE_TEST_AUTOMATIC_SCENARIO: 'cancel-busy', KODE_TEST_CANCEL_CRASH: phase, KODE_TEST_REMOTE_SCENARIO: 'cancel-busy' }
    delete env.NODE_TEST_CONTEXT
    fixture = await start(topology === 'remote' ? './fixture-remote-official-dispatch.js' : './fixture-automatic-workflow.js', [], env)
    assert.equal(fixture.type, 'cancel-crash-ready'); assert.equal(fixture.phase, phase)
    await killChild()
    const client = new BackendClient(fixture.url, (await readFile(join(fixture.root, 'admin.token'), 'utf8')).trim())
    const path = `/api/v1/messaging/work-assignments/${fixture.assignment_id}`
    const before = await client.call(path)
    assert.equal(before.stop, undefined, 'no home stop receipt before the crash')
    const execution = fixture.execution ?? fixture
    const profiles = JSON.parse(await readFile(join(execution.root, 'profiles.json'), 'utf8'))
    assert.equal(profiles.bindings[fixture.worker_session].assignmentStop.state, phase)
    const run = await client.call('/api/v1/messaging/work-runs/before')
    assert.equal(run.state, 'cancelling')
    const budget = (await client.call('/api/v1/messaging/budgets/budget')).budget
    assert.ok(budget.reserved > 0)
    for (let replay = 0; replay < 2; replay++) {
      const recovered = await start('./fixture-cancel-recovery.js', [execution.root, execution.url, execution.node, topology], env)
      assert.deepEqual(recovered, { type: 'recovered', state: phase === 'stopping' ? 'cancel_unconfirmed' : topology === 'remote' ? replay === 0 ? 'execution_drained' : 'acknowledged' : replay === 0 ? 'cancellation_execution_drained' : 'waiting_cancellation_accounting', handles: 0 })
      await killChild()
    }
    const after = await client.call(path)
    if (phase === 'stopping') assert.equal(after.stop, undefined)
    else assert.equal(after.stop.receipt.state, 'execution_drained')
    assert.equal(after.resources.state, 'held')
    assert.equal((await client.call('/api/v1/messaging/work-runs/before')).state, 'cancelling')
    assert.deepEqual((await client.call('/api/v1/messaging/budgets/budget')).budget, budget)
    const audit = await client.call('/api/v1/messaging/work-runs/before/events')
    assert.equal(audit.events.filter(row => row.data.kind === 'assignment_execution_drained').length, phase === 'drained' ? 1 : 0)
    assert.equal(audit.events.filter(row => row.data.kind === 'assignment_creation_receipt').length, 1)
    assert.equal(audit.events.filter(row => row.data.kind === 'work_run_cancelled').length, 0)
  } finally {
    await killChild()
    if (['fixture-resources', 'cancel-crash-ready'].includes(fixture?.type)) {
      for (const resource of fixture.hubs ?? [fixture]) {
        // This PID/root came from the generated child fixture, never a user service.
        try { process.kill(resource.hub_pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
        const exited = () => { try { process.kill(resource.hub_pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
        const deadline = Date.now() + 3000
        while (!exited() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
        if (!exited()) {
          process.kill(resource.hub_pid, 'SIGKILL')
          const killed = Date.now() + 1000
          while (!exited() && Date.now() < killed) await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(exited(), true, 'generated Hub must exit before fixture removal')
        await rm(resource.root, { recursive: true, force: true })
      }
    }
  }
})
