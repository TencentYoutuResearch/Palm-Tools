/** Non-success journal evidence only. Never returns execution or replay authority. */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual as equal} from 'node:util'
import {deliveryInputId} from './delivery-tracker.js'
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex')
const reject=()=>{throw Error('Exact approval-rejected terminal evidence unavailable')}
export function interactiveInterruptionProof({binding:b,receipt:r,message:m,header,events},turnId){
 if(!b||!r||!m||!['claimed','interrupted'].includes(r.state)||r.binding_id!==b.binding_id||r.native_session_id!==b.native_session_id||r.source_message_id!==m.id||hash(m.content)!==r.source_content_sha256||!equal(m.actor,{kind:'human',id:'local_owner'})||m.surface_id!==b.surface_id||m.thread_id!==b.thread_id||header?.id!==b.native_session_id||header.cwd!==b.workspace.root_ref||header.parentSession||header.parentSessionId||header.isSeeded||!Array.isArray(events))reject()
 const identities=events.filter(e=>e.type==='plugin:kode/interactive-team'),markers=events.filter(e=>e.type==='plugin:kode/interactive-team-input'&&e.data.receipt_id===r.receipt_id)
 if(identities.length!==1||identities[0].seq!==0||!equal(identities[0].data.binding,b)||markers.length!==1)reject()
 const marker=markers[0],d=marker.data,inputId=deliveryInputId(r.receipt_id)
 if(d.binding_id!==b.binding_id||d.native_session_id!==b.native_session_id||d.source_message_id!==m.id||d.source_content_sha256!==r.source_content_sha256||d.input_id!==inputId)reject()
 const users=events.filter(e=>e.type==='user/message'&&e.data.id===inputId)
 if(users.length!==1||!equal(users[0].data.content,[{type:'text',text:m.content}]))reject()
 const user=users[0],start=events.findLast(e=>e.type==='turn/start'&&e.seq<user.seq),turn=start?.data.turn
 if(!Number.isSafeInteger(turn)||turn<1||turnId!==undefined&&turn!==turnId||marker.seq>=start.seq)reject()
 const ends=events.filter(e=>e.type==='turn/end'&&e.data.turn===turn)
 if(ends.length!==1)reject()
 const end=ends[0],part=events.filter(e=>e.seq>start.seq&&e.seq<end.seq)
 if(end.data.reason?.kind!=='interrupted'||events.at(-1)!==end||part.filter(e=>e.type==='user/message').length!==1)reject()
 const decided=part.findLast(e=>e.type==='approval/decided'&&e.data.outcome==='rejected')
 const asked=decided&&part.find(e=>e.type==='approval/asked'&&e.data.id===decided.data.id&&e.seq<decided.seq)
 const call=asked&&part.find(e=>e.type==='tool/call'&&e.data.callId===asked.data.callId&&e.seq<=asked.seq)
 const stop=decided&&part.findLast(e=>e.type==='plugin:kode/native-event'&&e.data.event?.method==='kode/process_stop'&&e.seq>decided.seq)
 const p=stop?.data.event.params
 if(!asked||!call||!stop||p.leader_exited!==true||p.process_group_empty!==true||p.stopBlocked!==false||p.exit_code!==0||p.exit_signal!=null||!Array.isArray(p.signal_failures)||p.signal_failures.length||!p.inputIds?.includes(inputId))reject()
 return {request_id:`interrupted:${r.receipt_id}`,receipt_id:r.receipt_id,source_message_id:m.id,native_session_id:b.native_session_id,journal_id:b.native_session_id,turn_id:String(turn),header_sha256:hash(header),source_marker_sha256:hash(marker),terminal_sha256:hash(end),approval_sha256:hash({asked,decided,call}),process_stop_sha256:hash(stop),cause:'approval_rejected'}
}
