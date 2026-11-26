/** Skills for a bot ("伙伴"): browsed on SkillHub or this computer, installed
 *  into the bot's own folder only. Every Agent reads project skills from its
 *  working directory, so one stored copy is linked into each Agent's folder. */
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { deduplicateSkillCopies } from './codex-skills.js'

export const SKILLHUB = 'https://lightmake.site'
// SkillHub hands downloads to its object storage.
const DOWNLOAD_HOSTS = /^(lightmake\.site|skillhub-[a-z0-9-]+\.cos\.(accelerate|[a-z0-9-]+)\.myqcloud\.com)$/
/** Where each Agent family looks for project skills, relative to its working directory. */
export const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.codebuddy/skills', '.cursor/skills']
const STORE = '.kode/skills'
const MAX_JSON = 2 * 1024 * 1024, MAX_ZIP = 20 * 1024 * 1024, MAX_UNPACKED = 50 * 1024 * 1024, MAX_FILES = 1000

export function validSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(slug) && !slug.startsWith('.')
}

async function fetchLimited(fetcher, url, limit, { binary = false } = {}) {
  let target = new URL(url)
  for (let hop = 0; hop < 4; hop++) {
    if (target.protocol !== 'https:' || !DOWNLOAD_HOSTS.test(target.hostname)) throw new Error('SkillHub 返回了不受信任的地址')
    const response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(binary ? 60_000 : 15_000), headers: { accept: binary ? 'application/zip' : 'application/json' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('SkillHub 重定向缺少地址')
      target = new URL(location, target); continue
    }
    if (!response.ok) throw new Error(`SkillHub 暂不可用（HTTP ${response.status}）`)
    if (Number(response.headers.get('content-length')) > limit) throw new Error('SkillHub 返回内容过大')
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw new Error('SkillHub 返回内容过大')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (binary) return bytes
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('SkillHub 返回了无效数据') }
  }
  throw new Error('SkillHub 重定向过多')
}

const card = row => ({
  slug: row.slug, name: row.displayName || row.name || row.slug,
  description: (row.description_zh || row.description || row.summary || '').slice(0, 400),
  icon: row.icon_url ?? row.iconUrl ?? null, category: row.category ?? null,
  downloads: Number(row.downloads) || 0, stars: Number(row.stars) || 0, homepage: row.homepage ?? null,
})

/** Read-only SkillHub queries, proxied so the browser never leaves this Host. */
export async function skillhub(query, { fetcher = globalThis.fetch } = {}) {
  const kind = query.get('skillhub')
  if (kind === 'categories') {
    const value = await fetchLimited(fetcher, `${SKILLHUB}/api/v1/categories`, MAX_JSON)
    return { categories: (value.items ?? []).filter(row => row.active !== false && typeof row.key === 'string').map(row => ({ key: row.key, name: row.name ?? row.key })) }
  }
  const page = Math.min(50, Math.max(1, Number(query.get('page')) || 1))
  if (kind === 'search') {
    const q = String(query.get('q') ?? '').trim().slice(0, 200)
    if (!q) return { skills: [], total: 0 }
    const value = await fetchLimited(fetcher, `${SKILLHUB}/api/v1/search?${new URLSearchParams({ q, limit: '24' })}`, MAX_JSON)
    const skills = (value.results ?? []).filter(row => validSlug(row.slug)).map(card)
    return { skills, total: skills.length }
  }
  if (kind === 'list') {
    const params = new URLSearchParams({ sortBy: 'score', order: 'desc', page: String(page), pageSize: '24' })
    const category = String(query.get('category') ?? '')
    if (/^[a-z0-9-]{1,64}$/.test(category)) params.set('category', category)
    const value = await fetchLimited(fetcher, `${SKILLHUB}/api/skills?${params}`, MAX_JSON)
    return { skills: (value.data?.skills ?? []).filter(row => validSlug(row.slug)).map(card), total: Number(value.data?.total) || 0, page }
  }
  throw new Error('未知的 SkillHub 查询')
}

/** Files of a zip archive, refusing anything that could escape its folder. */
export function unzipSkill(bytes) {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('技能包不是有效的 zip')
  const count = bytes.readUInt16LE(eocd + 10)
  if (count > MAX_FILES) throw new Error('技能包文件过多')
  let offset = bytes.readUInt32LE(eocd + 16), total = 0
  const files = new Map()
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('技能包目录损坏')
    const method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32)
    const external = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extra + comment
    if (name.endsWith('/')) continue
    const parts = name.split('/')
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..')) throw new Error(`技能包包含不安全的路径：${name}`)
    // Unix mode in the high bits; 0o120000 is a symbolic link.
    if (((external >>> 16) & 0o170000) === 0o120000) throw new Error(`技能包包含符号链接：${name}`)
    total += size
    if (total > MAX_UNPACKED) throw new Error('技能包解压后过大')
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('技能包文件头损坏')
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const raw = bytes.subarray(start, start + compressed)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : null
    if (!data || data.length !== size) throw new Error(`技能包使用了不支持的压缩方式：${name}`)
    files.set(name, data)
  }
  // Accept one wrapping folder; SkillHub puts SKILL.md at the top.
  const tops = new Set([...files.keys()].map(name => name.split('/')[0]))
  if (!files.has('SKILL.md') && tops.size === 1) {
    const [top] = tops
    if (files.has(`${top}/SKILL.md`)) return new Map([...files].map(([name, data]) => [name.slice(top.length + 1), data]))
  }
  if (!files.has('SKILL.md')) throw new Error('技能包缺少 SKILL.md')
  return files
}

const storeOf = (home, slug) => join(home, STORE, slug)

/** Link the stored copy into every Agent's skill folder. A real folder the
 *  user put there is left alone. */
export async function linkSkill(home, slug) {
  const skipped = []
  for (const dir of SKILL_DIRS) {
    const link = join(home, dir, slug), target = relative(dirname(link), storeOf(home, slug))
    await mkdir(dirname(link), { recursive: true })
    const existing = await lstat(link).catch(() => null)
    if (existing?.isSymbolicLink()) { if (await readlink(link) === target) continue; await rm(link) }
    else if (existing) { skipped.push(dir); continue }
    await symlink(target, link, 'dir')
  }
  return skipped
}

async function place(home, slug, write) {
  if (!validSlug(slug)) throw new Error('无效的技能标识')
  const final = storeOf(home, slug), staging = join(home, STORE, `.tmp-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    await write(staging)
    await rm(final, { recursive: true, force: true })
    await rename(staging, final)
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  return linkSkill(home, slug)
}

export async function installSkillHub(home, slug, { fetcher = globalThis.fetch } = {}) {
  if (!validSlug(slug)) throw new Error('无效的技能标识')
  const files = unzipSkill(await fetchLimited(fetcher, `${SKILLHUB}/api/v1/download?${new URLSearchParams({ slug })}`, MAX_ZIP, { binary: true }))
  return place(home, slug, async staging => {
    for (const [name, data] of files) {
      await mkdir(dirname(join(staging, name)), { recursive: true })
      await writeFile(join(staging, name), data)
    }
  })
}

function frontmatter(text) {
  const head = text.startsWith('---') ? text.split('---')[1] ?? '' : ''
  const field = key => new RegExp(`^${key}:\\s*["']?([^\\r\\n]+?)["']?\\s*$`, 'm').exec(head)?.[1]?.trim()
  return { name: field('name'), description: field('description') }
}

/** Skills already on this computer, in the user-wide folders each Agent reads. */
export async function localSkills({ home = homedir() } = {}) {
  const roots = ['.claude', '.agents', '.codex', '.codebuddy', '.tclaude', '.cursor'].map(name => join(home, name, 'skills'))
  const found = []
  for (const root of roots) {
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.slice(0, 400)) {
      if (entry.name.startsWith('.') || !validSlug(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
      const file = join(root, entry.name, 'SKILL.md')
      try {
        if ((await stat(file)).size > 1024 * 1024) continue
        const meta = frontmatter(await readFile(file, 'utf8'))
        found.push({ slug: entry.name, name: meta.name || entry.name, description: (meta.description ?? '').slice(0, 400), path: join(root, entry.name), file })
      } catch {}
    }
  }
  const unique = await deduplicateSkillCopies(found.map(row => ({ ...row, path: row.file })))
  return unique.map(({ file: _file, ...row }) => ({ ...row, path: dirname(row.path) }))
}

/** Copy a listed local skill. Only folders `localSkills` reports are accepted. */
export async function installLocal(home, slug, path, { userHome = homedir() } = {}) {
  const listed = (await localSkills({ home: userHome })).find(row => row.slug === slug && row.path === path)
  if (!listed) throw new Error('这个本机技能已不存在，请刷新后重试')
  const source = await realpath(path)
  return place(home, slug, staging => cp(source, staging, { recursive: true, dereference: true, force: true }))
}

export async function removeSkill(home, slug) {
  if (!validSlug(slug)) throw new Error('无效的技能标识')
  for (const dir of SKILL_DIRS) {
    const link = join(home, dir, slug)
    if ((await lstat(link).catch(() => null))?.isSymbolicLink()) await rm(link)
  }
  await rm(storeOf(home, slug), { recursive: true, force: true })
}

/** Restore missing links for skills whose stored copy is still there. */
export async function repairSkillLinks(home, skills = []) {
  for (const skill of skills) {
    if (!validSlug(skill.slug)) continue
    if (await stat(storeOf(home, skill.slug)).then(info => info.isDirectory(), () => false)) await linkSkill(home, skill.slug).catch(() => {})
  }
}

export const skillRecord = (source, row) => ({
  slug: row.slug, source, name: String(row.name || row.slug).trim().slice(0, 120),
  ...(row.description ? { description: String(row.description).slice(0, 1024) } : {}),
})
