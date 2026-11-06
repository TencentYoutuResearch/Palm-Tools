export const budgetCommandKey = (team, budget) => JSON.stringify(['team-budget', team.home_hub, team.id, budget.id])
export async function configureBudget({ storage, team, budget, limit, request, signal, uuid = () => crypto.randomUUID() }) {
  if (budget.scope !== 'team' || budget.scope_id !== team.id || !Number.isSafeInteger(limit) || limit < 0 || limit > 4000000000000000) throw Error('Invalid team budget')
  const key = budgetCommandKey(team, budget)
  const row = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: team.home_hub, command: { team_revision: team.revision,
    budget: { id: budget.id, scope: 'team', scope_id: team.id, unit: budget.unit, limit, starts_at: budget.starts_at, ends_at: budget.ends_at, expected_revision: budget.revision } } })
  if (signal?.aborted) throw Error('Disposed')
  if (row.home_hub !== team.home_hub || row.command.budget.id !== budget.id || row.command.budget.scope_id !== team.id) throw Error('Wrong budget identity')
  const command = { ...row.command, request_id: row.request_id }
  const recovered = await request({ team_id: team.id, request_id: row.request_id }, { signal, method: 'GET' })
  if (signal?.aborted) throw Error('Disposed')
  if (!recovered || !Object.hasOwn(recovered, 'receipt')) throw Error('Missing receipt status')
  let result
  if (recovered.receipt) {
    const saved = recovered.receipt.request
    if (saved?.request_id !== command.request_id || saved.team_revision !== command.team_revision || Object.entries(command.budget).some(([key, value]) => saved.budget?.[key] !== value)) throw Error('Wrong budget receipt')
    result = recovered.receipt.result
  } else if (recovered.receipt !== null) throw Error('Invalid receipt status')
  else result = await request({ team_id: team.id, command }, { signal, method: 'POST' })
  if (result.label !== '团队预算' || result.team_id !== team.id || result.request_id !== row.request_id || result.activation_performed !== false
    || result.team_revision !== command.team_revision || result.budget?.revision !== command.budget.expected_revision + 1
    || Object.entries(command.budget).some(([key, value]) => key !== 'expected_revision' && result.budget?.[key] !== value)) throw Error('Invalid budget result')
  await storage.save(key, { ...row, state: 'accepted' })
  return result
}
export async function requestBudgetCommand(input, { signal, method } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const url = '/api/kode/teams/budget' + (method === 'GET' ? '?' + new URLSearchParams(input) : '')
    const response = await fetch(url, { method, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) })
    if (!response.ok) throw Error('Budget not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
