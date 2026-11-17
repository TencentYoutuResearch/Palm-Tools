import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpSession } from '../src/acp-session.js'
test('real type=claude SDK bridge consumes only owned stream-json input and retains terminal usage', { timeout: 25000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kode-sdk-fixture-')), log = join(dir, 'wire.jsonl')
  const s = new AcpSession({ type: 'claude', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-claude-stream-json.js', import.meta.url))], env: { KODE_CLAUDE_FIXTURE_LOG: log, CLAUDE_CONFIG_DIR: dir } }, dir, { policy: () => ({ mode: 'read-only' }) })
  try {
    await s.open({}, [])
    const events = []
    for await (const e of s.turn([{ type: 'text', text: 'OWNED_A_CANARY' }], { model: 'fixture-claude', signal: AbortSignal.timeout(15000) })) events.push(e)
    const evidence = events.find(e => e.method === 'kode/acp_terminal_usage')?.params
    assert.ok(evidence); assert.equal(evidence.billing_eligible, false)
    assert.equal(evidence.scope, 'prompt_turn_reported')
    assert.equal(evidence.main_loop_total.input_tokens, 15)
    assert.equal(evidence.model_totals[0].counters.input_tokens, 25)
    const wire = await readFile(log, 'utf8')
    assert.match(wire, /OWNED_A_CANARY/); assert.doesNotMatch(wire, /FOREIGN_B_CANARY|PRIVATE_CANARY/)
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }) }
})
