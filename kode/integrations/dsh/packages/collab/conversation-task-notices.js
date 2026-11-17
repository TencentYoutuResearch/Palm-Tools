/** Live owner-only references. No message history, persisted notices or Worker actions. */
import { validWorkspaceScope, sameWorkspace, teamInWorkspace } from './workspace-scope.js'
import { requestCollabRead } from './data.js'
import { requestDiscussion } from './discussion-model.js'
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const states = new Set(['running','queued','waiting_resource','waiting_user','cancel_unconfirmed','paused','taking_over','completed','failed','cancelled'])
const terminal = state => ['completed','failed','cancelled'].includes(state)
export function validateTaskNotices(team, page, after = '') {
  if (page?.home_hub !== team.home_hub || page.team_id !== team.id || page.conversation_id !== team.conversation_id
    || !Array.isArray(page.items) || page.items.length > 32 || typeof page.unavailable !== 'boolean'
    || (page.next_cursor !== null && (!id(page.next_cursor) || page.next_cursor <= after))) throw Error('Task notice scope changed')
  const seen = new Set()
  for (const row of page.items) {
    if (!['task_id','surface_id','thread_id','run_id'].every(key => id(row?.[key])) || seen.has(row.task_id) || row.task_id <= after
      || row.team_id !== team.id || !validWorkspaceScope(row.scope) || !teamInWorkspace(team,row.scope)
      || !Number.isSafeInteger(row.run_revision) || row.run_revision < 1 || !states.has(row.state)
      || !Number.isSafeInteger(row.question_count) || row.question_count < 0 || row.question_count > 1000
      || (terminal(row.state) && row.question_count !== 0) || typeof row.completion_authorized !== 'boolean'
      || typeof row.title !== 'string' || !row.title.trim() || [...row.title].length > 160 || row.title.includes('\0')
      || typeof row.channel_title !== 'string' || !row.channel_title.trim() || row.channel_title.length > 256
      || typeof row.title_truncated !== 'boolean' || (page.next_cursor !== null && row.task_id > page.next_cursor)) throw Error('Task notice identity changed')
    seen.add(row.task_id)
  }
  return page
}
export function noticeLabel(row) {
  if (row.question_count) return `${row.question_count} 组问题待回答`
  return ({ completed: row.completion_authorized ? '已完成' : '执行已结束，待核验', failed: '执行失败', cancelled: '已取消',
    waiting_user: '需要你确认', cancel_unconfirmed: '停止尚未确认', paused: '已暂停', taking_over: '等待接管' })[row.state] || '请回频道核对'
}
/** Re-read the existing guarded task endpoint before navigation; never fall back to a Run read. */
export async function resolveTaskNotice(team, row, { signal, request = requestCollabRead, discussion = requestDiscussion } = {}) {
  validateTaskNotices(team,{home_hub:team.home_hub,team_id:team.id,conversation_id:team.conversation_id,items:[row],unavailable:false,next_cursor:null})
  const path = '/api/kode/collaboration?' + new URLSearchParams({path:`tasks/${row.task_id}`})
  const matches = task => task?.id === row.task_id && task.team_id === team.id && sameWorkspace(task.scope,row.scope)
    && task.work_run_id === row.run_id && task.archive_surface_id === row.surface_id && task.thread_id === row.thread_id
  const task = await request(path,{signal})
  if (signal?.aborted) return null
  if (!matches(task)) throw Error('Task notice target changed')
  const page = await discussion('surfaces',row.scope,undefined,{signal})
  if (signal?.aborted) return null
  const surface = page?.items?.find(value => value.id === row.surface_id)
  if (!surface || !surface.enabled || surface.kind !== 'channel' || !sameWorkspace(surface.scope,row.scope)
    || surface.team_ids?.length !== 1 || surface.team_ids[0] !== team.id || surface.audience_revision !== task.archive_audience_revision) throw Error('Task notice audience changed')
  // Surface discovery is not task authorization. Recheck after that read, too.
  const current = await request(path,{signal})
  if (signal?.aborted) return null
  if (!matches(current) || current.archive_audience_revision !== surface.audience_revision) throw Error('Task notice target changed')
  return {scope:row.scope,surface,thread:row.thread_id}
}
