/** Mount before async profile/backend setup: a native log must never acquire an ordinary loop. */
export const nativeStartupFailure = 'Kode 原生 Agent 执行器尚未就绪，已阻止普通 dsh 执行器接管；初始化完成后可安全恢复。'
export function nativeSessionSelection(agent) {
  const events = agent.session.snapshotEvents()
  return events.findLast(event => event.type === 'model/selection')?.data
    ?? events.findLast(event => event.type === 'request/header')?.data?.header?.config
    ?? agent.options
}
export function installNativeStartupBarrier(ctx) {
  return ctx.on('agent/created', ({ agent }) => {
    if (!agent.isKodeNativeAgent && nativeSessionSelection(agent)?.provider?.startsWith('kode-agent-')) {
      // Agent publication is serial and transactional. Throw here releases its
      // writer before its scheduler can consume input or admit a system prompt.
      throw new Error(nativeStartupFailure)
    }
  })
}
export function isNativeRoutingFailure(reason) {
  return reason?.kind === 'error' && /Kode 原生 Agent 会话被普通 dsh 执行器接管|Kode 原生 Agent 执行器尚未就绪/.test(reason.error?.message ?? '')
}
