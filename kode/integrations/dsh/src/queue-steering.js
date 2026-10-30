/** Native queue transfer must validate admission before removing the pending input. */
export function installQueueSteering(ctx, controller) {
  const original = controller.updateQueue
  const wrapper = async function(request) {
    const agent = ctx.agents.get(request.sessionId)
    if (request.action.kind !== 'steer' || typeof agent?.assertSteeringAvailable !== 'function') return original.call(this, request)
    const index = agent.inbox.nextTurn.findIndex(row => row.id === request.itemId)
    const message = agent.inbox.nextTurn[index]
    if (!message || agent.status !== 'running') return original.call(this, request)
    agent.assertSteeringAvailable(message)
    agent.steer(message)
    agent.inbox.splice('next-turn', index, 1, [])
    return { accepted: true }
  }
  controller.updateQueue = wrapper
  return () => { if (controller.updateQueue === wrapper) controller.updateQueue = original }
}
