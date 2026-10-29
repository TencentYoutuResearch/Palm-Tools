/** Explicit user slash commands; never inferred from ordinary prompts or peer messages. */
export function parseGoalInput(input = '') {
  const text = input.trim()
  if (!text || text === 'status') return { action: 'get' }
  if (['pause', 'resume', 'clear'].includes(text)) return { action: text }
  if (text === 'edit') return { action: 'edit-help' }
  const edit = text.startsWith('edit '), objective = (edit ? text.slice(5) : text).trim()
  if (!objective || [...objective].length > 4000) throw new Error('目标需要 1–4000 个字符。')
  return { action: edit ? 'edit' : 'set', objective }
}
export function formatGoal(goal) {
  if (!goal) return '当前没有目标。使用 /goal 目标描述 设置。'
  const labels = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '预算耗尽', complete: '已完成' }
  return `目标：${goal.objective}\n状态：${labels[goal.status] ?? goal.status}\n已用 ${goal.tokensUsed ?? 0}${goal.tokenBudget == null ? '' : ` / ${goal.tokenBudget}`} tokens · ${goal.timeUsedSeconds ?? 0} 秒`
}
export async function runGoalCommand(session, input, signal) {
  const parsed = parseGoalInput(input), params = { threadId: session.threadId }, options = { signal }
  try {
    if (parsed.action === 'clear') {
      const result = await session.rpc.request('thread/goal/clear', { ...params, origin: 'user' }, options)
      return { text: result.cleared ? '已清除当前目标。' : '当前没有目标。', run: false }
    }
    if (parsed.action === 'get' || parsed.action === 'edit-help') {
      const { goal } = await session.rpc.request('thread/goal/get', params, options)
      return { text: formatGoal(goal) + (parsed.action === 'edit-help' ? '\n使用 /goal edit 新目标描述 修改。' : ''), run: false }
    }
    let status = parsed.action === 'pause' ? 'paused' : 'active'
    if (parsed.action === 'edit') {
      const { goal } = await session.rpc.request('thread/goal/get', params, options)
      if (!goal) throw new Error('当前没有目标，请先使用 /goal 目标描述。')
      status = goal.status === 'active' ? 'active' : 'paused'
    }
    const { goal } = await session.rpc.request('thread/goal/set', { ...params, origin: 'user', status, ...(parsed.objective ? { objective: parsed.objective } : {}) }, options)
    return { text: formatGoal(goal), run: goal.status === 'active' }
  } catch (error) {
    if (error.rpcCode === -32601) throw new Error('此 Codex 版本未提供原生目标接口，请更新所选 Agent 的 Codex。')
    throw error
  }
}
