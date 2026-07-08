import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import { startServer, type ServeHandle } from '../src/server/index.js'
import { gitCommit, gitWorkspace } from './helpers.js'

const cleanup: string[] = []
const servers: ServeHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(cleanup.splice(0).map((item) => require('node:fs/promises').rm(item, { recursive: true, force: true })))
})

async function fixture() {
  const workspace = await gitWorkspace()
  cleanup.push(workspace)
  await initWorkspace(workspace)
  const server = await startServer({ workspace, token: 'history-token' })
  servers.push(server)
  return { workspace, server }
}

function auth(server: ServeHandle, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${server.token}`,
      origin: server.origin,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  }
}

describe('document history API', () => {
  test('returns commits for a document with tracked history', async () => {
    const { server, workspace } = await fixture()
    const rel = '.specops/specs/auth.md'
    // Create the doc and commit it three times so git log --follow has history.
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(workspace, '.specops', 'specs'), { recursive: true })
    await writeFile(join(workspace, rel), '# Auth\nv1\n')
    const h1 = await gitCommit(workspace, 'v1: init', rel)
    await writeFile(join(workspace, rel), '# Auth\nv1\nv2\n')
    await gitCommit(workspace, 'v2: update', rel)
    await writeFile(join(workspace, rel), '# Auth\nv1\nv2\nv3\n')
    await gitCommit(workspace, 'v3: more', rel)

    const res = await fetch(
      `${server.origin}/api/document/history?path=${encodeURIComponent(rel)}`,
      auth(server),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { commits: Array<{ hash: string; short: string; author: string; date: string; message: string }> }
    expect(body.commits.length).toBe(3)
    expect(body.commits[0].message).toBe('v3: more')
    expect(body.commits[2].message).toBe('v1: init')
    expect(body.commits[0].hash.length).toBeGreaterThanOrEqual(7)
    expect(body.commits[0].short.length).toBe(8)
    expect(body.commits[0].author).toBe('SpecOps Test')
    expect(body.commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('returns empty commits for an untracked file without erroring', async () => {
    const { server, workspace } = await fixture()
    const rel = '.specops/specs/never-committed.md'
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(workspace, '.specops', 'specs'), { recursive: true })
    await writeFile(join(workspace, rel), '# never committed\n')

    const res = await fetch(
      `${server.origin}/api/document/history?path=${encodeURIComponent(rel)}`,
      auth(server),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { commits: unknown[] }
    expect(body.commits).toEqual([])
  })

  test('rejects a path outside canonical document roots with 400', async () => {
    const { server } = await fixture()
    const res = await fetch(
      `${server.origin}/api/document/history?path=${encodeURIComponent('../../../etc/passwd')}`,
      auth(server),
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_path')
  })

  test('rejects an invalid commit hash with 400', async () => {
    const { server } = await fixture()
    const rel = '.specops/specs/auth.md'
    const res = await fetch(
      `${server.origin}/api/document/diff?path=${encodeURIComponent(rel)}&hash=invalid`,
      auth(server),
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_hash')
  })

  test('rejects a hash containing shell metacharacters with 400', async () => {
    const { server } = await fixture()
    const rel = '.specops/specs/auth.md'
    const res = await fetch(
      `${server.origin}/api/document/diff?path=${encodeURIComponent(rel)}&hash=${encodeURIComponent('abcd;rm -rf /')}`,
      auth(server),
    )
    expect(res.status).toBe(400)
  })

  test('returns a unified diff for a known commit', async () => {
    const { server, workspace } = await fixture()
    const rel = '.specops/specs/auth.md'
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(workspace, '.specops', 'specs'), { recursive: true })
    await writeFile(join(workspace, rel), '# Auth\nv1\n')
    const hash = await gitCommit(workspace, 'v1: init', rel)

    const res = await fetch(
      `${server.origin}/api/document/diff?path=${encodeURIComponent(rel)}&hash=${hash}`,
      auth(server),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { hash: string; diff: string }
    expect(body.hash).toBe(hash)
    expect(body.diff).toContain('diff --git')
    // --full-index makes the index line carry the full 40-char blob hash,
    // not a 7-char abbreviated one. Assert the index line is present and long.
    expect(body.diff).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m)
  })
})
