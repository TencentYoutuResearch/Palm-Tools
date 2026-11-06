import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
const source=await readFile(new URL('../src/agent-client.js',import.meta.url),'utf8')
const scope={};vm.runInNewContext(source.slice(0,source.indexOf('var directoryBindingCache')),scope)

test('saved SSH hosts show project histories and explicit pins without importing loose histories into the sidebar',()=>{
 const host={id:'fixture-ssh',workspaces:[{sessionIds:['project','hidden']}],pinnedSessionIds:['pinned'],hiddenSessionIds:['hidden'],sessions:[{id:'loose'},{id:'project'},{id:'hidden'},{id:'pinned'}]}
 const before=JSON.stringify(host)
 assert.deepEqual(Array.from(scope.remoteSidebarSessions(host),row=>row.id),['project','pinned'])
 assert.equal(JSON.stringify(host),before,'directory and histories remain untouched')
 assert.deepEqual(Array.from(scope.remoteSidebarSessions({sessions:[{id:'loose'}]})),[])
})

test('explicit resume still searches remote histories excluded from the sidebar',()=>{
 const host={id:'fixture-ssh',sessions:[{id:'loose',nativeThreadId:'thread-1',title:'Earlier task',cwd:'/srv/project',agent:{id:'fixture'},updatedAt:1}]}
 assert.equal(scope.remoteSidebarSessions(host).length,0)
 assert.deepEqual(Array.from(scope.resumeCandidates([host],{hostId:host.id,profile:{id:'fixture'}},'earlier'),row=>row.id),['loose'])
})
