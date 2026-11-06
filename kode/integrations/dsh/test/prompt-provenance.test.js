import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILDER_PROMPT,BUILDER_PROMPT_VERSION } from '../src/builder-prompt.js'
import { promptProvenance } from '../src/prompt-provenance.js'
import { COORDINATOR_PROMPT_VERSION,coordinatorPrompt } from '../src/coordinator-context.js'
test('prepared system provenance hashes effective content without retaining prompt or accepting user markers',()=>{
 const binding={managedCoordinator:{team_id:'team'}}
 const options={messages:[{role:'system',content:[{type:'text',text:`header\n${coordinatorPrompt(binding.managedCoordinator)}\nprivate test text`}]}]}
 const proof=promptProvenance(binding,options)
 assert.equal(proof.instruction.version,COORDINATOR_PROMPT_VERSION)
 assert.equal(proof.instruction.role,'coordinator');assert.match(proof.system_sha256,/^[a-f0-9]{64}$/)
 assert.equal(proof.instruction.sha256,proof.system_sha256);assert.equal(proof.system_messages,1)
 assert.ok(!JSON.stringify(proof).includes('private test text'))
 assert.notEqual(promptProvenance(binding,{messages:[{role:'system',content:'changed'}]}).system_sha256,proof.system_sha256)
 assert.equal(promptProvenance(binding,{messages:[{...options.messages[0],role:'user'}]}).instruction,null)
 assert.equal(promptProvenance(binding,{messages:[]}).instruction,null)
 assert.equal(promptProvenance(binding,{messages:[{role:'system',content:COORDINATOR_PROMPT_VERSION}]}).instruction,null,'a version marker alone is insufficient')
})
test('worker provenance binds the validated immutable mandate and effective input hash',()=>{
 const binding={managedAssignment:{id:'assignment'}}
 assert.throws(()=>promptProvenance(binding,{messages:[]}),/unavailable/)
 const receipt={message_id:'message',mandate_sha256:'a'.repeat(64),input_sha256:'b'.repeat(64)}
 const proof=promptProvenance(binding,{messages:[]},receipt)
 assert.deepEqual(proof.instruction,{role:'worker',version:'kode.assignment.mandate.v1',sha256:receipt.input_sha256,assignment_id:'assignment',message_id:'message',mandate_sha256:receipt.mandate_sha256})
 const dependencies=[{id:'method',version:'1',hash:'c'.repeat(64),kind:'skill',source:'fixture://method',source_version:'1',content_hash:'d'.repeat(64)}]
 const extended=promptProvenance(binding,{messages:[]},{...receipt,dependencies})
 assert.deepEqual(extended.instruction.dependencies,dependencies)
 dependencies[0].source='changed';assert.equal(extended.instruction.dependencies[0].source,'fixture://method')
})

test('Builder versions require the actual complete trusted procedure',()=>{
 const binding={managedBuilder:{id:'draft'}}
 assert.equal(promptProvenance(binding,{messages:[{role:'system',content:BUILDER_PROMPT}]}).instruction.version,BUILDER_PROMPT_VERSION)
 assert.equal(promptProvenance(binding,{messages:[{role:'system',content:BUILDER_PROMPT_VERSION}]}).instruction,null)
})

test('Worker prepared provenance freezes compact answer identities without retaining human text', () => {
 const answers=[{question_request_id:'question',message_id:'answer',content_hash:'a'.repeat(64)}]
 const proof=promptProvenance({managedAssignment:{id:'assignment'}},{messages:[]},{message_id:'mandate',mandate_sha256:'b'.repeat(64),input_sha256:'c'.repeat(64),answers})
 assert.deepEqual(proof.instruction.answers,answers)
 answers[0].message_id='changed'
 assert.equal(proof.instruction.answers[0].message_id,'answer')
 assert.equal(JSON.stringify(proof).includes('content"'),false)
})
