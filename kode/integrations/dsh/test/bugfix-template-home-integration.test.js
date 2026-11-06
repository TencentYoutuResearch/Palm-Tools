import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import { createBugfixFixture, waitForFile } from './support/bugfix-template-fixture.js'

let projectRoot = resolve(dirname(fileURLToPath(import.meta.url)))
while (projectRoot !== dirname(projectRoot)) {
  try { await access(join(projectRoot, 'Cargo.toml')); break } catch { projectRoot = dirname(projectRoot) }
}
const { builderWorkflowTemplates } = await import(pathToFileURL(join(projectRoot, 'integrations/dsh/src/builder-workflow-templates.js')).href)

const runGit = (cwd, args) => promisify(execFile)('/usr/bin/git', ['-C', cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
})
const waitFor = async (fn, label, timeoutMs = 45000) => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    assert.ok(Date.now() < until, `Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const route = fixture => `${fixture.root}/work-runs/${fixture.runId}`

test('bugfix mappings select their judged output; rework remains based on the prior attempt', () => {
  const workflow = builderWorkflowTemplates().find(row => row.id === 'software-bugfix').workflow
  for (const [stageId, ruleId] of [['review', 'reviewed'], ['verify', 'checked']]) {
    const stage = workflow.stages.find(row => row.id === stageId)
    const rule = workflow.evidence_rules[ruleId]
    assert.equal(rule.artifact_output, 'artifact')
    assert.deepEqual(stage.execution.input_artifact, { stage: 'implement', output: rule.artifact_output },
      `${stageId} must consume exactly the Artifact output judged by its EvidenceRule`)
  }
})

test('controlled bugfix run waits for baseline reproduction and reviews/verifies the archived fixed artifact', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 90000,
}, async t => {
  const fixture = await createBugfixFixture('reproduced')
  t.after(() => fixture.close())
  await waitForFile(fixture.marker)
  assert.equal(fixture.records.implementationStarted, false, 'implementation must not start before reproduction completes')
  assert.ok(fixture.records.calls.every(row => row.stage === 'baseline' || row.stage === 'diagnose'))
  await (await import('node:fs/promises')).writeFile(fixture.gate, 'release')

  const completed = await waitFor(async () => {
    const run = await fixture.hub.client.call(route(fixture))
    return run.state === 'completed' ? run : null
  }, 'successful bugfix completion')
  const stages = Object.fromEntries(completed.stages.map(row => [row.stage_id, row]))
  assert.equal(stages.baseline.state, 'passed')
  assert.equal(stages.diagnose.state, 'passed')
  assert.equal(stages.implement.state, 'passed')
  assert.equal(stages.review.state, 'passed')
  assert.equal(stages.verify.state, 'passed')

  const snapshots = fixture.records.stageSnapshots
  const baseline = snapshots.find(row => row.stage === 'baseline')
  const implementation = snapshots.find(row => row.stage === 'implement' && row.attempt === 1)
  const review = snapshots.find(row => row.stage === 'review')
  const verify = snapshots.find(row => row.stage === 'verify')
  assert.equal(baseline.source, 'buggy source')
  assert.equal(implementation.source, 'buggy source')
  assert.equal(review.source, 'fixed source')
  assert.equal(verify.source, 'fixed source')
  assert.notEqual(review.snapshot_hash, baseline.snapshot_hash)
  assert.notEqual(verify.snapshot_hash, baseline.snapshot_hash)
  assert.ok(implementation.sources.baseline.outputs.baseline.sequence > 0,
    'implementation preserves the baseline archive as its explicit input')
  assert.ok(review.sources.implement.outputs.artifact.sequence > 0, 'review input must reference archived implementation output')
  assert.ok(verify.sources.implement.outputs.artifact.sequence > 0, 'verification input must reference archived implementation output')
  assert.ok(stages.baseline.evidence.outputs.baseline > 0, 'baseline archive remains available in run evidence')
  assert.equal(stages.baseline.evidence.outputs.baseline, implementation.sources.baseline.outputs.baseline.sequence)
  assert.equal(stages.implement.evidence.outputs.artifact, review.sources.implement.outputs.artifact.sequence)
  assert.equal(stages.implement.evidence.outputs.artifact, verify.sources.implement.outputs.artifact.sequence)

  assert.equal((await runGit(fixture.workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), fixture.workspace.base)
  assert.equal((await runGit(fixture.workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout, fixture.workspace.status)
  assert.deepEqual(await (await import('node:fs/promises')).readFile(join(fixture.workspace.path, 'owner-dirty.txt')), fixture.workspace.dirty)
  assert.equal(await (await import('node:fs/promises')).readFile(join(fixture.workspace.path, 'source.txt'), 'utf8'), 'buggy source')
})

test('review rework starts from the previous implementation artifact, not configured baseline', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 90000,
}, async t => {
  const fixture = await createBugfixFixture('rework')
  t.after(() => fixture.close())
  let lastRun
  let completed
  try {
    completed = await waitFor(async () => {
      lastRun = await fixture.hub.client.call(route(fixture))
      return lastRun.state === 'completed' ? lastRun : null
    }, 'reworked bugfix completion')
  } catch (error) {
    const safeRun = lastRun && { state: lastRun.state, waiting_reason: lastRun.waiting_reason,
      stages: lastRun.stages?.map(row => ({ stage_id: row.stage_id, state: row.state, attempt: row.attempt,
        assignment_id: row.assignment_id, outputs: row.evidence?.outputs })),
      reworks: lastRun.reworks?.map(row => ({ state: row.state, superseded: row.superseded?.map(stage => ({ stage_id: stage.stage_id, state: stage.state })) })) }
    const assignments = await Promise.all((safeRun?.stages ?? []).filter(row => row.assignment_id).map(async row => {
      const assignment = await fixture.hub.client.call(`${fixture.root}/work-assignments/${row.assignment_id}`).catch(() => null)
      if (!assignment) return { stage_id: row.stage_id, available: false }
      return { stage_id: row.stage_id, state: assignment.state, stage_attempt: assignment.stage_attempt,
        resource_state: assignment.resources?.state, reservation_finalized: assignment.accounting?.receipt?.reservation?.finalized,
        rework_binding: assignment.inputs?.binding?.rework, starting_basis: assignment.execution_workspace?.receipt?.starting_snapshot?.basis,
        task_root: assignment.execution_workspace?.receipt?.scope?.target?.root }
    }))
    throw new Error(`${error.message}; safe fixture diagnostics=${JSON.stringify({ run: safeRun, assignments, calls: fixture.records.calls,
      snapshots: fixture.records.stageSnapshots.map(row => ({ stage: row.stage, attempt: row.attempt, basis: row.basis,
        snapshot_hash: row.snapshot_hash, source: row.source })), reworkStart: fixture.records.reworkStart, adapterError: fixture.records.error?.message })}`, { cause: error })
  }
  assert.equal(completed.reworks.length, 1)
  assert.equal(fixture.records.reworkStart, 'partial fix')
  const retry = fixture.records.stageSnapshots.find(row => row.stage === 'implement' && row.attempt > 1)
  assert.equal(retry.basis, 'rework_artifact')
  assert.equal(retry.source, 'partial fix')
  const finalReview = fixture.records.stageSnapshots.filter(row => row.stage === 'review').at(-1)
  const finalVerify = fixture.records.stageSnapshots.find(row => row.stage === 'verify')
  assert.equal(finalReview.source, 'fixed source')
  assert.equal(finalVerify.source, 'fixed source')
  assert.ok(finalReview.sources.implement.outputs.artifact.sequence > 0)
  assert.ok(finalVerify.sources.implement.outputs.artifact.sequence > 0)
  assert.equal((await runGit(fixture.workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout, fixture.workspace.status)
})

test('owner waiver preserves unreproduced diagnosis and cannot bypass failed final verification or duplicate charging', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 90000,
}, async t => {
  const fixture = await createBugfixFixture('unreproduced')
  t.after(() => fixture.close())
  const runPath = route(fixture)
  const waiverPlanPath = `${runPath}/stages/diagnose/waiver-plan`
  const { run: beforeWaiver, plan } = await waitFor(async () => {
    const run = await fixture.hub.client.call(runPath)
    if (run.state !== 'waiting_user' || run.stages?.find(row => row.stage_id === 'diagnose')?.state !== 'rejected') return null
    const plan = await fixture.hub.client.call(waiverPlanPath).catch(() => null)
    if (plan) return { run, plan }
    return null
  }, 'owner decision after failed reproduction')
  assert.equal(fixture.records.implementationStarted, false)
  assert.equal(beforeWaiver.completion_authorized, false)
  assert.equal(beforeWaiver.stages.find(row => row.stage_id === 'diagnose').state, 'rejected')
  const command = { request_id: 'owner-waive-unreproduced-diagnosis', expected_revision: beforeWaiver.revision,
    scope_hash: plan.scope_hash, reason: 'The registered reproduction did not confirm the defect; continue while preserving that fact.' }
  const decisionPath = `${runPath}/stages/diagnose/waiver`
  const [receipt, duplicate] = await Promise.all([
    fixture.hub.client.call(decisionPath, command), fixture.hub.client.call(decisionPath, command),
  ])
  assert.deepEqual(receipt, duplicate)

  const final = await waitFor(async () => {
    const run = await fixture.hub.client.call(runPath)
    const diagnose = run.stages?.find(row => row.stage_id === 'diagnose')
    const verify = run.stages?.find(row => row.stage_id === 'verify')
    return run.state === 'waiting_user' && diagnose?.state === 'waived' && verify?.state === 'rejected' ? run : null
  }, 'failed final verification after waiver')
  assert.equal(final.state, 'waiting_user')
  assert.equal(final.completion_authorized, false)
  assert.equal(final.stages.find(row => row.stage_id === 'diagnose').state, 'waived')
  assert.ok(final.stages.find(row => row.stage_id === 'diagnose').evidence,
    'waiver preserves the failed reproduction evidence for audit')
  assert.equal(final.stages.find(row => row.stage_id === 'verify').state, 'rejected')
  assert.ok(fixture.records.stageSnapshots.some(row => row.stage === 'implement' && row.waivers?.diagnose),
    'the downstream implementation carries the waiver fact separately from artifact sources')

  const budgetBeforeRestart = await fixture.hub.client.call(`${fixture.root}/budgets/team-budget`)
  const eventsBeforeRestart = (await fixture.hub.client.call(`${runPath}/events`)).events
  const stageWaiversBefore = eventsBeforeRestart.filter(row => row.data.kind === 'stage_waived').length
  assert.equal(stageWaiversBefore, 1)
  await fixture.closeService()
  await fixture.hub.stop('SIGKILL'); await fixture.hub.start()
  assert.deepEqual(await fixture.hub.client.call(decisionPath, command), receipt)
  assert.deepEqual(await fixture.hub.client.call(runPath), final)
  assert.deepEqual(await fixture.hub.client.call(`${fixture.root}/budgets/team-budget`), budgetBeforeRestart)
  const eventsAfterRestart = (await fixture.hub.client.call(`${runPath}/events`)).events
  assert.equal(eventsAfterRestart.filter(row => row.data.kind === 'stage_waived').length, stageWaiversBefore)
})
