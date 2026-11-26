import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { installLocal, installSkillHub, localSkills, removeSkill, repairSkillLinks, SKILL_DIRS, skillhub, unzipSkill } from '../src/bot-skills.js'
import { registerBotsApi } from '../src/bots-api.js'

/** A minimal zip writer: `entries` is [name, text, { deflate, mode }]. */
function zip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const [name, text, { deflate = false, mode = 0o100644 } = {}] of entries) {
    const data = Buffer.from(text), body = deflate ? deflateRawSync(data) : data, file = Buffer.from(name)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, file, body); centrals.push(central, file)
    offset += local.length + file.length + body.length
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const skill = '---\nname: code-review\ndescription: Reviews code\n---\nBody'
function response(status, { body, headers = {} } = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: (async function* () { if (body) yield Buffer.from(body) })() }
}

test('zip extraction keeps safe files and refuses escapes, links and missing manifests', () => {
  const files = unzipSkill(zip([['SKILL.md', skill, { deflate: true }], ['refs/a.md', 'A'], ['_meta.json', '{}']]))
  assert.equal(files.get('SKILL.md').toString(), skill)
  assert.equal(files.get('refs/a.md').toString(), 'A')
  assert.equal(unzipSkill(zip([['pkg/SKILL.md', skill], ['pkg/x.md', 'X']])).get('x.md').toString(), 'X', 'one wrapping folder is stripped')
  for (const [entries, pattern] of [
    [[['SKILL.md', skill], ['../evil', 'x']], /不安全/],
    [[['SKILL.md', skill], ['/etc/x', 'x']], /不安全/],
    [[['SKILL.md', skill], ['a\\b', 'x']], /不安全/],
    [[['SKILL.md', skill], ['link', '/etc/passwd', { mode: 0o120777 }]], /符号链接/],
    [[['README.md', 'x']], /SKILL\.md/],
  ]) assert.throws(() => unzipSkill(zip(entries)), pattern)
  assert.throws(() => unzipSkill(Buffer.from('not a zip')), /zip/)
})

test('SkillHub installs follow its storage redirect only to trusted hosts and link every Agent folder', async t => {
  const home = await mkdtemp(join(tmpdir(), 'kode-bot-skill-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const requested = []
  const fetcher = async url => {
    requested.push(String(url))
    if (url.hostname === 'lightmake.site') return response(302, { headers: { location: 'https://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/code-review/1.0.0.zip' } })
    return response(200, { body: zip([['SKILL.md', skill], ['README.md', 'r']]) })
  }
  assert.deepEqual(await installSkillHub(home, 'code-review', { fetcher }), [])
  assert.equal(requested.length, 2)
  assert.equal(await readFile(join(home, '.kode/skills/code-review/SKILL.md'), 'utf8'), skill)
  for (const dir of SKILL_DIRS) {
    assert.ok((await lstat(join(home, dir, 'code-review'))).isSymbolicLink(), dir)
    assert.equal(await readFile(join(home, dir, 'code-review', 'SKILL.md'), 'utf8'), skill, `${dir} resolves to the stored copy`)
  }
  // A folder the user made by hand is never replaced.
  await mkdir(join(home, '.cursor/skills/mine'), { recursive: true })
  const skipped = await installSkillHub(home, 'mine', { fetcher: async url => url.hostname === 'lightmake.site' ? response(200, { body: zip([['SKILL.md', skill]]) }) : response(404) })
  assert.deepEqual(skipped, ['.cursor/skills'])
  assert.ok((await lstat(join(home, '.cursor/skills/mine'))).isDirectory())

  await assert.rejects(installSkillHub(home, 'evil', { fetcher: async () => response(302, { headers: { location: 'https://attacker.example/x.zip' } }) }), /不受信任/)
  await assert.rejects(installSkillHub(home, 'big', { fetcher: async () => response(200, { headers: { 'content-length': String(64 * 1024 * 1024) } }) }), /过大/)
  await assert.rejects(installSkillHub(home, '../x', { fetcher }), /无效/)

  await rm(join(home, '.claude/skills/code-review'))
  await repairSkillLinks(home, [{ slug: 'code-review' }, { slug: 'never-installed' }])
  assert.ok((await lstat(join(home, '.claude/skills/code-review'))).isSymbolicLink(), 'a missing link is restored without the network')
  await removeSkill(home, 'code-review')
  for (const dir of SKILL_DIRS) await assert.rejects(lstat(join(home, dir, 'code-review')))
  await assert.rejects(stat(join(home, '.kode/skills/code-review')))
})

test('local skills are listed from the user folders and only listed folders can be copied', async t => {
  const user = await mkdtemp(join(tmpdir(), 'kode-user-')), home = await mkdtemp(join(tmpdir(), 'kode-bot-'))
  t.after(() => Promise.all([rm(user, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]))
  for (const root of ['.claude/skills/review', '.agents/skills/review', '.codex/skills/plan']) {
    await mkdir(join(user, root), { recursive: true })
    await writeFile(join(user, root, 'SKILL.md'), root.includes('plan') ? '---\nname: planner\ndescription: "Plans work"\n---\n' : skill)
  }
  const listed = await localSkills({ home: user })
  assert.deepEqual(listed.map(row => [row.slug, row.name, row.description]), [['review', 'code-review', 'Reviews code'], ['plan', 'planner', 'Plans work']], 'identical copies collapse')
  await installLocal(home, 'plan', join(user, '.codex/skills/plan'), { userHome: user })
  assert.match(await readFile(join(home, '.claude/skills/plan/SKILL.md'), 'utf8'), /planner/)
  await assert.rejects(installLocal(home, 'etc', '/etc', { userHome: user }), /不存在/)
})

test('SkillHub queries are normalized and bounded', async () => {
  const seen = []
  const fetcher = async url => {
    seen.push(url.pathname + url.search)
    if (url.pathname.endsWith('/categories')) return response(200, { body: JSON.stringify({ items: [{ key: 'dev-programming', name: '开发编程' }, { key: 'old', name: 'x', active: false }] }) })
    if (url.pathname.endsWith('/search')) return response(200, { body: JSON.stringify({ results: [{ slug: 'code-review', displayName: 'Code Review', description_zh: '审查', stars: 3 }, { slug: '../bad' }] }) })
    return response(200, { body: JSON.stringify({ data: { total: 1, skills: [{ slug: 'x', name: 'X', description: 'en' }] } }) })
  }
  const q = value => new URLSearchParams(value)
  assert.deepEqual((await skillhub(q('skillhub=categories'), { fetcher })).categories, [{ key: 'dev-programming', name: '开发编程' }])
  const search = await skillhub(q('skillhub=search&q=review'), { fetcher })
  assert.deepEqual(search.skills.map(row => [row.slug, row.name, row.description, row.stars]), [['code-review', 'Code Review', '审查', 3]])
  assert.deepEqual(await skillhub(q('skillhub=search&q='), { fetcher }), { skills: [], total: 0 })
  const list = await skillhub(q('skillhub=list&category=dev-programming&page=999'), { fetcher })
  assert.equal(list.page, 50)
  assert.match(seen.at(-1), /category=dev-programming/)
  await skillhub(q('skillhub=list&category=a b'), { fetcher })
  assert.doesNotMatch(seen.at(-1), /category=/, 'an odd category is dropped, not forwarded')
  await assert.rejects(skillhub(q('skillhub=nope'), { fetcher }), /未知/)
})

test('bot skill actions install into the bot folder and keep the roster in step', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-bots-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roster = { bots: [{ id: 'b1', name: 'Kit', backend_key: 'claude', permission_ceiling: 'default', skills: [] }], homes: { b1: join(root, 'b1') }, workspaces: {}, root }
  const calls = []
  let handler
  const backend = { call: async (path, body) => {
    if (body?.action === 'upsert') { calls.push(body); Object.assign(roster.bots[0], body.bot) }
    return path.includes('watches') ? { runs: [] } : roster
  } }
  const fetcher = async url => url.hostname === 'lightmake.site' ? response(200, { body: zip([['SKILL.md', skill]]) }) : response(404)
  registerBotsApi({ get: () => undefined, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, webServer: { register: route => { handler = route.handler } } }, backend, { fetcher })
  const post = async body => { const res = { setHeader() {}, end(text) { this.body = JSON.parse(text) } }; await handler({ method: 'POST', async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }, res); return res }
  const installed = await post({ action: 'skill_install', id: 'b1', source: 'skillhub', slug: 'code-review', name: 'Code Review', description: '审查' })
  assert.equal(installed.statusCode, 200, installed.body.error)
  assert.deepEqual(calls.at(-1).bot.skills, [{ slug: 'code-review', source: 'skillhub', name: 'Code Review', description: '审查' }])
  assert.equal(calls.at(-1).bot.sessions, undefined, 'view-only fields never reach the roster')
  assert.ok((await lstat(join(root, 'b1/.claude/skills/code-review'))).isSymbolicLink())
  assert.equal((await post({ action: 'skill_install', id: 'b1', source: 'web', slug: 'x' })).statusCode, 400)
  await post({ action: 'skill_remove', id: 'b1', slug: 'code-review' })
  assert.deepEqual(roster.bots[0].skills, [])
  await assert.rejects(readlink(join(root, 'b1/.claude/skills/code-review')))
})
