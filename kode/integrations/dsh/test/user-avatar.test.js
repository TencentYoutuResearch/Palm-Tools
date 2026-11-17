import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserAvatarStore, decodeAvatar} from '../packages/collab/user-avatar.js'
const png='data:image/png;base64,YQ=='
const storage=()=>{const map=new Map();return{getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}}
test('account default, override, clear, account/host isolation and stale profile',async()=>{
 const db=storage(),store=createUserAvatarStore({storage:db,host:'one',decode:async()=>png})
 const a={id:'a',avatarUrl:'https://example.test/a.png'},b={id:'b',avatarUrl:'https://example.test/b.png'}
 store.setProfile(a);assert.equal(store.getSnapshot().source,a.avatarUrl)
 await store.upload({});assert.equal(store.getSnapshot().overridden,true)
 const old=store.reset();store.reset();store.setProfile(a,old);assert.equal(store.getSnapshot().accountId,null)
 store.setProfile(b);assert.equal(store.getSnapshot().source,b.avatarUrl)
 store.reset();store.setProfile(a);assert.equal(store.getSnapshot().source,png)
 const other=createUserAvatarStore({storage:db,host:'two'});other.setProfile(a);assert.equal(other.getSnapshot().source,a.avatarUrl)
 store.clear();assert.equal(store.getSnapshot().source,a.avatarUrl)
 store.reset();assert.equal(store.getSnapshot().source,null,'signed out never shows an account avatar')
})
test('signed out: a device-only slot that never appears under an account',async()=>{
 const db=storage(),store=createUserAvatarStore({storage:db,host:'one',decode:async()=>png})
 store.reset();await store.upload({});assert.deepEqual(store.getSnapshot(),{accountId:null,source:png,overridden:true})
 store.setProfile({id:'a',avatarUrl:'https://example.test/a.png'});assert.equal(store.getSnapshot().source,'https://example.test/a.png')
 store.reset();assert.equal(store.getSnapshot().source,png,'device choice returns after sign-out')
 store.clear();assert.equal(store.getSnapshot().source,null)
 assert.equal(createUserAvatarStore({storage:db,host:'two'}).getSnapshot().source,null)
})
test('account switch while decoding cannot save image for another account',async()=>{
 let resolve;const store=createUserAvatarStore({storage:storage(),decode:()=>new Promise(r=>resolve=r)})
 store.setProfile({id:'a'});const pending=store.upload({});store.reset();store.setProfile({id:'b'});resolve(png)
 await assert.rejects(pending,/账户已切换/);assert.equal(store.getSnapshot().source,null)
})
test('invalid formats, oversized files and corrupt images rejected',async()=>{
 await assert.rejects(decodeAvatar({type:'image/svg+xml',size:10}),/PNG/)
 await assert.rejects(decodeAvatar({type:'image/png',size:3000000}),/2 MB/)
 await assert.rejects(decodeAvatar({type:'image/png',size:10}),/解码/)
})
test('storage failure is visible and unsafe URLs are not rendered',async()=>{
 const store=createUserAvatarStore({storage:{getItem:()=>null,setItem:()=>{throw Error()}},decode:async()=>png})
 store.setProfile({id:'a',avatarUrl:'javascript:alert(1)'})
 assert.equal(store.getSnapshot().source,null);await assert.rejects(store.upload({}),/存储/)
 assert.equal(store.getSnapshot().overridden,false)
})
test('AccountController stream clears on switch, ignores late response and disposes',async()=>{
 const {connectUserAvatar}=await import('../packages/collab/user-avatar.js')
 const original=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}}
 const store=createUserAvatarStore({storage:storage()}),queue=[],requests=[];let wake,disposed=false
 const push=status=>{queue.push({value:{status},accept(){}});wake?.();wake=null}
 const stream={async *[Symbol.asyncIterator](){while(!disposed){if(!queue.length)await new Promise(r=>wake=r);while(queue.length)yield queue.shift()}},dispose(){disposed=true;wake?.()}}
 const ctx={remote:{$stream:()=>stream,account:{watch(){},getProfile:metadata=>{assert.equal(metadata.version,'0.2.1-rc.5');return new Promise(r=>requests.push(r))}}}}
 try {
 const stop=connectUserAvatar(ctx,store),tick=()=>new Promise(r=>setImmediate(r))
 push('credential-stored');await tick();requests.shift()({ok:true,value:{status:'ready',value:{id:'a',avatarUrl:'https://example.test/a.png'}}});await tick()
 assert.equal(store.getSnapshot().source,'https://example.test/a.png')
 push('credential-stored');await tick();assert.equal(store.getSnapshot().source,null)
 push('signed-out');await tick();requests.shift()({ok:true,value:{status:'ready',value:{id:'b'}}});await tick()
 assert.equal(store.getSnapshot().accountId,null);stop();assert.equal(disposed,true)
 }finally{globalThis.window=original}
})
