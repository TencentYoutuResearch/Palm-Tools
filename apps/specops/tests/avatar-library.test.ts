import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { loadAvatarLibrary } from '../src/domain/avatar-library.js'

const cleanup: string[] = []

async function frames(dir: string, marker: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (let index = 1; index <= 4; index += 1) {
    await writeFile(path.join(dir, `frame-${String(index).padStart(2, '0')}.png`), `${marker}-${index}`)
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Kode avatar library compatibility', () => {
  test('loads gallery previews and state variants as four-frame data URLs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'specops-avatar-'))
    cleanup.push(root)
    await frames(path.join(root, 'gallery', 'fox', 'idle'), 'idle')
    await frames(path.join(root, 'gallery', 'fox', 'running', '01'), 'running-a')
    await frames(path.join(root, 'gallery', 'fox', 'running', '02'), 'running-b')

    const library = await loadAvatarLibrary(root)
    expect(library.gallery).toHaveLength(1)
    expect(library.gallery[0]?.name).toBe('gallery/fox')
    expect(library.gallery[0]?.frames).toHaveLength(4)
    expect(library.running.filter((set) => set.name === 'gallery/fox')).toHaveLength(2)
    expect(library.gallery[0]?.frames[0]).toMatch(/^data:image\/png;base64,/)
  })

  test('ignores incomplete avatar sets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'specops-avatar-'))
    cleanup.push(root)
    const dir = path.join(root, 'gallery', 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'frame-01.png'), 'only-one')
    expect((await loadAvatarLibrary(root)).gallery).toEqual([])
  })
})
