/** Presentation only. Never infer permission or execute the displayed data. */
const LIMIT = 6000
const secretKey = /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i
function text(value) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;]+)/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
}
function clean(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') { const safe = text(value); return safe.length > 2000 ? safe.slice(0, 2000) + '[TRUNCATED]' : safe }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return [...value.slice(0, 20).map(v => clean(v, depth + 1)), ...(value.length > 20 ? ['[TRUNCATED]'] : [])]
  if (value && typeof value === 'object') { const entries = Object.entries(value); return Object.fromEntries([...entries.slice(0, 30).map(([k, v]) => [text(k).slice(0, 120), secretKey.test(k) ? '[REDACTED]' : clean(v, depth + 1)]), ...(entries.length > 30 ? [['[TRUNCATED]', true]] : [])]) }
  return '[unavailable]'
}
export function acpApprovalDetails(call, prior) {
  const title = call.title ?? prior?.title
  const kind = call.kind ?? prior?.kind
  const input = call.rawInput !== undefined ? call.rawInput : prior?.input
  const locations = call.locations
  const lines = ['ACP 工具审批', `工具：${typeof title === 'string' && title.trim() ? text(title) : '未知（Agent 未提供工具标题）'}`]
  if (kind) lines.push(`类型：${text(String(kind))}`)
  const known = input !== undefined && input !== null && !(typeof input === 'object' && Object.keys(input).length === 0)
  lines.push(known ? `参数${call.rawInput === undefined ? '（同一调用已报告）' : ''}：\n${JSON.stringify(clean(input), null, 2)}` : '参数：未知（Agent 未提供，不能据此判断操作范围）')
  if (locations?.length) lines.push(`路径：\n${JSON.stringify(clean(locations), null, 2)}`)
  const result = lines.join('\n')
  return result.length > LIMIT ? result.slice(0, LIMIT) + '\n[详情已截断，不能视为完整操作范围]' : result
}
