/** Lossless coordinate repair for native operations crossing premature step boundaries.
 * Event sequence IDs, tool IDs, messages and results are retained; no outcome is invented. */
export function repairNativeStepBoundaries(events) {
  if (!events.some(event => event.type === 'plugin:kode/native-event')) return { events, changes: [] }
  let turn, step = null, nextStep = 0
  const pending = new Set(), coordinates = new Map(), changes = []
  const repaired = events.map(original => {
    const event = structuredClone(original), data = event.data
    if (event.type === 'turn/start') { if (pending.size || step !== null) throw new Error('Cannot repair overlapping turns'); turn = data.turn; nextStep = 0 }
    const annotate = () => { changes.push({ seq: event.seq, type: event.type, action: 'defer-boundary' }); return { type: 'plugin:kode/step-boundary-repair', seq: event.seq, time: event.time, ignorable: true, data: { originalType: event.type, originalData: data } } }
    if (event.type === 'step/start') {
      if (step !== null) { coordinates.set(`${data.turn}:${data.step}`, step); return annotate() }
      step = ++nextStep; coordinates.set(`${data.turn}:${data.step}`, step)
    }
    if (event.type === 'step/end' && pending.size) {
      if ([...pending].some(id => !id.startsWith('kode:'))) throw new Error('Refusing to repair a non-Kode tool lifecycle')
      return annotate()
    }
    if (Number.isInteger(data?.step) && Number.isInteger(data?.turn)) {
      const mapped = coordinates.get(`${data.turn}:${data.step}`)
      if (mapped !== undefined && mapped !== data.step) { changes.push({ seq: event.seq, type: event.type, from: data.step, to: mapped }); data.step = mapped }
    }
    if (event.type === 'assistant/message') for (const block of data.message.content) if (block.type === 'tool-call') pending.add(block.id)
    if (event.type === 'tool/result' && event.surfaceOp === 'append') pending.delete(data.message.toolCallId)
    if (event.type === 'step/end') step = null
    if (event.type === 'turn/end') { if (pending.size || step !== null) throw new Error(`Turn ${turn} has a missing operation outcome; cannot repair losslessly`); turn = undefined }
    return event
  })
  if (pending.size || step !== null) throw new Error('Refusing to rewrite an active or incomplete log')
  return { events: changes.length ? repaired : events, changes }
}
