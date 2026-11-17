import test from 'node:test'
import assert from 'node:assert/strict'
import {createScopedRolePromptResolver} from '../src/native-scoped-role-prompt.js'
function fixture(change={}){
 const authority={context_key:'key',session_id:'session',team_revision:3,context_scope:{kind:'discussion_thread',team_id:'team',home_hub:'home'}}
 const row={authority,source_read_allowed:true,dispatch_allowed:false,host_binding:{state:'bound_not_admitted',revision:1,frozen:{context:{key:'key',team_revision:3,context_scope:authority.context_scope}}}}
 row.team_snapshot={id:'team',home_hub:'home',revision:3,...change.team,spec:{coordinator_prompt:change.absent?null:'Role canary',workers:[{id:'worker',role_prompt:'FOREIGN_WORKER'}]}}
 const calls=[];let reads=0
 const resolve=createScopedRolePromptResolver({ownsAgent:()=>!change.foreign,sourceAuthority:async()=>{reads++;calls.push(['team',3]);return change.revoke&&reads===2?{...row,source_read_allowed:false}:structuredClone(row)},readTeam:async(id,rev)=>{calls.push([id,rev]);return {id,home_hub:'home',revision:rev,...change.team,spec:{coordinator_prompt:change.absent?null:'Role canary',workers:[{id:'worker',role_prompt:'FOREIGN_WORKER'}]}}}})
 return {resolve,authority,calls}
}
test('Coordinator loads only frozen saved Team revision, not another role',async()=>{const f=fixture();const r=await f.resolve({id:'session'},{authority:f.authority,mode:'fresh'});assert.equal(r.text,'Role canary');assert.deepEqual(r.role,{kind:'coordinator'});assert.deepEqual(f.calls,[['team',3],['team',3]])})
test('absent configured prompt returns null without inventing a role',async()=>{const f=fixture({absent:true});assert.equal(await f.resolve({id:'session'},{authority:f.authority,mode:'check'}),null)})
test('foreign caller does not read Team',async()=>{const f=fixture({foreign:true});await assert.rejects(f.resolve({id:'session'},{authority:f.authority,mode:'fresh'}));assert.equal(f.calls.length,0)})
test('wrong Team, home, revision and revocation reject',async()=>{for(const change of [{team:{id:'other'}},{team:{home_hub:'other'}},{team:{revision:4}},{revoke:true}]){const f=fixture(change);await assert.rejects(f.resolve({id:'session'},{authority:f.authority,mode:'restore'}))}})
