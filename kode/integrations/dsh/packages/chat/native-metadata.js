/** Retain native context telemetry as a hidden Chat node, including on older Hosts. */
function registerKodeContextUsage(ctx) {
  const sample = (event, previous) => nativeContextUsage(event, previous)
  ctx.uiConversation.events.register({
    kind: 'kode-context-usage', target: 'chat',
    match: { 'plugin:kode/native-event': event => sample(event) ? { id: 'context', role: 'start' } : null },
    start: (_context, match) => ({ seq: match.event.seq, usage: sample(match.event) }),
    update: (context, match) => context.state.seq > match.event.seq ? context.state : { seq: match.event.seq, usage: sample(match.event, context.state.usage) },
    buildViewNode: context => chatNode(context, 'kode-context-usage', context.state.seq, context.state.usage, { visibility: 'hidden', groupTree: 'turn' }),
  })
}
/** Multiple native replies may share a canonical step while tools are in flight.
 * Keep superseded text at its own event position instead of dropping it. */
function registerKodeAssistantHistory(ctx) {
  ctx.uiConversation.events.register({
    kind: 'kode-assistant-history', target: 'chat',
    match: { 'assistant/message': event => event.surfaceOp === 'append' && event.data.message.content.some(block => ['text', 'reasoning', 'image'].includes(block.type)) ? { id: String(event.seq), role: 'start' } : null },
    start: (_context, match) => match.event,
    update: (context) => context.state,
    buildViewNode: context => {
      const event = context.state, location = context.start?.location
      const latest = location?.kind === 'step' ? location.step.data.get('assistant-step') : undefined
      const superseded = (latest?.finalNode?.seq ?? latest?.anchorSeq ?? -1) > event.seq
      const blocks = toAssistantBlocks(event.data.message.content)
      const reply = blocks.some(block => block.kind === 'text' && block.text?.trim() || block.kind === 'image')
      return chatNode(context, 'assistant-step', event.seq, { status: 'settled', turn: event.data.turn, step: event.data.step, blocks, time: event.time }, { visibility: superseded ? 'visible' : 'hidden', ...(reply ? { groupTree: 'process' } : {}) })
    },
  })
}
