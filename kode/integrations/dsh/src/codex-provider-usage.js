/** The Responses usage codec used by Codex rust-v0.154.0. No numeric coercion. */
export const codexUsageBasis = 'codex_responses_rust_v0.154.0'
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function codexProviderUsage(raw) {
  if (!object(raw) || ![raw.input_tokens, raw.output_tokens, raw.total_tokens].every(count)
      || raw.input_tokens + raw.output_tokens !== raw.total_tokens) return null
  let cached = 0, written = 0
  const input = raw.input_tokens_details
  if (input != null) {
    if (!object(input) || !count(input.cached_tokens)) return null
    cached = input.cached_tokens
    if (Object.hasOwn(input, 'cache_write_tokens')) {
      if (!count(input.cache_write_tokens)) return null
      written = input.cache_write_tokens
    }
  }
  if (cached + written > raw.input_tokens) return null
  const output = raw.output_tokens_details
  if (output != null && (!object(output) || !count(output.reasoning_tokens)
      || output.reasoning_tokens > raw.output_tokens)) return null
  return Object.freeze({ input_tokens: raw.input_tokens, cached_input_tokens: cached,
    cache_write_input_tokens: written, output_tokens: raw.output_tokens })
}
