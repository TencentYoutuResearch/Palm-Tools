/** Actual released dsh CLI/base/web-app plus worktree plugins; isolated profile, no inference. */
import { fileURLToPath } from 'node:url'
import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, symlink, readdir, rm, readFile,lstat,chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const plugin=fileURLToPath(new URL('../..',import.meta.url)).replace(/\/$/,'')
import { headlessBrowser } from './headless-browser.js'
async function writableOwnedDirectories(path){
 let stat
 try{stat=await lstat(path)}catch(error){if(error.code==='ENOENT')return;throw error}
 // The profile links released modules and the worktree. Never follow those links.
 if(!stat.isDirectory()||stat.isSymbolicLink())return
 await chmod(path,(stat.mode&0o777)|0o700)
 for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())await writableOwnedDirectories(join(path,entry.name))
}
export async function fullDesktopProfile(hub,{metadataOnly=false,builderRead=false,versionedProject=false,managedSessionProbe=false}={}) {
 const runtime=process.env.KODE_TEST_DSH_RUNTIME_MODULES
 if(!runtime)throw Error('Full desktop runtime module root required')
 const root=await mkdtemp(join(tmpdir(),'kode-desktop-profile-'))
 let host,browser,hostClosed=false
 // The isolated Host owns a process group: child runtimes must not retain its stdio after exit.
 const stopHost=signal=>{if(!host?.pid)return;try{if(process.platform!=='win32')process.kill(-host.pid,signal);else if(host.exitCode===null&&host.signalCode===null)host.kill(signal)}catch(error){if(error.code!=='ESRCH')throw error}}
 const close=async()=>{
  const errors=[]
  try{await browser?.close()}catch(error){errors.push(error)}
  try{if(host){
   const done=hostClosed?Promise.resolve():once(host,'close')
   stopHost('SIGTERM')
   const timer=setTimeout(()=>{stopHost('SIGKILL');host.stdout?.destroy();host.stderr?.destroy()},3000)
   try{await done}finally{clearTimeout(timer)}
  }}catch(error){errors.push(error)}
  try{await writableOwnedDirectories(root);await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}catch(error){errors.push(error)}
  if(errors.length)throw new AggregateError(errors,'Owned desktop cleanup failed')
 }

 try {
 await mkdir(join(root,'project'))
 if(versionedProject){
  const git=args=>promisify(execFile)('/usr/bin/git',['-C',join(root,'project'),'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})
  await git(['init','-q']);await writeFile(join(root,'project/README.md'),'Isolated desktop delivery fixture\n');await git(['add','README.md']);await git(['commit','-qm','fixture baseline'])
 }
 const home=join(root,'home'),profile=join(home,'.dsh/profiles/web'),modules=join(profile,'node_modules')
 await mkdir(join(modules,'@kode'),{recursive:true})
 for(const name of await readdir(runtime)) {
  if(name==='@kode')continue
  await symlink(join(runtime,name),join(modules,name))
 }
 await symlink(plugin,join(modules,'@kode/dsh'))
 for(const name of ['browser','chat','collab','directory-browse','transport']) await symlink(join(plugin,'packages',name),join(modules,'@kode/dsh-'+name))
 if(metadataOnly){
  const fixture=join(modules,'@kode/desktop-metadata-fixture');await mkdir(fixture)
  await writeFile(join(fixture,'package.json'),JSON.stringify({name:'@kode/desktop-metadata-fixture',version:'0.0.0',type:'module',exports:{'.':'./host.js'}}))
  await writeFile(join(fixture,'host.js'),(await readFile(join(plugin,'test/fixture-desktop-metadata.js'),'utf8'))
   .replaceAll("from '../src/", "from '"+new URL('../../src/',import.meta.url).href)
   .replace('const ALLOW_BUILDER_READ=false','const ALLOW_BUILDER_READ='+Boolean(builderRead)))
 }
 const diagnostic=join(modules,'@kode/desktop-probe');await mkdir(diagnostic)
 await writeFile(join(diagnostic,'package.json'),JSON.stringify({name:'@kode/desktop-probe',version:'0.0.0',type:'module',exports:{'.':'./host.js','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web',inject:['@deepseek-ai/dsh-client-ui-workspace']}}}))
 await writeFile(join(diagnostic,'host.js'),managedSessionProbe?await readFile(join(plugin,'test/fixture-session-readonly-probe.js'),'utf8'):'export function apply() {}')
 await writeFile(join(diagnostic,'client.js'),`window.__ModuleLoader__.load({id:'@kode/desktop-probe',factory:()=>({inject:['slots'],apply(ctx){
  globalThis.probeSession=()=>{
   const value=ctx.get('sessions').list.getSnapshot();
   return {ids:value.ids,selected:Object.values(value.byId).filter(session=>(session.retainedBy.mainView??0)>0).map(session=>session.id)};
  };
  ${managedSessionProbe?`
  globalThis.probeOpenSession=id=>{
   ctx.get('uiWorkspace').openSession(id);
   return id;
  };
  globalThis.probeNativeCommand=async(id,method)=>{
   const session=ctx.get('sessions').binding(id)?.session;
   if(!session)throw Error('Session is not retained');
   try{
    let result;
    if(method==='prompt')result=await session.prompt([{type:'text',text:'must not enter managed history'}],'queue');
    else if(method==='cancel')result=await session.cancel();
    else if(method==='rename')result=await session.rename('must not rename managed session');
    else throw Error('Unsupported fixture command');
    return result.ok?{ok:true,value:result.value}:{ok:false,error:result.error.message};
   }catch(error){return {error:String(error.message)}}
  };`:''}
  globalThis.probeSlots=()=>ctx.slots.entries('sidebar.workspaces.directoryFlow').map(entry=>({keys:Object.keys(entry),name:entry.component?.name,priority:entry.options?.priority,inject:typeof entry.inject,bindings:Object.keys(entry.inject?.()??{})}));
 }})})`)
 await writeFile(join(profile,'package.json'),JSON.stringify({name:'isolated-desktop-acceptance',private:true,dependencies:{'@kode/dsh':'file:'+plugin},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@kode/dsh']}}}))
 await writeFile(join(profile,'cordis.yml'),'[]\n')
 await writeFile(join(profile,'cordis.patch.yml'),'- id: kode\n  config: '+JSON.stringify({url:hub.url,tokenFile:join(hub.root,'admin.token'),stateFile:join(root,'owners.json'),sharedBackendState:true,publishWorkbenchConnection:false,...(metadataOnly?{builderDefaults:{profile_id:'official',provider:'fixture',model:'fixture-model'}}:{}),agentProfiles:metadataOnly?[{id:'official',name:'Isolated official executor',type:'dsh',defaultModel:'fixture-model'}]:[{id:'fixture',name:'Isolated fixture',type:'codex',executable:process.execPath,args:[join(plugin,'test/fixture-codex-server.js')],defaultModel:'fixture'}]})+'\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: desktop-directory-browse\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n    - id: desktop-probe\n      name: "@kode/desktop-probe"\n'+(metadataOnly?'    - id: desktop-metadata-fixture\n      name: "@kode/desktop-metadata-fixture"\n':''))
 host=spawn(process.execPath,[join(runtime,'@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--','--port','0','--host','127.0.0.1','--no-open'],{detached:process.platform!=='win32',cwd:join(root,'project'),env:{PATH:process.env.PATH,HOME:home,DSH_HOME:join(home,'.dsh'),KODE_DSH_HOME:join(root,'kode'),KODE_GUI_STATE_PATH:join(hub.root,'gui-state.json'),KODE_MEMORY_ROOT:join(root,'memory'),LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe']})
 host.once('close',()=>{hostClosed=true})
 let output='';for(const stream of [host.stdout,host.stderr])stream.on('data',b=>{output=(output+b).slice(-100000)})
 const deadline=Date.now()+45000
 let launch
 while(Date.now()<deadline){launch=output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/)?.[0];if(launch)break;if(host.exitCode!==null)break;await new Promise(r=>setTimeout(r,100))}
 if(!launch){const categories=[...output.matchAll(/(?:Cannot find package|Cannot find module|inactive|failed|Error:)[^\r\n]{0,180}/g)].map(m=>m[0].replace(/(?:token|secret|key|password)[^\s,]*/ig,'[redacted]'));console.log(JSON.stringify({phase:'boot',exitCode:host.exitCode,diagnostics:categories.slice(-10)}));throw Error('Isolated dsh boot did not produce a ready endpoint')}

 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,join(root,'chrome'))
 const page=await browser.page(launch)
 const diagnostics=()=>output.split(/\r?\n/).filter(line=>/desktop-probe|managed-session|inactive|failed|Error:|SyntaxError/.test(line))
  .map(line=>line.replace(/https?:\/\/\S+/g,'[fixture-url]').replace(/(?:token|secret|password)[^\s,]*/ig,'[redacted]')).slice(-12)
 return {page,root,close,diagnostics}
 }catch(error){await close();throw error}
}
