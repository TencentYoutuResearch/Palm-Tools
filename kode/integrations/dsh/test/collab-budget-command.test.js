import test from 'node:test'
import assert from 'node:assert/strict'
import { configureBudget } from '../packages/collab/budget-command.js'
test('lost budget response recovers original confirmed amount from receipt without a second POST', async () => {
  let row, saved, posts = 0
  const storage = { async reserve(_, value) { return row ??= value }, async save(_, value) { row = value } }
  const team = { id: 'team', home_hub: 'home', revision: 1 }, budget = { id: 'budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100, starts_at: 1, ends_at: 999, revision: 1 }
  const request = async (input, { method }) => {
    if (method === 'GET') return { receipt: saved ?? null }
    posts++
    saved = { request: input.command, result: { label: '团队预算', team_id: 'team', team_revision: 1, request_id: input.command.request_id, activation_performed: false, budget: { ...input.command.budget, revision: 2 } } }
    throw Error('reply lost')
  }
  await assert.rejects(configureBudget({ storage, team, budget, limit: 150, request, uuid: () => 'first' }))
  const result = await configureBudget({ storage, team, budget, limit: 900, request, uuid: () => 'second' })
  assert.equal(posts, 1); assert.equal(result.budget.limit, 150); assert.equal(row.state, 'accepted')
})
