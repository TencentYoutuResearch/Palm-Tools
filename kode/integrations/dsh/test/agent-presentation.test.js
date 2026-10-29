import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profilePresentations } from '../src/agent-presentation.js'
import { SessionAppearance } from '../src/session-appearance.js'
import { classifyCommands } from '../src/command-skills.js'
import { registerAvatarApi } from '../src/session-appearance.js'
import { createServer } from 'node:http'
import { BackendClient } from '../src/backend-client.js'
import { BackendAgentProfiles } from '../src/backend-state.js'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
test('the configured native CodeBuddy is one built-in choice; independently added CodeBuddy profiles coexist', () => {
  const profiles = [{ id: 'builtin-codebuddy', name: 'CodeBuddy', type: 'codebuddy', origin: 'builtin' }, { id: 'kode-codebuddy', name: 'codebuddy', type: 'codebuddy', origin: 'custom', executable: '/example/codebuddy', args: ['--profile', 'work'] }, { id: 'work-buddy', name: 'Team Buddy', type: 'codebuddy', origin: 'custom' }]
  const before = structuredClone(profiles)
  const rows = profilePresentations(profiles, { desktop_ids: { 'kode-codebuddy': 'codebuddy', 'work-buddy': 'work-buddy' } })
  assert.equal(rows.length, 2); assert.equal(rows[0].name, 'CodeBuddy'); assert.equal(rows[0].origin, 'builtin'); assert.equal(rows[0].id, 'kode-codebuddy')
  assert.deepEqual(rows[0].args, ['--profile', 'work']); assert.equal(rows[1].origin, 'custom'); assert.deepEqual(profiles, before)
})
test('session avatars are independent for conversations using the same Agent and guard gallery paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-'))
  let value = { version: 1, native_sessions: [{ backend_key: 'codex', session_id: 'native-a', dsh_session_id: 'session-a' }, { backend_key: 'codex', session_id: 'native-b', dsh_session_id: 'session-b' }] }, revision = 0
  const client = { async call(_path, body) { if (body) { assert.equal(body.expected_revision, revision); value = body.value; revision++ } return { value: structuredClone(value), revision } } }
  const profiles = { get: id => { assert.equal(id, 'work') }, reload: async () => {}, list: () => [] }
  const appearance = new SessionAppearance(client, profiles, { avatarDirectory: root })
  try {
    await mkdir(join(root, 'gallery/person/idle'), { recursive: true }); await writeFile(join(root, 'gallery/person/idle/frame-01.png'), Buffer.from('example-image'))
    assert.equal((await appearance.gallery())[0].id, 'gallery/person')
    assert.equal(await appearance.imagePath('gallery/../../outside', 'idle'), undefined)
    await writeFile(join(root, 'outside.png'), 'outside'); await mkdir(join(root, 'gallery/symlink'), { recursive: true }); await symlink('/etc/passwd', join(root, 'gallery/symlink/frame-01.png'))
    assert.equal(await appearance.imagePath('gallery/symlink', 'idle'), undefined)
    await appearance.setSession('session-a', 'gallery/person'); assert.equal(value.native_sessions[0].avatar_id, 'gallery/person'); assert.equal(value.native_sessions[1].avatar_id, undefined)
    await appearance.setSession('session-new', 'gallery/entry-host-only'); assert.equal(value.presentation.sessionAvatars['session-new'], 'gallery/entry-host-only')
    await assert.rejects(appearance.setSession('session-a', 'gallery/../escape'), /无效/)
    await appearance.setSession('session-a', null); assert.equal(value.native_sessions[0].avatar_id, null); assert.equal(appearance.avatarForSession('session-new', 'codex').id, 'gallery/entry-host-only')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('skill categories come from manifests or native metadata rather than treating every slash command as a skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-command-kind-'))
  try {
    await mkdir(join(root, '.agents/skills/reviewer'), { recursive: true }); await writeFile(join(root, '.agents/skills/reviewer/SKILL.md'), '---\nname: fixture-review\n---\nSkill instructions')
    const rows = await classifyCommands([{ name: 'fixture-review' }, { name: 'team:fixture-review' }, { name: 'mcp:fixture-review' }, { name: 'compact' }, { name: 'native-skill', _meta: { type: 'skill' } }], { type: 'claude', env: {} }, root, { home: join(root, 'home') })
    assert.deepEqual(rows.map(row => row.kind), ['skill', 'skill', 'command', 'command', 'skill'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('avatar delivery is owner-only and cannot read files outside the configured library', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-http-')), appearance = new SessionAppearance({}, {}, { avatarDirectory: root })
  let route
  registerAvatarApi({ webServer: { register: value => { route = value; return () => {} } }, connection: { admit: req => req.headers['x-test-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }, appearance)
  const server = createServer((req, res) => route.handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}/api/kode/avatars`
  assert.equal((await fetch(base + '/media?type=codebuddy')).status, 403)
  const image = await fetch(base + '/media?type=codebuddy', { headers: { 'x-test-owner': 'yes' } })
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await image.arrayBuffer()).subarray(1, 4).toString(), 'PNG')
  assert.equal((await fetch(base + '/media?avatar=gallery/../../outside', { headers: { 'x-test-owner': 'yes' } })).status, 404)
  assert.equal((await fetch(base + '/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatarId: 'gallery/person', name: 'renamed' }) })).status, 403)
  assert.equal((await fetch(base + '/rename', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'yes' }, body: JSON.stringify({ avatarId: 'gallery/person', name: '../escape' }) })).status, 400)
})
test('session avatars persist in Kode session metadata without changing a bound Agent snapshot', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-backend-')), token = randomBytes(32).toString('hex')
  await writeFile(join(root, 'token'), token, { mode: 0o600 }); await writeFile(join(root, 'config.json'), JSON.stringify({ node_id: 'appearance-fixture', database: join(root, 'state.sqlite'), peers: [] }))
  const backend = spawn(fileURLToPath(new URL('../../../target/debug/kode-session-server', import.meta.url)), ['--config', join(root, 'config.json'), '--token-file', join(root, 'token'), '--bind', '127.0.0.1:0'], { env: { ...process.env, KODE_GUI_STATE_PATH: join(root, 'gui-state.json') }, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const address = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('backend startup timed out')), 10000)
      backend.on('exit', () => { clearTimeout(timer); reject(new Error('backend exited')) })
      backend.stdout.on('data', bytes => { text += bytes; const match = text.match(/kode-session-server appearance-fixture (127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    })
    const client = new BackendClient(`http://${address}`, token), profiles = await new BackendAgentProfiles(client, join(root, 'profiles.json')).open()
    const profile = await profiles.save({ name: 'Appearance fixture', type: 'codex', executable: '/example/codex', args: ['--profile', 'fixture'] })
    await profiles.bind('appearance-fixture', profile.id)
    const before = profiles.binding('appearance-fixture'), appearance = new SessionAppearance(client, profiles)
    await appearance.setSession('session-avatar-a', 'gallery/entry-host-only')
    const value = await client.call('/api/v1/messaging/workbench/documents/session-index')
    assert.equal(value.value.presentation.sessionAvatars['session-avatar-a'], 'gallery/entry-host-only')
    const agents = await client.call('/api/v1/messaging/workbench/documents/agents')
    assert.deepEqual(agents.value.bindings['appearance-fixture'], before)
    assert.equal(appearance.profileView(before.profile, 'session-avatar-a').avatar.id, 'gallery/entry-host-only')
    assert.equal(appearance.profileView(before.profile, 'session-avatar-b').avatar.id, null)
  } finally { if (backend.exitCode === null && backend.signalCode === null) { const exited = once(backend, 'exit'); backend.kill('SIGINT'); await exited } await rm(root, { recursive: true, force: true }) }
})

test('built-in and custom Agent avatars persist independently and session overrides win', async () => {
  let value = { version: 1, native_sessions: [{ backend_key: 'codex', session_id: 'native', dsh_session_id: 'session-a' }] }, revision = 0
  const client = { async call(_path, body) { if (body) { assert.equal(body.expected_revision, revision); value = body.value; revision++ } return { value: structuredClone(value), revision } } }
  const rows = [{ id: 'builtin-codex', type: 'codex', origin: 'builtin' }, { id: 'work', type: 'codex', name: 'Work', executable: '/work/codex' }]
  const profiles = { list: () => rows }, before = structuredClone(rows)
  const appearance = new SessionAppearance(client, profiles)
  await appearance.setAgent('builtin-codex', 'gallery/default')
  await appearance.setAgent('work', 'gallery/work')
  assert.equal(appearance.profilesView()[0].avatar.id, 'gallery/default')
  assert.equal(appearance.profileView(rows[1], 'session-a').avatar.id, 'gallery/work')
  await appearance.setSession('session-a', 'gallery/personal')
  assert.equal(appearance.profileView(rows[1], 'session-a').avatar.id, 'gallery/personal')
  await appearance.setSession('session-a', null)
  assert.equal(appearance.profileView(rows[1], 'session-a').avatar.id, null)
  const reloaded = new SessionAppearance(client, profiles)
  await reloaded.load()
  assert.equal(reloaded.profileView(rows[1], 'another-session').avatar.id, 'gallery/work')
  await assert.rejects(appearance.setAgent('missing', null), /不存在/)
  await assert.rejects(appearance.setAgent('work', 'gallery/../escape'), /无效/)
  assert.deepEqual(rows, before)
})

test('avatar library exposes ordered animation frames and optional backgrounds with safe media routes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kode-avatar-scene-'))
 for(const state of ['idle','running/01','running/02']){
  await mkdir(join(root,'gallery/person',state),{recursive:true})
  for(let i=1;i<=4;i++)await writeFile(join(root,'gallery/person',state,`frame-0${i}.png`),`frame:${state}:${i}`)
 }
 await writeFile(join(root,'gallery/person/background.webp'),'background-fixture')
 const appearance=new SessionAppearance({}, {list:()=>[]}, {avatarDirectory:root})
 let route
 registerAvatarApi({connection:{admit:req=>req.headers['x-test-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:value=>{route=value;return()=>{}}}},appearance)
 const server=createServer((req,res)=>route.handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})})
 const base=`http://127.0.0.1:${server.address().port}`,headers={'x-test-owner':'yes'}
 const avatar=(await appearance.gallery())[0]
 assert.equal(avatar.animations.idle.length,4);assert.equal(avatar.animations.running.length,8)
 assert.equal(await (await fetch(base+avatar.animations.running[4],{headers})).text(),'frame:running/02:1')
 const bg=await fetch(base+avatar.background,{headers});assert.equal(bg.headers.get('content-type'),'image/webp');assert.equal(await bg.text(),'background-fixture')
 assert.equal((await fetch(base+avatar.background)).status,403)
 assert.equal((await fetch(base+'/api/kode/avatars/media?avatar=gallery/person&frame=25',{headers})).status,400)
 await symlink('/etc/passwd',join(root,'gallery/person/background.png'))
 assert.ok((await appearance.backgroundPath('gallery/person')).endsWith('background.webp'),'escaped symlink must never be served')
 assert.equal(await appearance.backgroundPath('gallery/../../escape'),undefined)
 const prompt=await (await fetch(base+'/api/kode/avatars/generation-prompt',{headers})).json()
 assert.match(prompt.prompt,/36 帧/);assert.match(prompt.prompt,/1920×1080/);assert.ok(prompt.prompt.includes(root))
 const background=await (await fetch(base+'/api/kode/avatars/generation-prompt?mode=background&avatar=gallery/person',{headers})).json()
 assert.match(background.prompt,/background only/);assert.match(background.prompt,/保留所有已有动画帧/)
})

test('picker labels omit numeric prefixes and hidden artwork keeps its stable media identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-avatar-labels-')),appearance=new SessionAppearance({}, {list:()=>[]},{avatarDirectory:root})
 try{
  for(const name of ['01-frieren','12-shiro','13-historia','14-petra']){
   await mkdir(join(root,'gallery',name,'idle'),{recursive:true});await writeFile(join(root,'gallery',name,'idle/frame-01.png'),'frame')
  }
  await writeFile(join(root,'.dsh-gallery.json'),JSON.stringify({version:1,hidden:['gallery/13-historia','gallery/14-petra']}))
  const gallery=await appearance.gallery()
  assert.deepEqual(gallery.map(row=>[row.id,row.name]),[['gallery/01-frieren','frieren'],['gallery/12-shiro','shiro']])
  assert.ok(await appearance.imagePath('gallery/13-historia','idle'),'removing a picker choice must not break avatars already selected by other conversations')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('renaming an avatar moves its folder, migrates shared references and keeps old SSH media identities usable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-avatar-rename-'))
 let value={version:1,native_sessions:[{avatar_id:'gallery/old'}],gui:{tabs:[{avatar_id:'gallery/old'}]},presentation:{agentAvatars:{codex:'gallery/old',other:'gallery/other'},sessionAvatars:{pending:'gallery/old'}}},revision=0,conflict=true
 const client={async call(_path,body){if(body){if(conflict){conflict=false;value.concurrent='preserved';revision++;throw new Error('configuration changed')}assert.equal(body.expected_revision,revision);value=body.value;revision++}return{value:structuredClone(value),revision}}}
 const appearance=new SessionAppearance(client,{list:()=>[]},{avatarDirectory:root})
 try{
  await mkdir(join(root,'gallery/old/idle'),{recursive:true});await writeFile(join(root,'gallery/old/idle/frame-01.png'),'original frame');await writeFile(join(root,'gallery/old/background.png'),'original background')
  const result=await appearance.renameAvatar('gallery/old','新头像')
  assert.equal(result.id,'gallery/新头像');await assert.rejects(readFile(join(root,'gallery/old/idle/frame-01.png')),/ENOENT/)
  assert.equal(await readFile(join(root,'gallery/新头像/idle/frame-01.png'),'utf8'),'original frame')
  assert.equal(value.native_sessions[0].avatar_id,result.id);assert.equal(value.gui.tabs[0].avatar_id,result.id);assert.equal(value.presentation.agentAvatars.codex,result.id);assert.equal(value.presentation.sessionAvatars.pending,result.id);assert.equal(value.presentation.agentAvatars.other,'gallery/other');assert.equal(value.concurrent,'preserved')
  assert.equal(await appearance.imagePath('gallery/old','idle'),await appearance.imagePath(result.id,'idle'));assert.equal(await appearance.backgroundPath('gallery/old'),await appearance.backgroundPath(result.id))
  await appearance.renameAvatar(result.id,'Renamed')
  const gallery=await appearance.gallery();assert.equal(gallery.length,1);assert.equal(gallery[0].name,'Renamed');assert.ok(gallery[0].aliases.includes('gallery/old'));assert.ok(gallery[0].aliases.includes(result.id))
  await mkdir(join(root,'gallery/taken'));await assert.rejects(appearance.renameAvatar('gallery/Renamed','taken'),/同名/)
  for(const name of ['../escape','a/b','a\\b','..','CON','bad\nname'])await assert.rejects(appearance.renameAvatar('gallery/Renamed',name),/名称/)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('failed avatar metadata updates restore the original folder and gallery catalog',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-avatar-rollback-'))
 const appearance=new SessionAppearance({async call(_path,body){if(body)throw new Error('metadata unavailable');return{value:{version:1},revision:0}}},{list:()=>[]},{avatarDirectory:root})
 try{
  await mkdir(join(root,'gallery/original/idle'),{recursive:true});await writeFile(join(root,'gallery/original/idle/frame-01.png'),'frame')
  await writeFile(join(root,'.dsh-gallery.json'),JSON.stringify({version:1,hidden:['gallery/hidden']}))
  await assert.rejects(appearance.renameAvatar('gallery/original','renamed'),/metadata unavailable/)
  assert.equal(await readFile(join(root,'gallery/original/idle/frame-01.png'),'utf8'),'frame');await assert.rejects(readFile(join(root,'gallery/renamed/idle/frame-01.png')),/ENOENT/)
  assert.deepEqual(JSON.parse(await readFile(join(root,'.dsh-gallery.json'),'utf8')),{version:1,hidden:['gallery/hidden']})
 }finally{await rm(root,{recursive:true,force:true})}
})
