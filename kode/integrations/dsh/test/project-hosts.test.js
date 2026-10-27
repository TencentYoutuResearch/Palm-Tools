import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectHosts, validateHost } from '../src/project-hosts.js'
import { searchSessions } from '../src/session-search.js'

test('name discovery ranks exact titles, keeps ambiguous matches and never invents addresses', () => {
  const sessions = ['架构评审', '架构评审：远端', '架构评审', '其他会话'].map((title, i) => ({ title, address: { node_id: 'host.example', session_id: `session-${i}` } }))
  const result = searchSessions({ sessions }, '架构 评审')
  assert.deepEqual(result.sessions, [sessions[0], sessions[2], sessions[1]])
  assert.equal(searchSessions({ sessions }, 'session-0').sessions.length, 0)
  assert.equal(searchSessions({ sessions }, '不存在').sessions.length, 0)
  assert.equal(searchSessions({ sessions }, '   ').sessions.length, 4)
})
test('SSH host configuration rejects option injection and non-loopback dsh targets', () => {
  const valid = { name: 'Build', host: 'build.example', accessUrl: 'http://127.0.0.1:3080/?token=test-only' }
  assert.equal(validateHost(valid).remote_port, 3080)
  for (const patch of [{ host: '-oProxyCommand=bad' }, { host: 'x\ny' }, { port: 65536 }, { accessUrl: 'http://other.example/?token=x' }, { accessUrl: 'http://127.0.0.1/' }]) assert.throws(() => validateHost({ ...valid, ...patch }))
})
test('an unavailable SSH host cannot break the directory when GUI has saved remote sessions',async()=>{
 const registry={list:()=>[],archivedSessionIds:[],pinnedSessionIds:[]}
 const ctx={get:key=>key==='workspaceRegistry'?registry:undefined,sessionController:{list:async()=>({items:[]})}}
 const backendClient={call:async()=>({tabs:[{backend_key:'codex',session_id:'remote-thread',cwd:'/srv/project',title:'Remote helper',endpoint_id:{kind:'remote',id:'remote'}}],endpoints:[{id:'remote',ssh_host:'builder@build.example'}]})}
 const manager=new ProjectHosts(ctx,{backendClient})
 manager.hosts=[{id:'build',name:'Build',host:'build.example'}]
 manager.directoryCache.set('build',{checkedAt:Date.now(),status:'offline',error:'Connection unavailable'})
 try{const snapshot=await manager.directory();assert.equal(snapshot.hosts[1].status,'offline');assert.equal(snapshot.hosts[1].sessions[0].title,'Remote helper');assert.deepEqual(snapshot.hosts[1].workspaces,[])}finally{await manager.close()}
})
test('SSH settings edits retain private credentials, persist changes, and protect the active host', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kode-ssh-settings-'))
  const file = join(directory, 'hosts.json'), manager = new ProjectHosts({}, { projectHostsFile: file })
  let current = 'local'
  const server = createServer((req, res) => manager.handle(req, res, current))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); server.close(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  const post = async input => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    return { status: response.status, body: await response.json() }
  }
  const created = await post({ action: 'save', name: 'Build', host: 'build.example', accessUrl: 'http://127.0.0.1:3080/?token=private-secret', configFile: '/example/ssh.conf' })
  assert.equal(created.status, 200)
  const id = created.body.id
  const edited = await post({ action: 'save', id, name: 'Renamed', host: 'build.example', port: 2222, accessUrl: '' })
  assert.equal(edited.status, 200)
  assert.doesNotMatch(JSON.stringify(edited.body), /private-secret|config_file/)
  const [saved] = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.name, 'Renamed'); assert.equal(saved.port, 2222)
  assert.equal(saved.token, 'private-secret'); assert.equal(saved.config_file, '/example/ssh.conf')
  current = id
  assert.equal((await post({ action: 'delete', id })).status, 400)
  assert.equal((await post({ action: 'save', id, name: 'Blocked', host: 'build.example' })).status, 400)
  current = 'local'
  assert.equal((await post({ action: 'delete', id })).status, 200)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [])
})
test('SSH portal isolates authentication, preserves streams, rejects CSRF, and closes owned tunnel', async t => {
  const upstreamRequests = []
  const upstream = createServer((req, res) => {
    upstreamRequests.push({ url: req.url, cookie: req.headers.cookie, origin: req.headers.origin })
    if (req.url === '/?token=upstream-secret') { res.writeHead(303, { 'set-cookie': 'upstream=owner; HttpOnly', location: './' }); res.end(); return }
    if (req.headers.cookie !== 'upstream=owner') { res.writeHead(401); res.end(); return }
    if (req.url === '/api/kode/project-hosts') { res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('remote:'); req.pipe(res)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  let closed = 0, calls = 0
  const manager = new ProjectHosts({}, {}, async () => { calls++; return { url: `http://127.0.0.1:${upstream.address().port}`, close: async () => { closed++ } } })
  manager.hosts = [{ id: 'build', name: 'Build', host: 'build.example', token: 'upstream-secret' }]
  t.after(() => manager.close())
  const [portal, same] = await Promise.all([manager.connect('build'), manager.connect('build')])
  assert.equal(portal, same); assert.equal(calls, 1)
  assert.equal((await fetch(portal.origin)).status, 401)
  portal.tickets.set('one-use', Date.now() + 10000)
  const login = await fetch(`${portal.origin}/?kode_ticket=one-use`, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie()[0].split(';')[0]
  assert.equal(login.status, 303)
  assert.doesNotMatch(cookie, /upstream-secret|upstream=owner/)
  assert.equal((await fetch(`${portal.origin}/?kode_ticket=one-use`)).status, 401)
  const options = { method: 'POST', headers: { cookie, origin: portal.origin }, body: 'terminal-input' }
  const result = await fetch(`${portal.origin}/api/terminal`, options)
  assert.equal(await result.text(), 'remote:terminal-input')
  assert.equal(upstreamRequests.at(-1).cookie, 'upstream=owner')
  assert.equal((await fetch(`${portal.origin}/api/terminal`, { ...options, headers: { cookie, origin: 'http://evil.example' } })).status, 401)
  const directory = await (await fetch(`${portal.origin}/api/kode/project-hosts`, { headers: { cookie } })).json()
  assert.equal(directory.current, 'build'); assert.doesNotMatch(JSON.stringify(directory), /upstream-secret/)
  await manager.disconnect('build'); assert.equal(closed, 1)
})
