import { canonical } from './builder-accept-command.js'
import { fetchPlanning } from './builder-planning.js'
import { withPrompt, promptTooLong, teamBytes } from './role-prompt.js'
/**
 * A planning reply is only a candidate. GET reads the bound planning Session's latest
 * completed turn (public assistant output only) and never writes; the owner edits it
 * here and explicitly saves it through the original POST /api/kode/builder/proposal.
 * Accepting the saved proposal as a Team remains the separate accept/CAS step below.
 */
const STATES = ['candidate', 'no_candidate', 'no_completed_reply', 'not_created', 'uncertain']
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
export async function readProposalCandidate(draft, { signal, fetcher } = {}) {
  const value = await fetchPlanning(`/api/kode/builder/proposal?draft_id=${encodeURIComponent(draft.id)}`, { signal, fetcher })
  if (!object(value) || value.format !== 'kode.team-proposal.v1' || value.draft_id !== draft.id || value.home_hub !== draft.home_hub
    || value.owner_review_required !== true || value.eligible_for_execution !== false || !STATES.includes(value.state)
    || !Number.isSafeInteger(value.draft_revision) || !positive(value.prompt_max_bytes) || !positive(value.team_max_bytes)
    || (value.state === 'candidate') !== (value.candidate !== null) || value.candidate !== null && !object(value.candidate?.proposed_team)
    || value.saved_proposal !== null && !object(value.saved_proposal)) throw Object.assign(Error('Invalid candidate response'), { code: 'PROPOSAL_RESPONSE_INVALID' })
  return value
}

export const candidateSaveKey = draft => JSON.stringify(['builder-proposal-candidate', draft.home_hub, draft.id, draft.revision])
export function verifyCandidateSave(draft, command, row) {
  if (!row || row.id !== draft.id || row.home_hub !== draft.home_hub || row.revision !== command.expected_revision + 1 || row.eligible_for_execution !== false
    || canonical(row.interview?.proposed_team) !== canonical(command.proposed_team)) throw Error('Candidate receipt mismatch')
  return row
}
/** Codes the service returns only when this request saved nothing; any other failure stays recoverable. */
const REJECTED = ['ROLE_PROMPT_INVALID', 'PROPOSAL_INVALID', 'PROPOSAL_DRAFT_CHANGED']
/** One request id per draft revision: a lost response is recovered by resending the same command. */
export async function saveProposalCandidate({ draft, command, storage, signal, fetcher }) {
  const key = candidateSaveKey(draft), record = await storage.reserve(key, { state: 'prepared', command }, current => current.state === 'rejected')
  if (canonical(record.command) !== canonical(command)) throw Object.assign(Error('Recover the original pending save'), { code: 'PENDING_SAVE' })
  if (signal?.aborted) throw Error('Disposed')
  let result
  try { result = record.state === 'saved' ? record.receipt : await fetchPlanning('/api/kode/builder/proposal', { method: 'POST', body: record.command, signal, fetcher }) }
  catch (error) {
    // A confirmed rejection frees the slot for a corrected edit; it never resends.
    if ([400, 409].includes(error?.status) && REJECTED.includes(error.code)) await storage.save(key, { ...record, state: 'rejected', code: error.code }).catch(() => {})
    throw error
  }
  const row = verifyCandidateSave(draft, record.command, result)
  if (record.state !== 'saved') await storage.save(key, { ...record, state: 'saved', receipt: row })
  return row
}

export const stateText = {
  not_created: '还没有开始规划会话。开始规划并收到 Agent 的完整回复后，可以在这里读取其中的团队方案候选。',
  no_completed_reply: '规划会话还没有已完成的回复。Agent 回复完成后再重新读取；正在生成、工具调用和推理过程都不会被读取。',
  no_candidate: '最近一条已完成的回复里没有团队方案候选。需要时，在规划会话里请 Agent 按 kode.team-proposal.v1 格式给出完整方案。',
  uncertain: '上次开始规划没有收到确认，无法确定应读取哪个规划会话。请先在对话中恢复或重新查询规划状态。',
}
export function candidateError(error) {
  switch (error?.code) {
    case 'PROPOSAL_DRAFT_CHANGED': return '草案在读取期间已更新。请刷新草案后再审核候选；没有保存任何内容。'
    case 'PROPOSAL_AMBIGUOUS': return '最近一条回复里有不止一份团队方案，无法确定是哪一份。请在规划会话里让 Agent 只给出一份。'
    case 'PROPOSAL_INVALID': return '团队方案格式不正确或超出大小上限（需要 kode.team-proposal.v1，整个团队不超过 64 KiB）。没有保存任何内容；可以在规划会话里请 Agent 修正后重新给出。'
    case 'PROPOSAL_SOURCE_UNAVAILABLE': return '暂时无法读取规划会话的回复记录。没有保存任何内容，请稍后重新读取。'
    case 'ROLE_PROMPT_INVALID': return '有角色指令不符合要求：不能只有空白，且每段不超过 16000 字节。没有保存。'
    case 'PROPOSAL_RESPONSE_INVALID': return '服务返回的候选不属于此草案或格式无法识别，没有显示也没有保存。'
    case 'PENDING_SAVE': return '本机有一次尚未确认的保存。请先恢复原保存请求；它会原样重发，不会重复保存。'
  }
  if (error?.status === 404 || error?.status === 405) return '读取方案候选的服务尚未部署到当前 Kode 服务。'
  return '没有确认结果，请重试。'
}

export const toForm = spec => ({ name: spec.name ?? '', purpose: spec.purpose ?? '', coordinator_prompt: spec.coordinator_prompt ?? '',
  workers: (Array.isArray(spec.workers) ? spec.workers : []).map(row => ({ id: row.id, role: row.role ?? '', responsibilities: Array.isArray(row.responsibilities) ? row.responsibilities.join('\n') : '', role_prompt: row.role_prompt ?? '' })) })
/** Only the fields shown are edited; every other TeamSpec field is carried through unchanged, keyed by worker.id. */
export function applyCandidateForm(spec, form) {
  const next = withPrompt({ ...structuredClone(spec), name: form.name.trim(), purpose: form.purpose.trim() }, 'coordinator_prompt', form.coordinator_prompt)
  next.workers = (spec.workers ?? []).map(original => {
    const row = form.workers.find(item => item.id === original.id)
    const responsibilities = row.responsibilities.split('\n').map(item => item.trim()).filter(Boolean)
    return withPrompt({ ...structuredClone(original), role: row.role.trim(), responsibilities }, 'role_prompt', row.role_prompt)
  })
  return next
}
export function candidateProblems(spec, form, limits) {
  const problems = []
  if (!form.name.trim()) problems.push('团队名称不能为空。')
  for (const row of form.workers) {
    if (!row.role.trim()) problems.push(`成员 ${row.id} 需要职责名称。`)
    if (!row.responsibilities.trim()) problems.push(`${row.role || row.id} 需要至少一项职责说明。`)
    if (promptTooLong(row.role_prompt, limits.prompt)) problems.push(`${row.role || row.id} 的角色指令超出 ${limits.prompt} 字节。`)
  }
  if (promptTooLong(form.coordinator_prompt, limits.prompt)) problems.push(`协调者指令超出 ${limits.prompt} 字节。`)
  if (!problems.length && teamBytes(applyCandidateForm(spec, form)) > limits.team) problems.push(`整个团队方案超出 ${Math.floor(limits.team / 1024)} KiB 上限，请缩短指令或说明。`)
  return problems
}
