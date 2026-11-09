import test from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorInbox } from '../src/coordinator-inbox.js'
test('Coordinator inbox discovery pages past blocked inputs and recovers without replay after lost response',async()=>{
 const binding={profile:{type:'dsh'},managedCoordinator:{team_id:'team',conversation_id:'conversation',control_revision:1},managedOperation:{id:'op',attempt:1,epoch:1}}
 let queued=false,writes=0
 const host={stop:new AbortController(),handles:new Map([['session',{run:{signal:new AbortController().signal}}]]),execution:{host:'home',profiles:{binding:()=>binding},client:{call:async(path,body)=>{
  if(!body)return {team_id:'team',conversation_id:'conversation',home_hub:'home',items:path.includes('after=1')?(queued?[]:[{message_id:'ready',sequence:2}]):[{message_id:'blocked',sequence:1}],next_cursor:path.includes('after=1')?null:1}
  if(path.includes('/blocked/'))throw Error('activation mismatch')
  writes++;queued=true;throw Error('response lost after commit')
 }}}}
 const inbox=new CoordinatorInbox(host,{intervalMs:100})
 assert.equal((await inbox.scan())[0].state,'pending')
 await Promise.all([inbox.scan(),inbox.scan()]);assert.equal(writes,1)
 await inbox.close()
 const reopened=new CoordinatorInbox(host,{intervalMs:100});await reopened.scan();assert.deepEqual(await reopened.scan(),[]);assert.equal(writes,1)
 await reopened.close();await assert.rejects(reopened.scan(),/closed/)
})
test('Coordinator inbox rejects foreign pages and drops closed runtime cursors',async()=>{
 const scope={team_id:'team',conversation_id:'conversation',control_revision:1},op={id:'op',attempt:1,epoch:1}
 let reads=0
 const host={stop:new AbortController(),handles:new Map([['session',{run:{signal:new AbortController().signal}}]]),execution:{host:'home',profiles:{binding:()=>({managedCoordinator:scope,managedOperation:op})},client:{call:async(_path,body)=>{assert.equal(body,undefined);reads++;return {team_id:'foreign',conversation_id:'conversation',home_hub:'home',items:[],next_cursor:null}}}}}
 const inbox=new CoordinatorInbox(host,{intervalMs:100});assert.equal((await inbox.scan())[0].error.message,'Invalid Coordinator pending input page')
 inbox.cursors.set('session',4);host.handles.clear();assert.deepEqual(await inbox.scan(),[]);assert.equal(inbox.cursors.size,0);assert.equal(reads,1)
 await inbox.close()
})
