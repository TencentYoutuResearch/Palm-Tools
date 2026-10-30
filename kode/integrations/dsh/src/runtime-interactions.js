/** Multiplex existing dsh human interactions across its UI and a paired phone.
 * Policy and audit remain in the original services. Only a private request
 * copy receives the cancellable UI-branch signal; callers are never mutated.
 */
import { randomUUID } from 'node:crypto'

export function questionSchema(questions) {
  return { type: 'object', required: questions.map(question => question.id), properties: Object.fromEntries(questions.map(question => {
    const choices = question.options?.map(option => ({ const: option.label, title: option.label }))
    const scalar = { type: 'string', ...(choices?.length ? { oneOf: choices, allow_custom: true } : {}) }
    return [question.id, { title: question.header ?? question.question, description: [question.question, question.detail].filter(Boolean).join('\n\n'), ...(question.multiSelect ? { type: 'array', items: scalar, minItems: 1 } : scalar) }]
  })) }
}

export function questionAnswer(questions, response) {
  if (response.action !== 'accept' && response.decision !== 'allow') {
    const error = new Error('The user cancelled this question'); error.code = 'ASK_ABORTED'; throw error
  }
  return { answers: questions.map(question => {
    const value = response.content?.[question.id]
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    if (!values.length || !values.every(value => typeof value === 'string' && value.trim())) throw new Error(`Answer required for ${question.id}`)
    if (!question.multiSelect && values.length !== 1) throw new Error(`Choose one answer for ${question.id}`)
    const listed = new Set(question.options?.map(option => option.label) ?? [])
    return { id: question.id, selected: values.filter(value => listed.has(value)), ...(values.some(value => !listed.has(value)) ? { custom: values.filter(value => !listed.has(value)).join('\n') } : {}) }
  }) }
}

export function installRuntimeInteractions(ctx, bridge) {
  const ownership = Symbol('kode-mobile-interaction'), disposers = []
  for (const [serviceName, method, event, approval] of [['approval', 'request', 'approval/request', true], ['userQuestions', 'ask', 'user-questions/request', false]]) {
    const service = ctx.get?.(serviceName)
    if (!service?.[method]) continue
    const original = service[method]
    const wrapper = function(request) {
      if (!(bridge.mobileEnabled || bridge.guiEnabled) || !request.agent) return original.call(this, request)
      const copy = { ...request, [ownership]: true }
      return original.call(this, copy)
    }
    service[method] = wrapper
    disposers.push(() => { if (service[method] === wrapper) service[method] = original })
    const stop = ctx.on(event, async (request, next) => {
      if (!request[ownership]) return next()
      const id = randomUUID(), sessionId = request.agent.id, ui = new AbortController(), outerSignal = request.signal
      let resolveMobile, rejectMobile
      const mobile = new Promise((resolve, reject) => { resolveMobile = resolve; rejectMobile = reject })
      // The original approval service captured outerSignal before entering its
      // waterfall. Cancelling the competing UI cannot cancel the winning grant.
      request.signal = outerSignal ? AbortSignal.any([outerSignal, ui.signal]) : ui.signal
      const payload = approval ? {
        request_id: id, question_id: id, source: 'acp_permission', question: request.reason ?? request.toolName,
        options: [{ label: 'Allow once', option_id: 'allowed-once' }, { label: 'Reject', option_id: 'rejected' }],
      } : { request_id: id, question_id: id, source: 'acp_form', message: '请回答 Agent 的问题', requested_schema: questionSchema(request.questions) }
      const record = (state, extra = {}) => request.agent.session.append('plugin:kode/shared-interaction', { id, kind: 'ask_user_question', payload, state, ...extra })
      const cancel = () => {
        if (approval) resolveMobile('cancelled')
        else { const error = new Error('Question cancelled'); error.code = 'ASK_ABORTED'; rejectMobile(error) }
      }
      outerSignal?.addEventListener('abort', cancel, { once: true })
      if (outerSignal?.aborted) cancel()
      const pending = {
        sessionId, cancel,
        answer: response => {
          const value = response.response ?? response
          if (approval) {
            if (!['allowed-once', 'rejected'].includes(value.optionId)) throw new Error('Choose Allow once or Reject')
            resolveMobile(value.optionId)
          } else {
            try { resolveMobile(questionAnswer(request.questions, value)) }
            catch (error) { if (error.code === 'ASK_ABORTED') rejectMobile(error); else throw error }
          }
          return { accepted: true }
        },
      }
      bridge.pending.set(id, pending)
      record('open')
      await request.agent.ctx?.sessions?.flush?.(request.agent.session)
      const downstream = Promise.resolve().then(next).then(value => {
        if (approval && value === 'unavailable') return mobile
        return value
      }, error => {
        if (error.code === 'NO_PROVIDER') return mobile
        throw error
      })
      try { return await Promise.race([mobile, downstream]) }
      finally {
        bridge.pending.delete(id); outerSignal?.removeEventListener('abort', cancel)
        ui.abort(); request.signal = outerSignal; record('closed')
        await request.agent.ctx?.sessions?.flush?.(request.agent.session)
      }
    }, { prepend: true, global: true })
    disposers.push(stop)
  }
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}
