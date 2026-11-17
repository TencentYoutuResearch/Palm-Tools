/** Read-only candidate extraction from this draft's own completed native reply.
 * Parsing is not approval. No source message can authorize a save or execution.
 */
import { snapshotPlanningDraft, planningTurnContext } from './planning-draft-context.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { sessionInspector } from './empty-session.js'
import { NATIVE_PLANNING_RECORD, validatePlanningBinding } from './native-planning-session.js'
import { canonicalTeamProposal, ROLE_PROMPT_MAX_BYTES } from './team-role-prompts.js'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fail = (code, text) => Object.assign(Error(text), { code })
export const BUILDER_CANDIDATE_FORMAT = 'kode.team-proposal.v1'
export function parseBuilderProposalCandidate(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 131072) throw fail('PROPOSAL_INVALID', 'Candidate reply is too large')
  const blocks = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)].map(match => match[1])
  if (!blocks.length) blocks.push(text)
  const candidates = []
  for (const block of blocks) {
    let value
    try { value = JSON.parse(block) } catch {
      if (block.includes(BUILDER_CANDIDATE_FORMAT)) throw fail('PROPOSAL_INVALID', 'Declared candidate JSON is malformed')
      continue
    }
    if (value?.format !== BUILDER_CANDIDATE_FORMAT) continue
    if (!object(value) || Object.keys(value).some(k => !['format', 'proposed_team', 'proposed_workflow'].includes(k)) || !object(value.proposed_team)
      || value.proposed_workflow !== undefined && value.proposed_workflow !== null && !object(value.proposed_workflow)) throw fail('PROPOSAL_INVALID', 'Candidate envelope is invalid')
    const proposed_team = canonicalTeamProposal(value.proposed_team)
    if (Buffer.byteLength(JSON.stringify(proposed_team)) > 65536) throw fail('PROPOSAL_INVALID', 'Team candidate exceeds 65536 UTF-8 bytes')
    candidates.push({ proposed_team, ...(value.proposed_workflow === undefined ? {} : { proposed_workflow: value.proposed_workflow }) })
  }
  if (candidates.length > 1) throw fail('PROPOSAL_AMBIGUOUS', 'Latest reply contains multiple candidates; ask for one complete candidate')
  return candidates[0] ?? null
}
export function completedProposalReply(events) {
  if (!Array.isArray(events)) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Planning history is unavailable')
  const started = events.findLast(event => event.type === 'turn/start'), ended = events.findLast(event => event.type === 'turn/end')
  if (!started || !ended || started.seq > ended.seq || started.data?.turn !== ended.data?.turn || ended.data?.reason?.kind !== 'completed') return null
  const reply = events.findLast(event => event.type === 'assistant/message' && event.data?.turn === ended.data.turn && event.seq < ended.seq
    && !event.data.interrupted && event.data.message?.role === 'assistant' && event.data.message?.source?.kind === 'model'
    && event.data.message?.content?.some(part => part.type === 'text' && typeof part.text === 'string'))
  if (!reply || typeof reply.data.message.id !== 'string') return null
  const text = reply.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  return { message_id: reply.data.message.id, turn: ended.data.turn, sha256: createHash('sha256').update(text).digest('hex'), text }
}
export async function readBuilderProposalCandidate(ctx, backend, draftId) {
  if (!valid(draftId)) throw fail('PROPOSAL_INVALID', 'Draft identity required')
  const draft = await backend.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draftId)}`)
  if (draft.id !== draftId || draft.status !== 'draft' || !valid(draft.home_hub)) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Editable draft unavailable')
  const result = { format: BUILDER_CANDIDATE_FORMAT, draft_id: draftId, draft_revision: draft.revision, home_hub: draft.home_hub,
    prompt_max_bytes: ROLE_PROMPT_MAX_BYTES, team_max_bytes: 65536, saved_proposal: draft.interview.proposed_team ?? null,
    saved_workflow: draft.interview.proposed_workflow ?? null, candidate: null, source: null, state: 'not_created',
    owner_review_required: true, eligible_for_execution: false }
  const planning = ctx.get?.('kodePlanningRuntime')
  if (!planning) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Planning registry unavailable')
  const navigation = await planning.inspect(draftId)
  if (navigation.home_hub !== draft.home_hub || navigation.draft_id !== draftId) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Planning draft identity changed')
  if (navigation.state !== 'ready') return { ...result, state: navigation.state }
  const admission = await planning.sessionAdmission(navigation.session_id, { mode: 'restore' })
  const binding = validatePlanningBinding(admission?.binding)
  if (binding.draft_id !== draftId || binding.home_hub !== draft.home_hub || binding.session_id !== navigation.session_id) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Planning source identity changed')
  const agent = ctx.get?.('agents')?.get(binding.session_id)
  const inspector = sessionInspector(ctx.get?.('sessionController'), ctx.get?.('sessionQuery'))
  if (!agent && !inspector) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Read-only planning history unavailable')
  const observed = agent ? { header: agent.session.header, events: structuredClone(agent.session.snapshotEvents()) } : await inspector(binding.session_id)
  const markers = observed.events?.filter(event => event.type === NATIVE_PLANNING_RECORD) ?? []
  if (observed.header?.id !== binding.session_id || observed.header.cwd !== binding.cwd || observed.header.parentSession !== undefined || observed.header.parentSessionId !== undefined
    || observed.header.isSeeded || (observed.inheritedEventCount ?? 0) !== 0
    || markers.length !== 1 || !isDeepStrictEqual(markers[0].data, binding)) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Planning journal does not match this draft')
  const latest = await planning.sessionAdmission(binding.session_id, { mode: 'restore' })
  if (!isDeepStrictEqual(latest.binding, binding)) throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Planning source changed while reading')
  const currentDraft = await backend.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draftId)}`)
  if (currentDraft.id !== draftId || currentDraft.home_hub !== draft.home_hub || currentDraft.status !== 'draft' || currentDraft.revision !== draft.revision) throw fail('PROPOSAL_DRAFT_CHANGED', 'Draft changed while reading candidate; refresh before reviewing')
  if (typeof planning.readContext !== 'function') throw fail('PROPOSAL_SOURCE_UNAVAILABLE', 'Active planning context verification unavailable')
  const activeContext = await planning.readContext(binding.session_id)
  if (!isDeepStrictEqual(activeContext, snapshotPlanningDraft(binding, currentDraft, activeContext?.data))) throw fail('PROPOSAL_DRAFT_CHANGED', 'Active planning context changed while reading candidate')
  const reply = completedProposalReply(observed.events)
  if (!reply) return { ...result, state: 'no_completed_reply' }
  const { snapshot } = planningTurnContext(observed.events, binding, reply.turn)
  if (!isDeepStrictEqual(snapshot, snapshotPlanningDraft(binding, currentDraft, snapshot.data))) throw fail('PROPOSAL_DRAFT_CHANGED', 'This reply was generated from an older draft context; it is not a candidate for the current revision')
  const candidate = parseBuilderProposalCandidate(reply.text)
  return { ...result, state: candidate ? 'candidate' : 'no_candidate', candidate,
    source: { draft_revision: snapshot.draft_revision, context_sha256: snapshot.sha256, session_id: binding.session_id, message_id: reply.message_id, turn: reply.turn, sha256: reply.sha256 } }
}
