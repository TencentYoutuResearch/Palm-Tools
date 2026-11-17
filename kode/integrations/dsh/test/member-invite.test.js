import test from 'node:test'
import assert from 'node:assert/strict'
import {eligibleChannelTeams,createChannelInvite,acceptChannelInvite,validateChannelInvite,inviteStorageKey} from '../packages/collab/member-invite.js'
const scope={home_hub:'local',host_id:'local',workspace_id:'w',root_ref:'/fixture/project'}
const surface={id:'channel',kind:'channel',title:'开发',scope,team_ids:['existing'],enabled:true,revision:3}
const teams=['existing','new'].map(id=>({id,home_hub:'local',spec:{workspace_refs:[scope]}}))
test('eligible membership is exact scope, excludes current members and private surfaces',()=>{
 assert.deepEqual(eligibleChannelTeams(surface,teams).map(t=>t.id),['new'])
 for(const field of Object.keys(scope)){const wrong=structuredClone(teams[1]);if(field==='home_hub')wrong.home_hub='other';else wrong.spec.workspace_refs[0][field]='other';assert.equal(eligibleChannelTeams(surface,[wrong]).length,0)}
 assert.deepEqual(eligibleChannelTeams({...surface,kind:'dm'},teams),[])
 assert.deepEqual(eligibleChannelTeams({...surface,enabled:false},teams),[])
})
test('invitation explicitly preserves scope and existing members and retries exact command',()=>{
 const command=createChannelInvite({surface,teams,team:'new',requestId:'request'})
 assert.deepEqual(command.input.team_ids,['existing','new']);assert.equal(command.input.expected_revision,3)
 const restored=validateChannelInvite(JSON.parse(JSON.stringify(command)),scope,'channel');assert.deepEqual(restored,command)
 assert.deepEqual(acceptChannelInvite(command,{id:'channel',...command.input,revision:4}),{id:'channel',...command.input,revision:4})
 for(const patch of [{revision:5},{id:'other'},{team_ids:['new']},{scope:{...scope,workspace_id:'other'}}])assert.throws(()=>acceptChannelInvite(command,{id:'channel',...command.input,revision:4,...patch}))
 assert.throws(()=>createChannelInvite({surface,teams,team:'unknown',requestId:'request'}))
 assert.notEqual(inviteStorageKey(surface),inviteStorageKey({...surface,scope:{...scope,workspace_id:'other'}}))
})
