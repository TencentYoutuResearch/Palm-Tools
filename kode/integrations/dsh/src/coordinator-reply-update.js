import { isDeepStrictEqual } from 'node:util'
import { coordinatorInput } from './coordinator-input.js'
import { deliveryInputId } from './delivery-tracker.js'
/** Bind a publication only to the actual last consumed Host update, never model text. */
export async function coordinatorReplyUpdate(runtime,agent,scope,sourceMessageId){
 const events=agent.session.snapshotEvents?.()??[]
 const latest=events.filter(e=>e.type==='user/message'&&e.data?.id?.startsWith('kode-message-')).at(-1)?.data
 const source=latest?.source
 if(source?.form!=='kode-coordinator-run-update'||source.sourceMessageId!==sourceMessageId)return null
 const valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)
 if(source.kind!=='user'||source.teamId!==scope.team_id||source.conversationId!==scope.conversation_id||!valid(source.runId)||!Number.isSafeInteger(source.revision)||source.revision<1)throw Error('Coordinator reply update scope mismatch')
 const binding=runtime.profiles.binding(agent.id)
 if(binding?.operationClosed||!isDeepStrictEqual(binding?.managedCoordinator,scope))throw Error('Coordinator reply update control changed')
 const {update}=await runtime.client.call(`/api/v1/messaging/work-runs/${encodeURIComponent(source.runId)}/coordinator-updates/${source.revision}`)
 const receipt=update?.receipt
 if(!receipt?.message_id||deliveryInputId(receipt.message_id)!==latest.id)throw Error('Coordinator reply update input identity mismatch')
 const message=await runtime.client.call(`/api/v1/messaging/messages/${encodeURIComponent(receipt.message_id)}`)
 const expected=await coordinatorInput(runtime.client,binding,message,latest.id)
 if(!expected||!isDeepStrictEqual(expected.source,latest.source)||!isDeepStrictEqual(expected.content,latest.content))throw Error('Coordinator reply update differs from authoritative input')
 return {run_id:source.runId,revision:source.revision,message_id:receipt.message_id}
}
