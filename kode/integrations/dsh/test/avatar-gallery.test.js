import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionAppearance } from '../src/session-appearance.js'

test('redrawn avatar frames get new URLs, so no view keeps a cached picture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatars-'))
  const idle = join(root, 'gallery', '01-kit', 'idle')
  await mkdir(idle, { recursive: true })
  await writeFile(join(idle, 'frame-01.png'), 'a')
  const appearance = new SessionAppearance({}, { list: () => [] }, { avatarDirectory: root })
  const [before] = await appearance.gallery()
  assert.match(before.url, /&state=idle&v=\d+-1$/)
  assert.match(before.animations.idle[0], /&frame=1&v=\d+-1$/)
  await writeFile(join(idle, 'frame-01.png'), 'redrawn')
  await utimes(join(idle, 'frame-01.png'), new Date(), new Date(Date.now() + 5000))
  const [after] = await appearance.gallery()
  assert.notEqual(after.url, before.url)
  assert.notEqual(after.animations.idle[0], before.animations.idle[0])
})

test('avatar gallery exposes optional Discord-style banner alongside background and falls back cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-banner-'))
  const dir = join(root, 'gallery', '01-kit')
  await mkdir(join(dir, 'idle'), { recursive: true })
  await writeFile(join(dir, 'idle', 'frame-01.png'), 'a')
  await writeFile(join(dir, 'background.png'), 'bg')
  const appearance = new SessionAppearance({}, { list: () => [] }, { avatarDirectory: root })
  const [withoutBanner] = await appearance.gallery()
  assert.ok(withoutBanner.background)
  assert.equal(withoutBanner.banner, undefined)
  assert.equal(await appearance.bannerPath(withoutBanner.id), undefined)
  assert.equal(await appearance.backgroundPath(withoutBanner.id), await realpath(join(dir, 'background.png')))
  await writeFile(join(dir, 'banner.png'), 'banner-img')
  const [withBanner] = await appearance.gallery()
  assert.match(withBanner.banner, /variant=banner/)
  assert.equal(await appearance.bannerPath(withBanner.id), await realpath(join(dir, 'banner.png')))
})
