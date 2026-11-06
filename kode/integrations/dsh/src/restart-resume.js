/** Persist execution intent, not the set of open tabs. Recovery runs once per Host boot. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionInspector } from './empty-session.js'

export function interruptedByRestart(events) {
  const start = events.findLast(event => event.type === 'turn/start')
  if (!start) return false
  const end = events.findLast(event => event.type === 'turn/end' && event.seq > start.seq)
  if (events.some(event => event.seq > start.seq && event.type === 'plugin:kode/manual-stop')) return false
  if (!end) return true
  const reason = end.data?.reason
  if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') return true
  return reason?.kind === 'interrupted' && events.some(event => event.type === 'plugin:kode/restart-interrupted' && event.data?.startSeq === start.seq)
}
export class RestartResume {
  constructor(ctx, backend, file) {
    this.ctx = ctx; this.backend = backend; this.file = file
    this.bootTime = Date.now(); this.records = {}; this.saving = Promise.resolve(); this.closed = false
  }
  async load() {
    try { this.records = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; this.needsBootstrap = true }
    this.previous = new Set(Object.keys(this.records))
  }
  persist() {
    const data = JSON.stringify(this.records)
    const write = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, data, { mode: 0o600 }); await rename(temp, this.file)
    })
    this.saving = write
    return write
  }
  async status(agent) {
    if (this.closed) return
    if (agent.status === 'running') this.records[agent.id] = true
    else if (!interruptedByRestart(agent.session.snapshotEvents())) delete this.records[agent.id]
    await this.persist()
  }
  async recover(signal) {
    const settings = await this.backend.call('/api/v1/messaging/integrations', undefined, signal)
    const get = name => this.ctx.get?.(name) ?? this.ctx[name]
    const controller = get('sessionController'), inspect = sessionInspector(controller, get('sessionQuery'))
    if (!settings.auto_resume_interrupted) { for (const id of this.previous) delete this.records[id]; await this.persist(); return }
    if (!inspect) return
    // Upgrade bootstrap: the old process could not have written our new journal.
    // Admit only recent restart evidence, not arbitrary abandoned historical work.
    if (this.needsBootstrap && controller.list) {
      const directory = await controller.list({}, signal)
      for (const row of directory.items) {
        signal.throwIfAborted()
        if (row.blank) continue
        try {
          const agent = get('agents').get(row.sessionId)
          if (agent?.status === 'running') continue
          const events = agent?.session.snapshotEvents() ?? (await inspect(row.sessionId, signal)).events
          const evidence = events.findLast(event => event.type === 'plugin:kode/restart-interrupted')
          const lastEnd = events.findLast(event => event.type === 'turn/end')
          const at = evidence?.data?.interruptedAt ?? lastEnd?.time ?? events.at(-1)?.time
          if (interruptedByRestart(events) && at >= this.bootTime - 120_000) {
            this.previous.add(row.sessionId); this.records[row.sessionId] = true
          }
        } catch (error) { if (signal.aborted) throw error }
      }
      this.needsBootstrap = false
      await this.persist()
    }
    const archived = new Set(get('workspaceRegistry')?.archivedSessionIds ?? [])
    for (const id of this.previous) {
      signal.throwIfAborted()
      try {
        if (archived.has(id)) { delete this.records[id]; continue }
        const live = get('agents').get(id)
        if (live?.status === 'running') continue
        const stored = live ? { events: live.session.snapshotEvents() } : await inspect(id, signal)
        if (!interruptedByRestart(stored.events)) { delete this.records[id]; continue }
        // Re-read policy before every admission: turning off the switch stops the batch.
        if (!(await this.backend.call('/api/v1/messaging/integrations', undefined, signal)).auto_resume_interrupted) break
        const result = live ? { agent: live } : await controller.resolveAgent(id)
        signal.throwIfAborted()
        if (result.error) throw new Error(result.error.message)
        const agent = result.agent
        if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) continue
        agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'system' }, content: [{ type: 'text', text: '应用重启导致上一轮任务中断。请根据已有会话上下文检查当前执行结果，继续完成尚未完成的任务；已完成的操作不要重复执行。' }] })
        await agent.ctx.parallel('session/flush', agent.session)
      } catch (error) {
        if (signal.aborted) throw error
        this.ctx.logger.warn('Kode could not continue interrupted session %s: %s', id, error.message)
      }
    }
    await this.persist()
  }
}
export async function installRestartResume(ctx, backend, file) {
  const service = new RestartResume(ctx, backend, file)
  await service.load()
  const stop = new AbortController()
  const report = error => { if (!stop.signal.aborted) ctx.logger.warn('Kode restart recovery failed: %s', error.message) }
  ctx.on('agent/status', ({ agent }) => { void service.status(agent).catch(report) })
  for (const agent of ctx.agents.list()) if (agent.status === 'running') await service.status(agent)
  const task = service.recover(stop.signal).catch(report)
  ctx.effect(() => async () => { service.closed = true; stop.abort(); await task; await service.saving }, 'kode.restart-resume')
  return service
}
