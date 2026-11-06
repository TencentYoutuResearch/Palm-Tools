/** Actual owner-authorized free-model inference for Coordinator and all three Workers. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'

export async function liveTeamPipeline({ t, hub, ctx, profiles, execution, host, runService, owned, team, root, model, call, waitFor, errors }) {
  const human = await call(`conversations/${team.conversation_id}/messages`, { request_id: 'live-team-task',
    content: '请在已选项目中创建 implemented.txt，内容恰好是 implemented，不含换行，然后按这个团队已配置的流程交付结果。' })
  let completed
  await waitFor(async () => {
    assert.deepEqual(errors, [])
    const page = await call('work-runs/active')
    const candidate = page.items.find(row => row.team_id === team.id)
    if (candidate) completed = await call(`work-runs/${candidate.id}`)
    return Boolean(completed)
  })
  let lastProgress
  await waitFor(async () => {
    assert.deepEqual(errors, [])
    completed = await call(`work-runs/${completed.id}`)
    const progress = JSON.stringify({ state: completed.state,
      stages: completed.stages.map(stage => ({ stage: stage.stage_id, state: stage.state })) })
    if (progress !== lastProgress) { lastProgress = progress; t.diagnostic(JSON.stringify({ live_team_progress: JSON.parse(progress) })) }
    return completed.state === 'completed'
  })
  assert.equal(completed.completion_authorized, true)
  assert.deepEqual(completed.stages.map(stage => stage.state), ['passed', 'passed', 'passed'])
  assert.equal(await readFile(join(root, 'implemented.txt'), 'utf8'), 'implemented')
  let finalReply
  await waitFor(async () => {
    assert.deepEqual(errors, [])
    const conversation = await call(`conversations/${team.conversation_id}/messages`)
    finalReply = conversation.items.find(message => message.actor.kind === 'superagent'
      && message.in_reply_to === human.id && message.created_at >= completed.delivery.at)
    return Boolean(finalReply)
  })
  await owned.agent.whenIdle()
  const roles = []
  for (const [session, binding] of Object.entries(profiles.bindings)) {
    if (!binding.managedAssignment && !binding.managedCoordinator) continue
    const role = binding.managedCoordinator ? 'coordinator'
      : completed.stages.find(stage => stage.assignment_id === binding.managedAssignment.id)?.stage_id
    assert.ok(role)
    const reader = await ctx.sessionPersistence.open(session, 'read')
    try {
      const decisions = (await reader.read(0, 4096)).events.map(pluginRecordOf)
        .filter(row => row?.type === 'plugin:kode/managed-cli-decision')
      assert.ok(decisions.length >= 2)
      for (const { data } of decisions) {
        assert.equal(data.failure_code, null)
        assert.equal(data.configuration.model, model)
        assert.equal(data.configuration.reasoningEffort, 'low')
        assert.ok(data.usage.input_tokens + data.usage.output_tokens > 0)
        assert.equal(data.stop.leader_exited, true)
        assert.equal(data.stop.process_group_empty, true)
      }
      roles.push({ role, decisions: decisions.length })
    } finally { await reader.close() }
  }
  assert.deepEqual(roles.map(row => row.role).sort(), ['coordinator', 'implement', 'review', 'verify'])
  await runService.close()
  await host.coordinatorCloseRecovery.close()
  if (!profiles.binding(owned.agent.id)?.operationClosed) await owned.run.finish()
  await owned.dispose()
  const budget = (await call('budgets/budget')).budget
  assert.ok(budget.spent > 0 && budget.spent <= budget.limit)
  await hub.stop('SIGKILL'); await hub.start()
  assert.deepEqual((await call(`work-runs/${completed.id}`)).delivery, completed.delivery)
  assert.ok((await call(`conversations/${team.conversation_id}/messages`)).items.some(message => message.id === finalReply.id))
  t.diagnostic(JSON.stringify({ live_team_decisions: roles.reduce((sum, row) => sum + row.decisions, 0),
    native_roles: roles, controlled_roles: [], stages: completed.stages.map(stage => stage.state),
    completion_authorized: true, team_budget_spent: budget.spent,
    price_basis: 'internal_test_credits', cost_basis: 'owner_authorized_free_hy4' }))
}
