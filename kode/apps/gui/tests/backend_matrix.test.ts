// 前端层的 backend 矩阵(静态断言层)。真实 BackendChooser / 安装确认交互
// 需要 GUI E2E,本轮不引入;这里锁定「17 个内置 backend 都能被 PATH 探测
// 白名单枚举」与「冷快照 + backends-changed 重拉」契约,与 Rust 侧
// backend_matrix 的 golden 清单保持一致。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const BACKEND_KEYS = [
  'amp',
  'antigravity',
  'claude',
  'claude-internal',
  'codebuddy',
  'codex',
  'copilot',
  'cursor',
  'droid',
  'gemini',
  'grok',
  'kimi',
  'kiro',
  'opencode',
  'pi',
  'tclaude',
  'tcodex',
]

const adminSource = await readFile(
  new URL('../src-tauri/src/backend_admin.rs', import.meta.url),
  'utf8',
)
const appSource = await readFile(new URL('../src/App.svelte', import.meta.url), 'utf8')

function knownCandidateKeys(): Set<string> {
  const start = adminSource.indexOf('pub(crate) const KNOWN_CANDIDATES')
  assert.ok(start >= 0, 'KNOWN_CANDIDATES must exist in backend_admin.rs')
  const end = adminSource.indexOf('];', start)
  const block = adminSource.slice(start, end)
  return new Set([...block.matchAll(/key:\s*"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]))
}

test('every built-in backend is a PATH probe candidate', () => {
  const keys = knownCandidateKeys()
  for (const key of BACKEND_KEYS) {
    assert.ok(keys.has(key), `${key} missing from KNOWN_CANDIDATES`)
  }
  assert.equal(BACKEND_KEYS.length, 17)
  assert.equal(keys.size, 17, 'update BACKEND_KEYS when adding/removing a built-in backend')
})

test('backend chooser keeps a cold snapshot and refreshes on backends-changed', () => {
  assert.match(appSource, /listBackends\(/)
  assert.match(appSource, /backends-changed/)
})
