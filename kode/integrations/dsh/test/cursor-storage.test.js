import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cursorConfigDir,
  cursorWorkspaceHash,
  ensureCursorAcpSession,
  ensureCursorCliChat,
} from '../src/cursor-storage.js'

test('cursorConfigDir respects CURSOR_CONFIG_DIR and XDG_CONFIG_HOME', () => {
  assert.equal(cursorConfigDir({ CURSOR_CONFIG_DIR: '/custom/cursor' }), '/custom/cursor')
  assert.equal(cursorConfigDir({ XDG_CONFIG_HOME: '/xdg/config' }), join('/xdg/config', 'cursor'))
})

test('ensureCursorAcpSession symlinks CLI chat directory into acp-sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-cursor-bridge-'))
  try {
    const cwd = '/tmp/my-cursor-workspace'
    const sid = '01f704d9-c18e-4409-a738-8e97ef8b042f'
    const chatDir = join(root, 'chats', cursorWorkspaceHash(cwd), sid)
    await mkdir(chatDir, { recursive: true })
    await writeFile(join(chatDir, 'store.db'), 'sqlite-content')
    await writeFile(join(chatDir, 'meta.json'), '{"schemaVersion":1}')

    const linked = await ensureCursorAcpSession(sid, cwd, { CURSOR_CONFIG_DIR: root })
    assert.equal(linked, true)

    const acpDir = join(root, 'acp-sessions', sid)
    assert.equal((await lstat(acpDir)).isSymbolicLink(), true)
    assert.equal(await realpath(acpDir), await realpath(chatDir))
    assert.equal(await readFile(join(acpDir, 'store.db'), 'utf8'), 'sqlite-content')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureCursorAcpSession falls back to scanning chats/* and replaces empty probe dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-cursor-bridge-scan-'))
  try {
    const sid = '2dfc74dd-f524-4f84-b8a2-2f1dd52cf9c1'
    const chatDir = join(root, 'chats', 'deadbeef000011112222333344445555', sid)
    await mkdir(chatDir, { recursive: true })
    await writeFile(join(chatDir, 'store.db'), 'real-chat-db')

    // Pre-existing empty probe directory in acp-sessions (meta.json only, no store.db).
    const acpDir = join(root, 'acp-sessions', sid)
    await mkdir(acpDir, { recursive: true })
    await writeFile(join(acpDir, 'meta.json'), '{"schemaVersion":1,"cwd":"/other"}')

    const linked = await ensureCursorAcpSession(sid, '/different/cwd', { CURSOR_CONFIG_DIR: root })
    assert.equal(linked, true)
    assert.equal((await lstat(acpDir)).isSymbolicLink(), true)
    assert.equal(await readFile(join(acpDir, 'store.db'), 'utf8'), 'real-chat-db')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureCursorAcpSession preserves an existing acp-sessions store.db', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-cursor-bridge-keep-'))
  try {
    const sid = 'existing-acp-session'
    const acpDir = join(root, 'acp-sessions', sid)
    await mkdir(acpDir, { recursive: true })
    await writeFile(join(acpDir, 'store.db'), 'acp-db')

    const linked = await ensureCursorAcpSession(sid, '/tmp/ws', { CURSOR_CONFIG_DIR: root })
    assert.equal(linked, true)
    assert.equal((await lstat(acpDir)).isSymbolicLink(), false)
    assert.equal(await readFile(join(acpDir, 'store.db'), 'utf8'), 'acp-db')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureCursorCliChat links ACP session into chats/<md5(cwd)>/<id> only when store.db exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-cursor-bridge-rev-'))
  try {
    const cwd = '/tmp/my-cursor-workspace'
    const probeId = 'probe-only-no-db'
    await mkdir(join(root, 'acp-sessions', probeId), { recursive: true })
    await writeFile(join(root, 'acp-sessions', probeId, 'meta.json'), '{}')
    assert.equal(await ensureCursorCliChat(probeId, cwd, { CURSOR_CONFIG_DIR: root }), false)

    const sid = 'real-acp-chat'
    const acpDir = join(root, 'acp-sessions', sid)
    await mkdir(acpDir, { recursive: true })
    await writeFile(join(acpDir, 'store.db'), 'acp-sqlite')

    assert.equal(await ensureCursorCliChat(sid, cwd, { CURSOR_CONFIG_DIR: root }), true)
    const chatDir = join(root, 'chats', cursorWorkspaceHash(cwd), sid)
    assert.equal((await lstat(chatDir)).isSymbolicLink(), true)
    assert.equal(await realpath(chatDir), await realpath(acpDir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects unsafe session IDs with path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-cursor-bridge-safe-'))
  try {
    assert.equal(await ensureCursorAcpSession('../escape', '/tmp/ws', { CURSOR_CONFIG_DIR: root }), false)
    assert.equal(await ensureCursorCliChat('a/b', '/tmp/ws', { CURSOR_CONFIG_DIR: root }), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
