/** Host captures file bytes; model arguments select paths, never supply observation content. */
import { isDeepStrictEqual } from 'node:util'
import { prepareBuilderDraftInspection } from './builder-draft-inspection.js'
export async function observeOfficialBuilderDraft(runtime, agent, fixed, operation, args, read) {
  const receiptPath=`/api/v1/messaging/superagents/drafts/${encodeURIComponent(fixed.draft_id)}/commands/${encodeURIComponent(args.request_id)}`
  const selection={operation:{id:operation.id,attempt:operation.attempt,epoch:operation.epoch},workspace_id:args.workspace_id,paths:args.paths}
  const matches=row=>row?.id===fixed.draft_id&&row.request_id===args.request_id&&row.revision===args.expected_revision+1&&row.actor?.kind==='host_inspection'
    &&row.actor.node_id===runtime.host&&row.actor.session_id===agent.id&&isDeepStrictEqual(row.actor.selection,selection)
  const recover=async()=>{
    const {receipt}=await runtime.client.call(receiptPath)
    if(receipt&&!matches(receipt))throw Error('Builder observation request identity conflict')
    return receipt
  }
  const prior=await recover()
  if(prior)return prior
  await read()
  const slot=runtime.active?.get(agent.id)
  const signal=slot?AbortSignal.any([slot.stop.signal,...(slot.lease?.signal?[slot.lease.signal]:[])]):undefined
  const prepared=await prepareBuilderDraftInspection(runtime.client,runtime.ctx.get('workspaceRegistry'),{...args,draft_id:fixed.draft_id},{signal})
  if((await read()).revision!==args.expected_revision)throw Error('Builder draft revision conflict')
  const command={...prepared.command,host_inspection:selection}
  try{
    const saved=await runtime.client.call('/api/v1/messaging/superagents/drafts',command)
    if(!matches(saved))throw Error('Builder observation receipt mismatch')
    return saved
  }catch(error){
    const receipt=await recover()
    if(receipt)return receipt
    throw error
  }
}
