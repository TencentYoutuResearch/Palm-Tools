/** Manifest-driven disposable replay scaffold. Production adapters are injected; this file never imports a model SDK. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './isolated-hub.js'
const exec=promisify(execFile),archiveLimit=128*1024*1024
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
const safePath=value=>typeof value==='string'&&value.length>0&&!isAbsolute(value)&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..')
export function freezeFeatureManifest(input){
 const value=structuredClone(input)
 assert.match(value.task_id,/^[a-z][a-z0-9-]{0,63}$/)
 assert.ok(isAbsolute(value.source_repo));assert.match(value.source_commit,/^[a-f0-9]{40}$/)
 for(const name of ['snapshot_paths','allowed_write_paths'])assert.ok(Array.isArray(value[name])&&value[name].length>0&&value[name].every(safePath),name)
 assert.ok(typeof value.request==='string'&&value.request.trim()&&Buffer.byteLength(value.request)<=65536)
 const v=value.verification;assert.ok(v&&isAbsolute(v.executable)&&Array.isArray(v.args)&&v.args.every(x=>typeof x==='string'))
 assert.ok(Number.isSafeInteger(v.timeout_ms)&&v.timeout_ms>0&&v.timeout_ms<=300000)
 assert.ok(Number.isSafeInteger(v.max_output_bytes)&&v.max_output_bytes>0&&v.max_output_bytes<=1024*1024)
 assert.ok(v.env&&typeof v.env==='object'&&!Array.isArray(v.env)&&Object.values(v.env).every(x=>typeof x==='string'))
 assert.ok(Array.isArray(v.scenario_ids)&&v.scenario_ids.length>0&&v.scenario_ids.every(x=>/^[a-zA-Z0-9_.-]+$/.test(x)))
 // Never put environment values or the verification program into the public runtime status.
 return{manifest:freeze(value),hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')}
}
export async function prepareFeatureSnapshot(manifest,hubRoot){
 const source=await realpath(manifest.source_repo),root=join(hubRoot,'project'),archive=join(hubRoot,'source-snapshot.tar')
 const resolved=(await exec('/usr/bin/git',['-C',source,'rev-parse',manifest.source_commit+'^{commit}'])).stdout.trim();assert.equal(resolved,manifest.source_commit)
 const bytes=Number((await exec('/usr/bin/git',['-C',source,'ls-tree','-r','--long',manifest.source_commit,'--',...manifest.snapshot_paths])).stdout.split('\n').filter(Boolean).reduce((sum,line)=>{const n=line.split('\t')[0].trim().split(/\s+/).at(-1);assert.ok(!/^(120000|160000) /.test(line),'symlinks and submodules must be explicitly isolated, never implicitly copied');assert.match(n,/^\d+$/,'submodules must be explicitly isolated, never implicitly copied');return sum+Number(n)},0))
 assert.ok(bytes>0&&bytes<=archiveLimit,'snapshot must fit the existing 128MiB archive limit')
 await mkdir(root,{mode:0o700})
 await exec('/usr/bin/git',['-C',source,'archive','--format=tar','--output='+archive,manifest.source_commit,'--',...manifest.snapshot_paths])
 assert.ok((await stat(archive)).size<=archiveLimit,'archive exceeds the existing limit')
 // git archive emits only selected committed paths, never local dirty/untracked files or .git credentials.
 await exec('/usr/bin/tar',['-xf',archive,'-C',root])
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Replay fixture',GIT_AUTHOR_EMAIL:'replay@example.com',GIT_COMMITTER_NAME:'Replay fixture',GIT_COMMITTER_EMAIL:'replay@example.com'}
 const git=args=>exec('/usr/bin/git',['-C',root,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env})
 await git(['init','-q']);await git(['add','.']);await git(['commit','-qm','isolated historical snapshot'])
 return freeze({root:await realpath(root),source_commit:resolved,committed_bytes:bytes,snapshot_paths:[...manifest.snapshot_paths],archive_sha256:createHash('sha256').update(await readFile(archive)).digest('hex')})
}
/** createRuntime must wire official authority/Builder accept and consume admission at every model begin.
 * Required adapter: {ui:{send,close},status,pauseAutomatic,requestOwnerCancel,reconcileCancellation,capture,close}.
 * A completed or failed session stays alive until explicit close; nothing creates a business team.
 */
export async function retainedFeatureRunner({manifest:input,createRuntime,createHub=isolatedHub,prepareSnapshot=prepareFeatureSnapshot,mode='controlled',allowLive=false,stageMs=1200000,runMs=2400000}){
 const {manifest,hash}=freezeFeatureManifest(input)
 assert.ok(['controlled','hy4'].includes(mode));assert.ok(mode!=='hy4'||(allowLive&&process.env.KODE_TEST_LIVE_FREE_WRAPPER==='1'),'live calls require explicit readiness and free-wrapper authorization')
 assert.equal(typeof createRuntime,'function');assert.ok(Number.isSafeInteger(stageMs)&&stageMs>0&&stageMs<=1200000);assert.ok(Number.isSafeInteger(runMs)&&runMs>=stageMs&&runMs<=2400000)
 const hub=await createHub('retained-'+manifest.task_id),token=randomBytes(32).toString('hex')
 let runtime,server,phase='preparing',admissionEnabled=false,lastFailure=null,initialSend,stopTask,pauseTask,closeTask,deadline,stageDeadline,stageId
 const deadlines=freeze({decisionMs:300000,stageMs,runMs,grantValidityMs:runMs+600000})
 const admit=()=>{if(!admissionEnabled||phase!=='running')throw Object.assign(Error('Replay inference admission paused'),{code:'replay_admission_paused'})}
 const checkpoint=async name=>{try{await runtime?.capture(name,{failure:lastFailure})}catch{/* Preserve execution failure even if evidence fails. */}}
 const status=async()=>({task_id:manifest.task_id,manifest_sha256:hash,mode,phase,admission_enabled:admissionEnabled,deadlines,last_failure:lastFailure,runtime:runtime?await runtime.status():null})
 const pause=error=>pauseTask??=(async()=>{admissionEnabled=false;phase='pausing';lastFailure=error?{name:error.name??'Error',code:typeof error.code==='number'?error.code:null}:null;await checkpoint('before_hold');try{await runtime.pauseAutomatic();phase='held'}catch(cause){phase='pause_unconfirmed';throw cause}finally{clearTimeout(deadline);clearTimeout(stageDeadline);await checkpoint('after_hold')}return status()})()
 const close=()=>closeTask??=(async()=>{admissionEnabled=false;clearTimeout(deadline);clearTimeout(stageDeadline);await pauseTask?.catch(()=>{});await checkpoint('before_explicit_close');try{await runtime?.close()}finally{phase='closed';if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await hub.stop();await checkpoint('after_explicit_close')}})()
 try{
  const snapshot=await prepareSnapshot(manifest,hub.root)
  await writeFile(join(hub.root,'frozen-manifest.json'),JSON.stringify({manifest,hash},null,2)+'\n',{mode:0o600,flag:'wx'})
  const observeStage=id=>{assert.match(id,/^[a-zA-Z0-9_.-]{1,160}$/);if(id===stageId||phase!=='running')return;stageId=id;clearTimeout(stageDeadline);stageDeadline=setTimeout(()=>{void pause(Object.assign(Error('Bounded stage deadline reached'),{code:23})).catch(()=>{})},stageMs);stageDeadline.unref?.()}
  runtime=await createRuntime({hub,manifest,snapshot,mode,deadlines,admit,observeStage,teamId:manifest.task_id})
  for(const name of ['status','pauseAutomatic','requestOwnerCancel','reconcileCancellation','capture','close'])assert.equal(typeof runtime[name],'function',name)
  assert.equal(typeof runtime.ui?.send,'function','task intake must use the real UI adapter')
  phase='ready'
  const start=()=>initialSend??=(async()=>{assert.equal(phase,'ready');phase='running';admissionEnabled=true;deadline=setTimeout(()=>{void pause(Object.assign(Error('Bounded replay deadline reached'),{code:23})).catch(()=>{})},runMs);deadline.unref?.();await checkpoint('before_ui_send');try{return await runtime.ui.send(manifest.request)}catch(error){await pause(error);throw error}})()
  const refresh=async()=>{const result=await runtime.status();if((result?.state==='failed'||result?.state==='completed'&&result.completion_reported!==false)&&phase==='running'){admissionEnabled=false;clearTimeout(deadline);clearTimeout(stageDeadline);await runtime.pauseAutomatic();phase=result.state==='completed'?'completed':'held';await checkpoint('terminal_retained')}return status()}
  const stop=()=>stopTask??=(async()=>{if(!['held','running'].includes(phase))throw Error('Replay cannot accept owner cancellation now');admissionEnabled=false;await runtime.requestOwnerCancel();await pause();return runtime.reconcileCancellation()})()
  server=createServer(async(req,res)=>{const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(401,{error:'private fixture authorization required'});try{if(req.method==='GET'&&req.url==='/status')return send(200,await refresh());if(req.method==='POST'&&req.url==='/stop')return send(200,await stop());send(404,{error:'only status and stop are exposed'})}catch{return send(409,{error:'fixture action unconfirmed; inspect original state'})}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  await writeFile(join(hub.root,'control.json'),JSON.stringify({url:'http://127.0.0.1:'+server.address().port,token}),{mode:0o600,flag:'wx'})
  return{hub,manifestHash:hash,deadlines,start,status:refresh,pause,stop,close,admit}
 }catch(error){await close().catch(()=>{});throw error}
}
