import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,cp,symlink,readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import yaml from 'js-yaml'
import {applyEntryPatches} from '@deepseek-ai/cordis-plugin-include'

const source=fileURLToPath(new URL('..',import.meta.url))
const upstreamDir=join(source,'node_modules/@deepseek-ai/dsh-client-ui-sidebar-right')

test('pinned right Sidebar builds deterministically with the panel-host patch and fails closed on drift',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sidebar-right-lock-test-'))
 try{
  for(const dir of ['scripts','packages/sidebar-right','patches'])await mkdir(join(root,dir),{recursive:true})
  await cp(join(source,'scripts/build-sidebar-right.js'),join(root,'scripts/build-sidebar-right.js'))
  await cp(join(source,'scripts/pinned-client-patch.js'),join(root,'scripts/pinned-client-patch.js'))
  await cp(join(source,'patches'),join(root,'patches'),{recursive:true})
  await cp(join(source,'packages/sidebar-right/upstream-lock.json'),join(root,'packages/sidebar-right/upstream-lock.json'))
  await symlink(join(source,'node_modules'),join(root,'node_modules'))
  const output=join(root,'packages/sidebar-right/client.js')
  const run=()=>execFileSync(process.execPath,[join(root,'scripts/build-sidebar-right.js')],{stdio:'pipe'})
  run();const before=await readFile(output,'utf8');run()
  assert.equal(await readFile(output,'utf8'),before)
  assert.ok(before.includes('id: "@kode/dsh-sidebar-right"'))
  assert.ok(!before.includes('id: "@deepseek-ai/dsh-client-ui-sidebar-right"'))
  // The host extension is exactly the reviewed surface: a scope-keyed surface on the same seat, nothing else.
  assert.equal(before.split('controller.registerHost = (panelId, options) => {').length,2)
  assert.ok(before.includes('key: `host:${record.panelId}/${scope}`'),'a host key can never equal a Session id')
  assert.ok(before.includes('show(panelId === null ? selected?.sessionId : hosts.keyFor(panelId));'),'Session views keep their own surface; a host only shows for its own panel')
  assert.ok(before.includes('"sidebar.right.host.tab": {'))
  assert.ok(before.includes('canAddTab: (paneId) => panel.seats === void 0 &&'),'host surfaces offer no guide: only their own registered tabs')
  assert.ok(before.includes('const noRetain = () => () => {};'),'a host surface retains no Session by itself')
  const upstream=await readFile(join(upstreamDir,'lib/client.js'),'utf8')
  assert.ok(!upstream.includes('registerHost'),'the stock package has no panel host')

  const lockPath=join(root,'packages/sidebar-right/upstream-lock.json'),lock=await readFile(lockPath,'utf8')
  await writeFile(lockPath,JSON.stringify({...JSON.parse(lock),clientSha256:'bad'}))
  assert.throws(run,/lock mismatch/)
  await writeFile(lockPath,JSON.stringify({...JSON.parse(lock),version:'0.2.2'}))
  assert.throws(run,/lock mismatch/)
  await writeFile(lockPath,lock)
  const patchPath=join(root,'patches/dsh-sidebar-right-0.2.1-rc.5/panel-host-scope.patch')
  await writeFile(patchPath,(await readFile(patchPath,'utf8')).replace('const noRetain = () => () => {};','const noRetain = () => void 0;'))
  assert.throws(run,/lock mismatch/)
  assert.equal(await readFile(output,'utf8'),before,'a refused build writes nothing')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('the installed upstream right Sidebar is never modified by the build',async()=>{
 const lock=JSON.parse(await readFile(join(source,'packages/sidebar-right/upstream-lock.json'),'utf8'))
 const manifest=JSON.parse(await readFile(join(upstreamDir,'package.json'),'utf8'))
 assert.equal(manifest.version,lock.version)
 assert.equal(createHash('sha256').update(await readFile(join(upstreamDir,'lib/client.js'))).digest('hex'),lock.clientSha256)
 assert.equal(createHash('sha256').update(await readFile(join(source,'patches/dsh-sidebar-right-0.2.1-rc.5/panel-host-scope.patch'))).digest('hex'),lock.patchSha256)
})

test('cordis replaces ui-sidebar-right with the patched override, never loading both',async()=>{
 const patches=yaml.load((await readFile(join(source,'cordis.patch.yml'),'utf8')).replaceAll('!!js ',''))
 const entries=applyEntryPatches([{id:'ui-sidebar-right',name:'@deepseek-ai/dsh-client-ui-sidebar-right'}],patches,()=>{})
 const rows=entries.filter(row=>row.id==='ui-sidebar-right')
 assert.equal(rows.at(-1).name,'@kode/dsh-sidebar-right')
 assert.equal(entries.filter(row=>String(row.name).includes('sidebar-right')&&row.id!=='ui-sidebar-right').length,0)
 const manifest=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
 assert.equal(manifest.dependencies['@kode/dsh-sidebar-right'],'file:packages/sidebar-right')
 assert.ok(manifest.files.includes('scripts/build-sidebar-right.js'))
 assert.ok((await readFile(join(source,'scripts/build-bundle.js'),'utf8')).includes("scripts/build-sidebar-right.js"))
 const override=JSON.parse(await readFile(join(source,'packages/sidebar-right/package.json'),'utf8'))
 const upstream=JSON.parse(await readFile(join(upstreamDir,'package.json'),'utf8'))
 assert.deepEqual(override.dsh.client,upstream.dsh.client)
 assert.equal(override.peerDependencies['@deepseek-ai/dsh-client-ui-sidebar-right'],upstream.version)
})

test('browser fixtures load the patched right Sidebar through the production build function',async()=>{
 const fixture=await readFile(new URL('./support/collab-render-page.js',import.meta.url),'utf8')
 assert.ok(fixture.includes("await (patchedSidebarRight ??= buildSidebarRightClient())"))
})
