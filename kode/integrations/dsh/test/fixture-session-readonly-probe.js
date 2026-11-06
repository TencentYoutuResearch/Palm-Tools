/** Owner-authenticated cold observation for the isolated released-desktop test. */
import { symbols } from '@deepseek-ai/cordis'
export const inject = ['webServer', 'connection', 'sessionController', 'agents']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/kode/test-session-observation', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, {})
    if (req.method !== 'GET') return send(405, {})
    const query = new URL(req.url, 'http://localhost').searchParams, id = query.get('session_id')
    if (!id || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || [...query.keys()].length !== 1) return send(400, {})
    try {
      const inspection = await ctx.sessionController.inspect(id)
      const controller = ctx.sessionController[symbols.original] ?? ctx.sessionController
      return send(200, { session_id: inspection.meta.id, events: inspection.events.length, agent_active: Boolean(ctx.agents.get(id)),
        promotion_guard: Object.getOwnPropertyDescriptor(controller, 'promote')?.value?.name === 'guarded',
        tail_event_types: inspection.events.slice(-3).map(event => event.type) })
    } catch { return send(503, {}) }
  } }), 'fixture.readonly-observation')
}
