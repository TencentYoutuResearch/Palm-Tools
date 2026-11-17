import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,cp,symlink,readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import yaml from 'js-yaml'
import {applyEntryPatches} from '@deepseek-ai/cordis-plugin-include'

const source=fileURLToPath(new URL('..',import.meta.url))

test('pinned Conversation builds deterministically and fails closed on altered upstream lock or patch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'conversation-lock-test-'))
 try{
  for(const dir of ['scripts','packages/conversation','patches'])await mkdir(join(root,dir),{recursive:true})
  await cp(join(source,'scripts/build-conversation.js'),join(root,'scripts/build-conversation.js'))
  await cp(join(source,'scripts/pinned-client-patch.js'),join(root,'scripts/pinned-client-patch.js'))
  await cp(join(source,'patches'),join(root,'patches'),{recursive:true})
  await cp(join(source,'packages/conversation/upstream-lock.json'),join(root,'packages/conversation/upstream-lock.json'))
  await symlink(join(source,'node_modules'),join(root,'node_modules'))
  const output=join(root,'packages/conversation/client.js')
  const run=()=>execFileSync(process.execPath,[join(root,'scripts/build-conversation.js')],{stdio:'pipe'})
  run();const before=await readFile(output,'utf8');run()
  assert.equal(await readFile(output,'utf8'),before)
  assert.ok(before.includes('id: "@kode/dsh-conversation"'))
  assert.ok(!before.includes('id: "@deepseek-ai/dsh-client-ui-conversation"'))
  // The ownership patch is present exactly where reviewed.
  assert.equal(before.split('const composerRootOccurrences = /* @__PURE__ */ new WeakMap();').length,2)
  assert.ok(before.includes('if (editor.getRootElement() !== el) return;'))
  assert.ok(before.includes('if (this.filePicker === picker) this.filePicker = pickers.at(-1);'))
  assert.ok(before.includes('const owned = (listener) => (event) => handlers.owns?.() === false ? false : listener(event);'))
  const keymap=before.slice(before.indexOf('function registerComposerKeymap('),before.indexOf('//#endregion',before.indexOf('function registerComposerKeymap(')))
  assert.equal(keymap.split('editor.registerCommand(').length,8)
  assert.equal(keymap.match(/editor\.registerCommand\([^,]+, owned\(/g).length,7,'every keymap command is owner-gated')
  assert.ok(before.includes('return installDraftKeymap(editor, keyboard, gate, scrollRef);'),'each view gates its keymap on holding the root')
  assert.equal(before.includes('editor.setRootElement(null);\n\t\t\t\t};\n\t\t\t}, [editor]);'),false,'no unconditional root clear remains in the composer host')

  const lockPath=join(root,'packages/conversation/upstream-lock.json'),lock=await readFile(lockPath,'utf8')
  await writeFile(lockPath,JSON.stringify({...JSON.parse(lock),clientSha256:'bad'}))
  assert.throws(run,/lock mismatch/)
  await writeFile(lockPath,JSON.stringify({...JSON.parse(lock),version:'0.2.2'}))
  assert.throws(run,/lock mismatch/)
  await writeFile(lockPath,lock)
  const patchPath=join(root,'patches/dsh-conversation-0.2.1-rc.5/composer-root-ownership.patch')
  await writeFile(patchPath,(await readFile(patchPath,'utf8')).replace('pickers.at(-1)','void 0'))
  assert.throws(run,/lock mismatch/)
  assert.equal(await readFile(output,'utf8'),before,'a refused build writes nothing')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('the installed upstream Conversation is never modified by the build',async()=>{
 const upstream=join(source,'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
 const lock=JSON.parse(await readFile(join(source,'packages/conversation/upstream-lock.json'),'utf8'))
 const {createHash}=await import('node:crypto')
 assert.equal(createHash('sha256').update(await readFile(upstream)).digest('hex'),lock.clientSha256)
 assert.equal((await readFile(join(source,'patches/dsh-conversation-0.2.1-rc.5/upstream.sha256'),'utf8')).trim(),lock.clientSha256,'same audited upstream as the composer adapter')
})

test('cordis replaces ui-conversation with the patched override, never loading both',async()=>{
 const patches=yaml.load((await readFile(join(source,'cordis.patch.yml'),'utf8')).replaceAll('!!js ',''))
 const entries=applyEntryPatches([{id:'ui-conversation',name:'@deepseek-ai/dsh-client-ui-conversation'}],patches,()=>{})
 const rows=entries.filter(row=>row.id==='ui-conversation')
 // EntryGroup.update resolves each id to its last entry before activation.
 assert.equal(rows.at(-1).name,'@kode/dsh-conversation')
 assert.equal(entries.filter(row=>String(row.name).includes('conversation')&&row.id!=='ui-conversation'&&!row.name.startsWith('@kode/dsh/')).length,0)
 const manifest=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
 assert.equal(manifest.dependencies['@kode/dsh-conversation'],'file:packages/conversation')
 assert.ok(manifest.files.includes('scripts/build-conversation.js'))
 assert.ok((await readFile(join(source,'scripts/build-bundle.js'),'utf8')).includes("scripts/build-conversation.js"))
 const override=JSON.parse(await readFile(join(source,'packages/conversation/package.json'),'utf8'))
 const upstream=JSON.parse(await readFile(join(source,'node_modules/@deepseek-ai/dsh-client-ui-conversation/package.json'),'utf8'))
 assert.deepEqual(override.dsh.client,upstream.dsh.client)
})

test('browser fixtures load the patched Conversation through the production build function',async()=>{
 const fixture=await readFile(new URL('./support/collab-render-page.js',import.meta.url),'utf8')
 assert.ok(fixture.includes("await (patchedConversation ??= buildConversationClient())"))
})
