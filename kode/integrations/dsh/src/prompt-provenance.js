/** Hash the actual prepared input; never persist prompt bodies or infer old versions. */
import { createHash } from 'node:crypto'
import { BUILDER_PROMPT_VERSION,BUILDER_PROMPT } from './builder-prompt.js'
import { COORDINATOR_PROMPT_VERSION,coordinatorPrompt } from './coordinator-context.js'
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const texts=content=>typeof content==='string'?[content]:Array.isArray(content)?content.filter(row=>row?.type==='text'&&typeof row.text==='string').map(row=>row.text):[]
export function promptProvenance(binding,options,assignment){
 const systems=(options.messages??[]).filter(row=>row.role==='system').map(row=>row.content)
 const system_sha256=hash(systems)
 let instruction=null
 if(binding.managedAssignment){
  if(!assignment)throw Error('Assignment prompt provenance unavailable')
  instruction={role:'worker',version:'kode.assignment.mandate.v1',sha256:assignment.input_sha256,assignment_id:binding.managedAssignment.id,message_id:assignment.message_id,mandate_sha256:assignment.mandate_sha256}
  if(assignment.dependencies?.length)instruction.dependencies=structuredClone(assignment.dependencies)
  if(assignment.answers?.length)instruction.answers=structuredClone(assignment.answers)
 }else{
  const role=binding.managedBuilder?'builder':binding.managedCoordinator?'coordinator':null
  const version=role==='builder'?BUILDER_PROMPT_VERSION:COORDINATOR_PROMPT_VERSION
  const expected=role==='builder'?BUILDER_PROMPT:role==='coordinator'?coordinatorPrompt(binding.managedCoordinator):null
  // Require the full trusted section; a marker in project/user text cannot opt in.
  if(expected&&systems.flatMap(texts).some(text=>text.includes(expected)))instruction={role,version,sha256:system_sha256}
 }
 return {schema_version:1,source:'official_prepared_input',system_sha256,system_messages:systems.length,instruction}
}
