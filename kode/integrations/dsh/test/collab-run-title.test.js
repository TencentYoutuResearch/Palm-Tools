import test from 'node:test'
import assert from 'node:assert/strict'
import { runTitle } from '../packages/collab/run-presentation.js'

test('run titles preserve projected task summaries and legacy natural-language requests', () => {
  for (const request_preview of ['Fix the session avatar', '请检查构建结果', '[Bug] Fix avatar', '{"user":"JSON request"}']) {
    assert.equal(runTitle({ request_preview }), request_preview)
  }
})
test('missing summaries and serialized contexts never become headings', () => {
  for (const request_preview of [undefined, null, '', '  ', {}, '{"context_id":"collaboration-task:test","format":"kode.collaboration.task-context.v2","scope":' + 'x'.repeat(240)]) {
    assert.equal(runTitle({ request_preview }), '团队任务')
  }
})
