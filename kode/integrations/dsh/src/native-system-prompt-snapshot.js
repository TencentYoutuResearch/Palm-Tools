import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
export const NATIVE_SYSTEM_PROMPT_RECORD='plugin:kode/native-system-prompt'
export function createNativeSystemPromptBinder({session,canInitialize,flush}) {
 return async ({text,mode})=>{
  if(typeof text!=='string'||!text||!['fresh','restore'].includes(mode))throw Error('Invalid native system prompt snapshot')
  const data={version:1,session_id:session.id,transport:'codebuddy_cli_append',sha256:createHash('sha256').update(text).digest('hex')}
  const rows=Session.prototype.snapshotEvents.call(session).filter(e=>e.type===NATIVE_SYSTEM_PROMPT_RECORD)
  if(rows.length>1||rows.length===1&&!isDeepStrictEqual(rows[0].data,data))throw Error('Native system prompt changed; new explicit session required')
  if(!rows.length){if(mode!=='fresh'||!canInitialize())throw Error('Existing native thread lacks frozen system prompt');appendPluginRecord(session,NATIVE_SYSTEM_PROMPT_RECORD,data)}
  if(await flush()!==true)throw Error('Native system prompt snapshot not durable')
  return data.sha256
 }
}
