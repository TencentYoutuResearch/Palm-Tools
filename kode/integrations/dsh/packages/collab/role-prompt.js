/** Per-role instruction values, as the Team revision stores them. No React. */
/** Server limits; a GET /api/kode/builder/proposal response may carry its own values. */
export const PROMPT_MAX_BYTES = 16000, TEAM_MAX_BYTES = 65536
export const utf8Bytes = text => new TextEncoder().encode(String(text ?? '')).length
/** A blank box means "no instruction": the key is omitted, never sent as "". */
export const promptValue = text => typeof text === 'string' && text.trim() ? text : undefined
export function withPrompt(row, key, text) {
  const next = { ...row }, value = promptValue(text)
  if (value === undefined) delete next[key]; else next[key] = value
  return next
}
export const promptTooLong = (text, max = PROMPT_MAX_BYTES) => promptValue(text) !== undefined && utf8Bytes(text) > max
export const teamBytes = spec => utf8Bytes(JSON.stringify(spec))
