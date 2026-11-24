/** Run the bundled handoff skill in the source conversation and read its durable reply. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const skillFile = new URL('../assets/skills/kode-handoff/SKILL.md', import.meta.url)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX_BRIEF_BYTES = 12_000

function readBrief(session, events, inputId) {
  const user = events.findIndex(event => event.type === 'user/message' && event.data.id === inputId)
  if (user === -1) return
  const start = events.slice(0, user).findLast(event => event.type === 'turn/start')
  if (!start) return
  const end = events.findIndex((event, index) => index > user && event.type === 'turn/end' && event.data.turn === start.data.turn)
  if (end === -1) return
  if (events[end].data.reason?.kind !== 'completed') throw new Error('源 Agent 未完成交接稿，请重新发起交接。')
  const turn = events.slice(events.indexOf(start) + 1, end)
  if (turn.some(event => event.type === 'user/message' && event.data.id !== inputId)) throw new Error('交接期间源会话收到了其他消息，请重新发起交接。')
  if (session.surface && !session.surface.nodes.includes(events[user].seq)) throw new Error('交接稿所在的历史已被编辑，请重新发起交接。')
  const reply = turn.findLast(event => event.type === 'assistant/message' && !event.data.interrupted)
  const text = reply?.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
  const brief = /^BEGIN_KODE_HANDOFF\r?\n([\s\S]+)\r?\nEND_KODE_HANDOFF$/.exec(text ?? '')?.[1].trim()
  if (!brief || Buffer.byteLength(brief) > MAX_BRIEF_BYTES) throw new Error('源 Agent 未生成有效的交接稿，请重新发起交接。')
  return brief
}

export async function prepareHandoffBrief(agent, requestId, profileId) {
  const prefix = 'kode-handoff-' + digest([agent.id, requestId]) + '-'
  const inputId = prefix + digest(profileId).slice(0, 16)
  const instructions = await readFile(skillFile, 'utf8')
  const events = agent.session.snapshotEvents()
  const prior = events.find(event =>
    (event.type === 'user/message' && event.data.id?.startsWith(prefix)) ||
    (event.type === 'agent/inbox/spliced' && event.data.inserted.some(row => row.id?.startsWith(prefix))))
  const priorId = prior?.type === 'user/message' ? prior.data.id : prior?.data.inserted.find(row => row.id?.startsWith(prefix))?.id
  if (priorId && priorId !== inputId) throw new Error('此交接请求已有其他目标 Agent。')

  let brief = readBrief(agent.session, events, inputId)
  if (!brief) {
    if (!prior) {
      const activeGoal = agent.ctx.sessionProjections?.stateOf(agent.session, 'kodeGoal')?.status === 'active'
      const pending = agent.inbox?.hasPending || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length
      if (agent.status !== 'idle' || agent.maintenance || pending || activeGoal || agent.runtime?.adapter?.hasContinuation?.(agent.id)) {
        throw new Error('请等待源会话完成当前任务，再开始交接。')
      }
      agent.followup({
        id: inputId, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '请执行 Kode 内置交接技能，整理当前任务的交接稿。\n\n' + instructions }],
      })
    }
    let timer
    try {
      await Promise.race([agent.whenIdle(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('交接稿还在生成。可以重试以获取同一次生成的结果。')), 90_000)
        timer.unref()
      })])
    } finally { clearTimeout(timer) }
    brief = readBrief(agent.session, agent.session.snapshotEvents(), inputId)
    if (!brief) throw new Error('源 Agent 未生成交接稿，请重新发起交接。')
  }
  await agent.ctx.sessions.flush(agent.session)
  return brief
}
