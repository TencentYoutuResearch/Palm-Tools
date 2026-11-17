/** Explicit owner handoff of a candidate from ordinary native chat.
 * Saving a proposal is not accepting a Team or authorizing its execution.
 */
import { isDeepStrictEqual } from 'node:util'
import { canonicalTeamProposal } from './team-role-prompts.js'
import { readBuilderProposalCandidate } from './builder-proposal-candidate.js'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export async function saveBuilderProposal(backend, input) {
  if (!input || Object.keys(input).some(k => !['draft_id', 'request_id', 'expected_revision', 'proposed_team', 'proposed_workflow'].includes(k))
    || !valid(input.draft_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
    || !object(input.proposed_team) || input.proposed_workflow !== undefined && input.proposed_workflow !== null && !object(input.proposed_workflow)
    || Buffer.byteLength(JSON.stringify(input)) > 131072) throw Object.assign(Error('Invalid candidate proposal'), { code: 'PROPOSAL_INVALID' })
  input = structuredClone(input)
  input.proposed_team = canonicalTeamProposal(input.proposed_team)
  if (Buffer.byteLength(JSON.stringify(input.proposed_team)) > 65536) throw Object.assign(Error('Team candidate exceeds 65536 UTF-8 bytes'), { code: 'PROPOSAL_INVALID' })
  const path = `/api/v1/messaging/superagents/drafts/${encodeURIComponent(input.draft_id)}`
  const prior = await backend.call(`${path}/commands/${encodeURIComponent(input.request_id)}`)
  if (prior.receipt) {
    const saved = prior.receipt
    if (saved.id !== input.draft_id || saved.request_id !== input.request_id || saved.revision !== input.expected_revision + 1
      || saved.eligible_for_execution !== false || !isDeepStrictEqual(saved.interview?.proposed_team, input.proposed_team)
      || input.proposed_workflow !== undefined && !isDeepStrictEqual(saved.interview?.proposed_workflow, input.proposed_workflow)) throw Error('Candidate request identity conflict')
    return saved
  }
  if (prior.receipt !== null) throw Error('Candidate outcome is uncertain')
  const [draft, selected] = await Promise.all([backend.call(path), backend.call(`${path}/selection`)])
  if (draft.id !== input.draft_id || draft.revision !== input.expected_revision || draft.status !== 'draft'
    || selected.draft_id !== input.draft_id || selected.home_hub !== draft.home_hub || selected.runtime_binding) throw Object.assign(Error('Draft changed or has a controlled Builder operation'), { code: 'PROPOSAL_DRAFT_CHANGED' })
  const allowed = draft.interview.workspace_refs
  if (!Array.isArray(input.proposed_team.workspace_refs) || input.proposed_team.workspace_refs.some(ref => !allowed.some(w => isDeepStrictEqual(w, ref)))) throw Object.assign(Error('Candidate workspace outside draft selection'), { code: 'PROPOSAL_INVALID' })
  // The backend deserializes the existing TeamSpec schema. Full semantic Team
  // validation remains in accept-proposal/save_team_in; no execution is implied.
  try {
    return await backend.call('/api/v1/messaging/superagents/drafts', { id: input.draft_id, request_id: input.request_id,
      expected_revision: input.expected_revision, revoked: false, interview: { ...draft.interview, proposed_team: input.proposed_team,
        ...(input.proposed_workflow === undefined ? {} : { proposed_workflow: input.proposed_workflow }) } })
  } catch (error) {
    // Once a write was attempted, even a response carrying a validation-like
    // code must never unlock the owner's form. Reconcile the exact receipt.
    throw Object.assign(Error('Candidate save outcome is unconfirmed', { cause: error }), { code: 'PROPOSAL_SAVE_UNCONFIRMED' })
  }
}
export function registerBuilderProposal(ctx, { backendClient }) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/proposal', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { code: 'AUTHENTICATION_REQUIRED', error: 'Authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { code: 'OWNER_REQUIRED', error: 'Host owner required' })
    if (req.method === 'GET') {
      if (!backendClient) return send(503, { code: 'BACKEND_UNAVAILABLE', error: 'Builder backend unavailable' })
      const query = new URL(req.url, 'http://localhost').searchParams
      if ([...query.keys()].length !== 1 || !query.has('draft_id')) return send(400, { code: 'PROPOSAL_INVALID', error: 'Draft identity required' })
      try { return send(200, await readBuilderProposalCandidate(ctx, backendClient, query.get('draft_id'))) }
      catch (error) { const safe = /^(PROPOSAL_|ROLE_PROMPT_|DRAFT_|PLANNING_|CONTROLLED_BUILDER_)/.test(error.code ?? ''); return send(409, { code: safe ? error.code : 'PROPOSAL_SOURCE_UNAVAILABLE', error: safe ? error.message : 'Candidate source could not be verified', eligible_for_execution: false }) }
    }
    if (req.method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED', error: 'GET or POST required' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { code: 'JSON_REQUIRED', error: 'JSON required' })
    if (!backendClient) return send(503, { code: 'BACKEND_UNAVAILABLE', error: 'Builder backend unavailable' })
    let bytes = 0; const chunks = []
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length
      if (bytes > 131072) return send(413, { code: 'PROPOSAL_INVALID', error: 'Candidate proposal too large' })
      chunks.push(chunk)
    }
    let input
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { code: 'PROPOSAL_INVALID', error: 'Invalid JSON' }) }
    try { return send(200, await saveBuilderProposal(backendClient, input)) }
    catch (error) {
      if (['ROLE_PROMPT_INVALID', 'PROPOSAL_INVALID', 'PROPOSAL_DRAFT_CHANGED'].includes(error.code)) return send(error.code === 'PROPOSAL_DRAFT_CHANGED' ? 409 : 400, { code: error.code, error: error.message, eligible_for_execution: false })
      return send(409, { code: 'PROPOSAL_SAVE_UNCONFIRMED', error: 'Candidate was not confirmed; inspect the draft or retry the exact request', retry: 'same_request', eligible_for_execution: false })
    }
  } })
}
