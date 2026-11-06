/** Save only Builder-owned proposal fields. Recover committed replies by exact readback,
 * never turn an ambiguous outcome into a second write or a claim of human consent.
 */
import { isDeepStrictEqual } from 'node:util'
function canonicalProposal(value) {
  if(value===null)return null
  const result=structuredClone(value)
  for(const key of ['grant_id','budget_policy_id','scheduling_policy_id'])result[key]??=null
  if(Array.isArray(result.delivery_bindings)&&!result.delivery_bindings.length)delete result.delivery_bindings
  if(Array.isArray(result.execution_targets))for(const target of result.execution_targets){target.effort??=null;if(target.executor_profile_revision===null)delete target.executor_profile_revision}
  return result
}
export async function saveOfficialBuilderDraft(runtime, agent, fixed, operation, args, read) {
  const path=`/api/v1/messaging/superagents/drafts/${encodeURIComponent(fixed.draft_id)}`
  const receiptPath=`${path}/commands/${encodeURIComponent(args.request_id)}`
  const matches = row => row?.id===fixed.draft_id && row.request_id===args.request_id && row.revision===args.expected_revision+1 &&
    row.actor?.kind==='builder' && row.actor.operation_id===operation.id && row.actor.attempt===operation.attempt && row.actor.epoch===operation.epoch &&
    row.actor.node_id===runtime.host && row.actor.session_id===agent.id && isDeepStrictEqual(row.interview?.questions,args.questions) && isDeepStrictEqual(row.interview?.proposed_team,canonicalProposal(args.proposed_team)) && isDeepStrictEqual(row.interview?.proposed_workflow??null,args.proposed_workflow??null)
  const recover = async () => {
    const {receipt}=await runtime.client.call(receiptPath)
    if(receipt && !matches(receipt))throw new Error('Builder save request identity conflict')
    return receipt
  }
  const prior=await recover()
  if(prior)return prior
  const draft=await read()
  if(draft.revision!==args.expected_revision)throw new Error('Builder draft revision conflict')
  const interview=structuredClone(draft.interview)
  interview.questions=structuredClone(args.questions);interview.proposed_team=structuredClone(args.proposed_team)
  if(args.proposed_workflow!=null)interview.proposed_workflow=structuredClone(args.proposed_workflow);else delete interview.proposed_workflow
  const command={id:fixed.draft_id,request_id:args.request_id,expected_revision:args.expected_revision,revoked:false,
    builder_operation:{id:operation.id,attempt:operation.attempt,epoch:operation.epoch},interview}
  try {
    const result=await runtime.client.call('/api/v1/messaging/superagents/drafts',command)
    if(!matches(result))throw new Error('Builder save receipt mismatch')
    return result
  } catch(error) {
    const receipt=await recover()
    if(receipt)return receipt
    // This endpoint's JSON extractor rejects 422 before entering the save
    // transaction. An authoritative rejection plus no receipt has no write to replay.
    if(error.status===422&&error.path==='/api/v1/messaging/superagents/drafts')return {
      status:'rejected',effect:'none',error:{code:'INVALID_BUILDER_PROPOSAL',message:error.message},
      next_action:'Correct the proposed configuration using this schema diagnostic, reread the draft revision, and save with a new request_id.',
    }
    throw error
  }
}
