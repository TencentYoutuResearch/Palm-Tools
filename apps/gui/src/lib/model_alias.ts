/**
 * 模型简称归一 —— TS 镜像 of `kode-core/src/model_alias.rs`。
 *
 * 两边实现必须等价,详见 `tests/model_alias_fixtures.json` 共享夹具。
 *
 * 输入示例:
 *   "Claude-Sonnet-4.6 (1M context)" → "sonnet-4.6-1m"
 *   "claude-opus-4.7-1m"             → "opus-4.7-1m"
 *   "anthropic.claude-haiku-4.5"     → "haiku-4.5"
 *   "gpt-5.3-codex"                  → "gpt-5.3-codex"
 */

export function shortModelName(raw: string): string {
  const cleaned = sanitizeModelName(raw)
  if (!cleaned || cleaned === 'auto') return cleaned

  // 1) 拆括号
  const { body, parenSuffix } = splitParen(cleaned)

  // 2) 主体小写 + 空格→dash
  const lowered = body.trim().replace(/\s+/g, '-').toLowerCase()

  // 3) 去前缀
  const stripped = lowered.replace(/^anthropic\./, '').replace(/^claude-/, '')

  // 4) 数字段合并 + 丢日期
  const parts = stripped.split('-').filter((x) => x.length > 0)
  // 4.5) claude code 用 "claude-<ver>-<tier>";统一成 "<tier>-<ver>" 再 compact
  const swapped = swapVerTierIfNeeded(parts)
  const compact = compactParts(swapped)

  // 5) 拼上括号 size 标签
  if (parenSuffix && !compact.includes(parenSuffix)) {
    return `${compact}-${parenSuffix}`
  }
  return compact
}

export function sanitizeModelName(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return ''

  const lower = s.toLowerCase()
  let cut = s.length
  for (const marker of [
    ' note:',
    '-note:',
    '\nnote:',
    '\r\nnote:',
    '\tnote:',
    ' the model was saved to user settings',
    '-the-model-was-saved-to-user-settings',
  ]) {
    const idx = lower.indexOf(marker)
    if (idx >= 0) {
      cut = Math.min(cut, idx)
    }
  }

  // 兜底:合法 model 名不含 \n / \r / \t(友好名最多用空格)。
  // 这三个字符出现一定是 codebuddy 又夹带了新的 note 形态。
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 10 || c === 13 || c === 9) {
      cut = Math.min(cut, i)
      break
    }
  }

  return s.slice(0, cut).replace(/[ -]+$/, '').trim()
}

function splitParen(s: string): { body: string; parenSuffix: string | null } {
  const lp = s.indexOf('(')
  const rp = s.lastIndexOf(')')
  if (lp >= 0 && rp > lp) {
    const body = (s.slice(0, lp) + s.slice(rp + 1)).trim()
    const inside = s.slice(lp + 1, rp)
    return { body, parenSuffix: extractSizeTag(inside) }
  }
  return { body: s, parenSuffix: null }
}

function extractSizeTag(inside: string): string | null {
  const lower = inside.toLowerCase()
  // 找 [0-9]+[mk] 子串
  const m = lower.match(/(\d+)([mk])/)
  return m ? `${m[1]}${m[2]}` : null
}

function compactParts(parts: string[]): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]

  // name 段尾巴
  let splitAt = 0
  for (let i = 0; i < parts.length; i++) {
    if (!isVersionish(parts[i])) splitAt = i + 1
    else break
  }
  if (splitAt === 0 || splitAt >= parts.length) {
    return parts.filter((p) => !isYyyymmdd(p)).join('-')
  }
  const head = parts.slice(0, splitAt).join('-')
  const verTokens: string[] = []
  const suffixTokens: string[] = []
  let inVer = true
  for (const p of parts.slice(splitAt)) {
    if (inVer && isVersionish(p)) verTokens.push(p)
    else {
      inVer = false
      suffixTokens.push(p)
    }
  }
  let out = head
  if (verTokens.length) out += '-' + verTokens.join('.')
  for (const t of suffixTokens) {
    if (!isYyyymmdd(t)) out += '-' + t
  }
  return out
}

function isVersionish(s: string): boolean {
  if (!s || isYyyymmdd(s)) return false
  return /^[\d.]+$/.test(s)
}

function isYyyymmdd(s: string): boolean {
  return s.length === 8 && /^\d{8}$/.test(s)
}

/**
 * 处理 claude code 的"ver 在前、tier 在后"格式。镜像 model_alias.rs::swap_ver_tier_if_needed。
 *   ["4.7", "opus"]            → ["opus", "4.7"]
 *   ["4.7", "opus", "1m"]      → ["opus", "4.7", "1m"]
 *   ["opus", "4.7"]            → 原样
 */
function swapVerTierIfNeeded(parts: string[]): string[] {
  if (parts.length < 2) return parts
  if (!isVersionish(parts[0])) return parts
  let nameIdx = -1
  for (let i = 1; i < parts.length; i++) {
    if (!isVersionish(parts[i])) {
      nameIdx = i
      break
    }
  }
  if (nameIdx === -1) return parts
  return [parts[nameIdx], ...parts.slice(0, nameIdx), ...parts.slice(nameIdx + 1)]
}

/**
 * 模型 → context window(token 数)。镜像 kode-core/src/context.rs。
 * 未知返回 null,UI 应显示 "—"。
 */
export function contextWindow(model: string): number | null {
  const m = (model ?? '').trim().toLowerCase()
  if (!m || m === 'auto') return null

  if (m.includes('1m')) return 1_000_000
  if (m.includes('200k')) return 200_000
  if (m.includes('128k')) return 128_000

  const after = m.replace(/^anthropic\./, '').replace(/^claude-/, '')
  if (after.startsWith('opus') || after.startsWith('sonnet') || after.startsWith('haiku')) {
    return 200_000
  }
  if (after.startsWith('gpt-5') || m.startsWith('gpt-5')) return 400_000
  if (after.startsWith('gpt-4o') || m.startsWith('gpt-4o')) return 128_000
  if (after.startsWith('gpt-4') || m.startsWith('gpt-4')) return 128_000
  if (after.startsWith('gpt-3.5') || m.startsWith('gpt-3.5')) return 16_000
  if (m.startsWith('gemini')) return 1_000_000
  if (
    m.startsWith('glm') ||
    m.startsWith('kimi') ||
    m.startsWith('minimax') ||
    m.startsWith('deepseek') ||
    m.startsWith('hy')
  )
    return 128_000

  return null
}

/** 把 backend_key 映射成展示用的 chip 文案与 CSS class。
 *  tint:用于 compact 模式 tile 背景渐变(空字符串 = 无 tint,用默认色)。 */
export function backendChip(key: string): { label: string; cls: string; tint: string } {
  const k = (key ?? '').toLowerCase()
  if (k === 'codebuddy') return { label: 'codebuddy', cls: 'chip-codebuddy', tint: '#9FE870' }
  if (k === 'claude') return { label: 'claude', cls: 'chip-claude', tint: '#D97757' }
  if (k === 'claude-internal') return { label: 'claude-int', cls: 'chip-claude', tint: '#D97757' }
  if (k.startsWith('claude-')) return { label: `claude-${k.slice('claude-'.length, 'claude-'.length + 3)}`, cls: 'chip-claude', tint: '#D97757' }
  if (k.startsWith('claude')) return { label: 'claude', cls: 'chip-claude', tint: '#D97757' }
  if (k.startsWith('codex')) return { label: k, cls: 'chip-other', tint: '#7A9DFF' }
  if (k.startsWith('gemini')) return { label: k, cls: 'chip-other', tint: '#3186FF' }
  if (k.startsWith('cursor')) return { label: k, cls: 'chip-other', tint: '#F54E00' }
  if (k.startsWith('copilot') || k.startsWith('github-copilot')) return { label: k, cls: 'chip-other', tint: '#6E40C9' }
  if (k.startsWith('kimi')) return { label: k, cls: 'chip-other', tint: '#C9C3D6' }
  if (k.startsWith('kiro')) return { label: k, cls: 'chip-other', tint: '#9046FF' }
  if (k.startsWith('amp')) return { label: k, cls: 'chip-other', tint: '#E8B168' }
  if (k.startsWith('grok')) return { label: k, cls: 'chip-other', tint: '#E8E8E8' }
  if (k.startsWith('opencode')) return { label: k, cls: 'chip-other', tint: '#B0B0B0' }
  if (k.startsWith('droid')) return { label: k, cls: 'chip-other', tint: '#C9CDD3' }
  if (k.startsWith('antigravity') || k.startsWith('agy')) return { label: k, cls: 'chip-other', tint: '#4285F4' }
  if (k.startsWith('pi')) return { label: k, cls: 'chip-other', tint: '#C2C5CE' }
  return { label: k || 'unknown', cls: 'chip-other', tint: '' }
}

/**
 * 超短模型名 —— 给 tab chip 这种宽度极度受限的场景。
 *
 * 基于 shortModelName() 的输出再做一次品牌缩写,
 * 目标 ~5-8 字符。未知模型直接退回到 shortModelName()。
 *
 * 输入示例:
 *   "claude-opus-4.7-1m"           → "Opus 4.7"
 *   "deepseek-v4-pro-ioa"         → "DS v4p"
 *   "kimi-k2.6-ioa"               → "Kimi 2.6"
 *   "hy3-preview-ioa"             → "HY 3"
 *   "gpt-5.3-codex"               → "GPT 5.3c"
 */
export function compactModelName(raw: string): string {
  const s = shortModelName(raw)
  if (!s || s === 'auto') return s

  const lower = s.toLowerCase()

  // --- Claude family ---
  if (lower.startsWith('opus')) return compactClaude('Opus', s)
  if (lower.startsWith('sonnet')) return compactClaude('Sonnet', s)
  if (lower.startsWith('haiku')) return compactClaude('Haiku', s)

  // --- GPT family ---
  if (lower.startsWith('gpt-')) {
    // gpt-5.3-codex → GPT 5.3c
    const rest = lower.slice(4) // "5.3-codex"
    const parts = rest.split('-')
    const ver = parts[0] // "5.3"
    const suffix = parts.length > 1 ? parts[parts.length - 1] : '' // "codex"
    if (suffix && suffix !== ver) {
      return `GPT ${ver}${suffix[0]}`
    }
    return `GPT ${ver}`
  }

  // --- Gemini ---
  if (lower.startsWith('gemini')) {
    // gemini-3.1-pro → Gem 3.1p
    const rest = lower.slice(7).replace(/^[-.]+/, '') // "3.1-pro"
    const parts = rest.split('-')
    const ver = parts[0] // "3.1"
    const suffix = parts.length > 1 ? parts[parts.length - 1] : '' // "pro"
    if (suffix && suffix !== ver) {
      return `Gem ${ver}${suffix[0]}`
    }
    return `Gem ${ver}`
  }

  // --- DeepSeek ---
  if (lower.startsWith('deepseek')) {
    // deepseek-v4-pro-ioa → DS v4p
    const rest = lower.slice(9).replace(/^[-.]+/, '') // "v4-pro-ioa"
    const parts = rest.split('-')
    const ver = parts[0] // "v4"
    // 第二个有意义段(跳过 ver 段)
    let tier = ''
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] && !isVersionish(parts[i])) {
        tier = parts[i]
        break
      }
    }
    if (tier) {
      return `DS ${ver}${tier[0]}`
    }
    return `DS ${ver}`
  }

  // --- Kimi ---
  if (lower.startsWith('kimi')) {
    // kimi-k2.6-ioa → Kimi 2.6
    const rest = lower.slice(5).replace(/^[-.]+/, '') // "k2.6-ioa"
    const verMatch = rest.match(/([kv]?\d[\d.]*)/)
    if (verMatch) {
      const ver = verMatch[0].replace(/^[kv]/, '') // "2.6"
      return `Kimi ${ver}`
    }
    return 'Kimi'
  }

  // --- GLM ---
  if (lower.startsWith('glm')) {
    // glm-4.7-ioa → GLM 4.7
    const rest = lower.slice(4).replace(/^[-.]+/, '')
    const verMatch = rest.match(/(\d[\d.]*)/)
    if (verMatch) {
      return `GLM ${verMatch[0]}`
    }
    return 'GLM'
  }

  // --- MiniMax ---
  if (lower.startsWith('minimax')) {
    // minimax-m2.1 → Mini 2.1
    const rest = lower.slice(8).replace(/^[-.]+/, '')
    const verMatch = rest.match(/(\d[\d.]*)/)
    if (verMatch) {
      return `Mini ${verMatch[0]}`
    }
    return 'Mini'
  }

  // --- HY (Hunyuan) ---
  if (lower.startsWith('hy')) {
    // hy3-preview-ioa → HY 3
    const rest = lower.slice(2).replace(/^[-.]+/, '') // "3-preview-ioa"
    const verMatch = rest.match(/(\d[\d.]*)/)
    if (verMatch) {
      return `HY ${verMatch[0]}`
    }
    return 'HY'
  }

  // Fallback: return shortModelName as-is
  return s
}

/**
 * 极短模型缩写(2-4 字符),给 compact 侧栏 tab tile 底部用。
 * avatar 已表达 backend,这里只取版本号这个互补维度:
 *   glm-5.2-ioa → "5.2"  claude-opus-4.7 → "4.7"  deepseek-v4-pro → "v4"
 *   gpt-5.3-codex → "5.3"  gemini-3.1-pro → "3.1"  kimi-k2.6 → "2.6"
 *   auto / 空 → "auto" / "·"
 */
export function modelAbbr(raw: string | null | undefined): string {
  if (!raw) return '·'
  const s = sanitizeModelName(raw)
  if (!s || s === 'auto') return s || 'auto'
  const lower = s.toLowerCase()

  // deepseek-v4: 保留 v 前缀(版本的一部分)
  if (lower.startsWith('deepseek')) {
    const m = lower.match(/v\d[\d.]*/)
    if (m) return m[0]
  }

  // kimi-k2.6 / kv3 → 去掉 k 前缀取版本
  if (lower.startsWith('kimi')) {
    const m = lower.match(/[kv]?(\d[\d.]*)/)
    if (m) return m[1]
  }

  // 其余:取第一个「纯数字版本段」(含小数点)
  const m = lower.match(/(\d[\d.]*)/)
  return m ? m[1] : '·'
}

/** Claude family compact: "Opus 4.7 1M" / "Opus 4.7" */
function compactClaude(tier: string, s: string): string {
  const parts = s.toLowerCase().split('-')
  // tier 已消费,后面是 ver + optional size
  let ver = ''
  let size = ''
  for (const p of parts) {
    if (!ver && isVersionish(p)) {
      ver = p
      continue
    }
    if (ver && /^\d+[mk]$/i.test(p)) {
      size = p.toUpperCase()
      break
    }
  }
  if (size) return `${tier} ${ver} ${size}`
  if (ver) return `${tier} ${ver}`
  return tier
}

/** 把 token 数压成 12k / 1.2M 形式 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}
