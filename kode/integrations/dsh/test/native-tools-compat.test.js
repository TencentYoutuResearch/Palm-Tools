import test from 'node:test'
import assert from 'node:assert/strict'
import { executeNativeTool } from '../src/native-tools.js'

test('batch dispatch retains scoped execution, serialized arguments and tool-owned failures without duplicate logging', async () => {
  const agent = {}, signal = new AbortController().signal
  const result = { isError: true, content: [{ type: 'text', text: 'policy denied' }] }
  let calls = 0
  const tools = { selectExecutor() {}, async execute(input) {
    calls++
    assert.equal(input.agent, agent); assert.equal(input.signal, signal); assert.equal(input.log, undefined)
    assert.deepEqual(input.calls, [{ id: 'native:1', name: 'bash', arguments: JSON.stringify({ command: 'printf "line\\n"', run_in_background: true }) }])
    return { results: [{ callId: 'native:1', result }], additionalContexts: [], concluded: false }
  } }
  assert.equal(await executeNativeTool(tools, { callId: 'native:1', name: 'bash', arguments: { command: 'printf "line\\n"', run_in_background: true }, agent, signal }), result)
  assert.equal(calls, 1)
})

test('missing batch results fail without replaying a potentially executed tool', async () => {
  let calls = 0
  const tools = { selectExecutor() {}, async execute() { calls++; return { results: [] } } }
  await assert.rejects(executeNativeTool(tools, { callId: 'native:1', name: 'bash', arguments: {} }), /no result/)
  assert.equal(calls, 1)
})
