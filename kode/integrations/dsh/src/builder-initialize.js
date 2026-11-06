/** Freeze the chosen interview before startup; recover committed saves using the original receipt. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { prepareBuilderInterview } from './builder-interview.js'

export async function initializeBuilderInterview(client,start,signal){
  const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
  if(!valid(start?.draft_id)||!valid(start?.operation?.owner_session)||!valid(start?.operation?.request_key)
      ||!Number.isSafeInteger(start.draft_revision)||start.draft_revision<1||start.draft_revision>=Number.MAX_SAFE_INTEGER)throw new Error('Invalid Builder interview initialization')
  const request_id=`builder-interview-${createHash('sha256').update(JSON.stringify([start.operation.owner_session,start.operation.request_key,start.draft_id,start.draft_revision])).digest('hex')}`
  const path=`/api/v1/messaging/superagents/drafts/${encodeURIComponent(start.draft_id)}`
  const call=(p,b)=>client.call(p,b,signal)
  const verify=(receipt,command)=>{
    if(!receipt||receipt.id!==start.draft_id||receipt.request_id!==request_id||receipt.revision!==start.draft_revision+1
        ||receipt.status!=='draft'||receipt.actor?.kind!=='human'||!receipt.interview.questionnaire
        ||(command&&!isDeepStrictEqual(receipt.interview,JSON.parse(JSON.stringify(command.interview)))))throw new Error('Builder interview initialization receipt mismatch')
    return receipt
  }
  const receiptPath=`${path}/commands/${request_id}`
  const previous=(await call(receiptPath)).receipt
  if(previous)return verify(previous)
  const draft=await call(path)
  if(draft.status!=='draft'||draft.revision!==start.draft_revision)throw new Error('Builder interview initialization revision conflict')
  let command
  if(draft.interview.questionnaire){
    command={id:draft.id,request_id,expected_revision:draft.revision,revoked:false,interview:draft.interview}
  }else{
    if(Object.keys(draft.interview.answers).length||draft.interview.proposed_team)throw new Error('Select an interview plan explicitly before starting a populated draft')
    command=(await prepareBuilderInterview(client,{draft_id:draft.id,request_id,expected_revision:draft.revision})).command
  }
  signal?.throwIfAborted()
  try{return verify(await call('/api/v1/messaging/superagents/drafts',command),command)}catch(error){
    const saved=(await call(receiptPath)).receipt
    if(saved)return verify(saved,command)
    throw error
  }
}
