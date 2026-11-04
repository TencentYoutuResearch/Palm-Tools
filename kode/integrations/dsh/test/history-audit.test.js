import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Session } from '@deepseek-ai/dsh-session'
import { encodeHistoryArtifact } from '../src/native-history.js'
test('history audit discovers newly created artifacts on each invocation and rejects corrupt history without changing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-history-audit-'))
  const modules = resolve(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session'))), '../../..')
  const args = [fileURLToPath(new URL('../scripts/audit-history.js', import.meta.url)), '--home', root, '--runtime-modules', modules]
  const run = () => promisify(execFile)(process.execPath, args)
  const add = async (id, events) => {
    const path = join(root, 'sessions', 'workspace', id); await mkdir(path, { recursive: true })
    await writeFile(join(path, 'session.v4.jsonl.zstd'), encodeHistoryArtifact({ type: 'session', ...Session.create(id).header }, events))
  }
  try {
    await add('first', [])
    assert.equal(JSON.parse((await run()).stdout).scanned, 1)
    await add('newly-created', [{ seq: 0, time: 1, type: 'plugin:fixture/required-state', data: {} }])
    await assert.rejects(run(), error => {
      const report = JSON.parse(error.stdout)
      assert.equal(report.scanned, 2); assert.equal(report.passed, 1)
      assert.equal(report.problems[0].sessionId, 'newly-created')
      assert.match(report.problems[0].error, /not marked ignorable/)
      return true
    })
    await assert.rejects(run(), error => JSON.parse(error.stdout).problems[0].sessionId === 'newly-created')
  } finally { await rm(root, { recursive: true, force: true }) }
})
