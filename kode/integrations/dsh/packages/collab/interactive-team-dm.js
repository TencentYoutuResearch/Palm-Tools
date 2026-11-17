import { discussionScope, discussionKey, sameDiscussionScope, requestDiscussion } from './discussion-model.js'

/** Existing discussion DMs are distinct from the legacy Team conversation.
 * Never infer identity from a matching name, adopt a channel, or create a surface.
 */
export function interactiveDmScope(team, scope) {
  if (team?.spec?.execution_mode !== 'interactive_native' || !scope
    || team.home_hub !== scope.home_hub || !team.spec.workspace_refs?.some(ref =>
      ref.host_id === scope.host_id && ref.workspace_id === scope.workspace_id && ref.root_ref === scope.root_ref)) throw Error('请先选择这个团队所属的工作区。')
  return discussionScope(scope)
}
export function existingInteractiveDms(team, scope, page) {
  interactiveDmScope(team, scope)
  if (!sameDiscussionScope(page?.scope, scope) || !Array.isArray(page?.items)
    || page.items.some(row => !sameDiscussionScope(row?.scope, scope))) throw Error('私信目录的工作区不一致，请重新读取。')
  const rows = page.items.filter(row => row.kind === 'dm' && row.enabled === true
    && Array.isArray(row.team_ids) && row.team_ids.length === 1 && row.team_ids[0] === team.id)
  if (rows.some(row => typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.id)
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isSafeInteger(row.audience_revision) || row.audience_revision < 1)
    || new Set(rows.map(row => row.id)).size !== rows.length) throw Error('私信目录版本无效，请重新读取。')
  return rows
}
export async function readInteractiveDms({ team, scope, signal, request = requestDiscussion }) {
  const exact = interactiveDmScope(team, scope)
  if (signal?.aborted) throw Error('Disposed')
  const page = await request('surfaces', exact, undefined, { signal })
  if (signal?.aborted) throw Error('Disposed')
  return existingInteractiveDms(team, exact, page)
}
export async function selectInteractiveDm({ team, scope, surfaceId, signal, request }) {
  if (!surfaceId) throw Error('请选择一个已有原生私信。')
  const rows = await readInteractiveDms({ team, scope, signal, request })
  const surface = rows.find(row => row.id === surfaceId)
  if (!surface) throw Error('所选私信已变化或不可用，请重新读取后选择。')
  return { scope: discussionScope(scope), surface, thread: null }
}

export function primaryInteractiveDm(rows) {
  return [...rows].sort((a, b) => {
    const time = row => Date.parse(row.last_activity_at ?? row.updated_at ?? row.created_at ?? '') || 0
    return time(a) - time(b)
  }).at(-1) ?? null
}

/** Open the single long-lived native DM for this exact team/workspace. Creation is
 * idempotent: an unconfirmed request remains in local storage and is reused. */
export async function openPrimaryInteractiveDm({ team, scope, storage, signal, request = requestDiscussion }) {
  const exact = interactiveDmScope(team, scope)
  const existing = await readInteractiveDms({ team, scope: exact, signal, request })
  if (existing.length) return { scope: exact, surface: primaryInteractiveDm(existing), thread: null }
  const key = `kode.discussion.create.primary:${discussionKey(exact)}:${team.id}`
  let saved = null
  try { saved = JSON.parse(storage?.getItem(key) ?? 'null') } catch { throw Error('无法读取私信创建记录，请恢复本地存储后重试。') }
  if (saved && (saved.input?.kind !== 'dm' || !sameDiscussionScope(saved.input.scope, exact)
    || saved.input.team_ids?.length !== 1 || saved.input.team_ids[0] !== team.id)) throw Error('私信创建记录不属于当前团队和工作区。')
  const pending = saved ?? { id: crypto.randomUUID(), input: {
    request_id: crypto.randomUUID(), expected_revision: 0, scope: exact, kind: 'dm',
    title: team.spec?.name || '团队私信', team_ids: [team.id], enabled: true,
  } }
  try { storage?.setItem(key, JSON.stringify(pending)) } catch { throw Error('无法保存私信创建记录，请检查浏览器存储权限。') }
  const surface = await request('surfaces/' + pending.id, {}, pending.input, { signal })
  const [valid] = existingInteractiveDms(team, exact, { scope: exact, items: [surface] })
  if (!valid || valid.id !== pending.id || valid.title !== pending.input.title) throw Error('原生私信创建回执不匹配。')
  try { storage?.removeItem(key) } catch {}
  return { scope: exact, surface: valid, thread: null }
}
