import test from 'node:test'
import assert from 'node:assert/strict'
import { codexProviderUsage } from '../src/codex-provider-usage.js'
const raw = () => ({ input_tokens: 10, output_tokens: 2, total_tokens: 12 })
test('Responses 0.154 optional detail containers have explicit codec defaults', () => {
  for (const details of [undefined, null]) assert.deepEqual(codexProviderUsage({ ...raw(), input_tokens_details: details,
    output_tokens_details: details }), { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 })
  assert.deepEqual(codexProviderUsage({ ...raw(), input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 1 } }), { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 2 })
})
test('incomplete, malformed and contradictory reported counters are never coerced', () => {
  for (const change of [
    { input_tokens: '10' }, { input_tokens: -1 }, { input_tokens: 1.5 }, { total_tokens: undefined },
    { total_tokens: 13 }, { output_tokens: Number.MAX_SAFE_INTEGER },
    { input_tokens_details: {} }, { input_tokens_details: [] }, { input_tokens_details: 'private' },
    { input_tokens_details: { cached_tokens: null } }, { input_tokens_details: { cached_tokens: 11 } },
    { input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } },
    { input_tokens_details: { cached_tokens: 0, cache_write_tokens: null } },
    { output_tokens_details: {} }, { output_tokens_details: { reasoning_tokens: 3 } },
  ]) assert.equal(codexProviderUsage({ ...raw(), ...change }), null)
  assert.equal(codexProviderUsage(null), null)
})
