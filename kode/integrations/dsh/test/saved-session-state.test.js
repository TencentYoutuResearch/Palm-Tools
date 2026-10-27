import test from 'node:test'
import assert from 'node:assert/strict'
import { hostDirectory, hostOperation } from '../src/workspace-directory.js'
import { importedSessionId, savedSessionOperation } from '../src/saved-session-state.js'
const tab={backend_key:'removed-tclaude',session_id:'old-thread',cwd:'/srv/project',title:'Old conversation',env:{API_KEY:'must-not-leak'}}
function backend(){
 const documents={'session-index':{version:1,native_sessions:[tab]},workspaces:{version:2,tables:{workspaces:{project:{title:'Project',path:'/srv/project',sessionIds:[]}}},global:{initialized:true,workspaceIds:['project'],archivedSessionIds:[],pinnedSessionIds:[]}}},revisions={}
 return{documents,async call(path,body){if(path.endsWith('/node'))return{node_id:'example-node'};const key=path.split('/').at(-1);if(!body)return{revision:revisions[key]??0,value:structuredClone(documents[key])};assert.equal(body.expected_revision,revisions[key]??0);documents[key]=structuredClone(body.value);return{revision:revisions[key]=(revisions[key]??0)+1,value:structuredClone(documents[key])}}}
}
test('removed Agent tabs can pin, archive and unarchive without an adapter, transcript import or runtime',async()=>{
 const client=backend(),calls=[]
 const ctx={get:name=>name==='workspaceRegistry'?{archivedSessionIds:[],pinnedSessionIds:[],list:()=>[{id:'project',title:'Project',path:'/srv/project',sessionIds:[]}]}:undefined,sessionController:{list:async()=>({items:[]}),resolveAgent:()=>{throw new Error('must not resume')}}}
 const input={nativeSession:{backend_key:tab.backend_key,session_id:tab.session_id},args:{sessionId:'saved:example'}}
 for(const operation of ['pin-session','archive-session'])await hostOperation(ctx,{...input,operation},{backendClient:client})
 const id=importedSessionId(tab)
 assert.deepEqual(client.documents.workspaces.global.archivedSessionIds,[id]);assert.deepEqual(client.documents.workspaces.global.pinnedSessionIds,[])
 let directory=await hostDirectory(ctx,{backendClient:client}),saved=directory.sessions[0]
 assert.match(saved.id,/^saved:/);assert.ok(directory.archivedSessionIds.includes(saved.id));assert.doesNotMatch(JSON.stringify(directory),/must-not-leak|API_KEY|env/)
 assert.ok(directory.workspaces[0].sessionIds.includes(saved.id))
 await savedSessionOperation(client,{...input,operation:'unarchive-session'})
 directory=await hostDirectory(ctx,{backendClient:client});assert.deepEqual(directory.archivedSessionIds,[])
 assert.equal(client.documents['session-index'].native_sessions[0].session_id,tab.session_id)
 assert.equal(client.documents['session-index'].native_sessions[0].dsh_session_id,id)
 await savedSessionOperation(client,{...input,operation:'session-avatar',args:{avatarId:'gallery/example'}})
 assert.equal(client.documents['session-index'].native_sessions[0].avatar_id,'gallery/example')
 assert.deepEqual(client.documents.workspaces.global.archivedSessionIds,[],'changing a legacy avatar must not alter archive state')
 await assert.rejects(savedSessionOperation(client,{...input,nativeSession:{backend_key:'another-host',session_id:tab.session_id},operation:'archive-session'}),/当前主机没有/)
 assert.deepEqual(calls,[])
})
