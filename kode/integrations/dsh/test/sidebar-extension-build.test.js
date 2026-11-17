import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,cp,symlink,readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
test('pinned sidebar builds deterministically and rejects altered lock without touching installed upstream',async()=>{
 const source=fileURLToPath(new URL('..',import.meta.url)),root=await mkdtemp(join(tmpdir(),'sidebar-lock-test-'))
 try{
  for(const dir of ['scripts','packages/sidebar','patches'])await mkdir(join(root,dir),{recursive:true})
  await cp(join(source,'scripts/build-sidebar.js'),join(root,'scripts/build-sidebar.js'))
  await cp(join(source,'patches'),join(root,'patches'),{recursive:true})
  await cp(join(source,'packages/sidebar/upstream-lock.json'),join(root,'packages/sidebar/upstream-lock.json'))
  await symlink(join(source,'node_modules'),join(root,'node_modules'))
  const run=()=>execFileSync(process.execPath,[join(root,'scripts/build-sidebar.js')],{stdio:'pipe'})
  run();const before=await readFile(join(root,'packages/sidebar/client.js'),'utf8');run()
  assert.equal(await readFile(join(root,'packages/sidebar/client.js'),'utf8'),before)
  assert.ok(before.includes('id: "@kode/dsh-sidebar"'))
  const lockPath=join(root,'packages/sidebar/upstream-lock.json'),lock=JSON.parse(await readFile(lockPath,'utf8'));lock.clientSha256='bad';await writeFile(lockPath,JSON.stringify(lock))
  assert.throws(run,/lock mismatch/)
  assert.equal(await readFile(join(root,'packages/sidebar/client.js'),'utf8'),before)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('screenshot fixture defaults to the configured sidebar extension, not the legacy fallback',async()=>{
 const source=await readFile(new URL('./support/collab-render-page.js',import.meta.url),'utf8')
 assert.ok(source.includes("process.env.KODE_TEST_SIDEBAR_BUNDLE || new URL('../../packages/sidebar/client.js', import.meta.url)"))
})

test('collaboration keeps the original Kode color artwork rather than the generic orbit placeholder',async()=>{
 const asset=await readFile(new URL('../packages/collab/assets/kode-mark.png',import.meta.url))
 const original=await readFile(new URL('../../../apps/gui/src-tauri/icons/128x128.png',import.meta.url))
 assert.deepEqual(asset,original)
 const source=await readFile(new URL('../packages/collab/mode-switch.js',import.meta.url),'utf8')
 assert.ok(source.includes('h(KodeIdentity,{wide})'))
 assert.equal(source.includes('function OrbitMark'),false)
})
