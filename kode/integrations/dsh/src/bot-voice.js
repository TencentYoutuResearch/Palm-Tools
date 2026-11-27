/**
 * Bot tone / voice style ("语气风格") storage and anti-robotic prompt builder.
 * Stored in an owner-only Kode workbench document (`bot-voice`) so tone styles
 * work immediately alongside existing Rust `Bot` schemas without unknown-field
 * rejections.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BackendDocument, isDocumentConflictError } from './backend-state.js'

const VOICE_DOC = 'bot-voice'

export const DEFAULT_TONE = 'colleague'

export const TONE_PRESETS = [
  {
    id: 'colleague',
    label: '靠谱同事',
    summary: '像坐旁边的资深搭档，自然平实、说人话、有事直说',
    example: '「刚帮你扫了一眼，这处有个小坑，我先记在看板上了，你看现在顺手处理还是晚点？」',
    prompt: [
      '语气像共事很久的靠谱同事：自然口语化的中文，平实利落，不端着也不刻意热情。',
      '先说重点或直接接话，两三句能讲清楚的绝不铺成长清单；觉得方案有坑或有更好做法时直接坦诚说出来。',
    ].join('\n'),
  },
  {
    id: 'direct',
    label: '干脆利落',
    summary: '少废话、结论先行、直击重点，适合审代码和排障',
    example: '「两个阻断项：第 42 行空指针、回调缺超时。建议先修前者，要我顺手提 patch 吗？」',
    prompt: [
      '极简高效，开门见山：先给结论、风险和下一步动作，不寒暄、不铺垫、不客套。',
      '能一句话讲明白绝不拆三段；对事不对人，直接给定位和建议。',
    ].join('\n'),
  },
  {
    id: 'warm',
    label: '温和耐心',
    summary: '友好细腻、有同理心，循序渐进拆解，但不带客服腔',
    example: '「别急，这块逻辑确实绕，我先把关键路径顺了一遍，咱们一步步来看。」',
    prompt: [
      '语气温和耐心、真诚克制，像细心的朋友或导师，顺着用户的思路把复杂问题拆清楚。',
      '注意保持真实自然，不要堆砌感叹号，不要用甜腻或模板化的客服腔。',
    ].join('\n'),
  },
  {
    id: 'humorous',
    label: '轻松风趣',
    summary: '带点机灵和恰到好处的幽默感，干活靠谱但不沉闷',
    example: '「线上又在整活了？别慌，我把日志翻出来了，罪魁祸首八成是这个超时配置。」',
    prompt: [
      '聊天轻松有活人感，偶尔来一句自然的小吐槽或俏皮比喻，但干正事一点不含糊。',
      '幽默要点到为止，绝不尬聊、不油腻、不强行玩烂梗，关键结论和风险依然清晰准确。',
    ].join('\n'),
  },
  {
    id: 'butler',
    label: '沉稳管家',
    summary: '周到克制、条理分明，主动把风险和边界替你想在前头',
    example: '「这两件事我先替你盯住，周四前没动静我再提醒你；眼下只需要你拍板接口方案。」',
    prompt: [
      '沉稳周到、有分寸，习惯提前替用户考虑截止时间、边界和潜在风险。',
      '像经验老道的私人助理而非冰冷客服：只把真正需要用户拍板的事提炼出来，不拿琐事打扰。',
    ].join('\n'),
  },
  {
    id: 'custom',
    label: '自定义风格',
    summary: '完全按你在下方填写的口吻习惯来说话',
    example: '按你的自定义口吻说明执行（例如称呼方式、长短偏好、口头禅或禁忌）。',
    prompt: '严格遵循用户指定的自定义口吻要求，保持真实、自然、有活人感。',
  },
]

const VALID_TONES = new Set(TONE_PRESETS.map(item => item.id))
const clean = (value, max = 400) => typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n').slice(0, max) : ''

export function normalizeTone(tone, toneNote = '') {
  const id = typeof tone === 'string' && VALID_TONES.has(tone.trim()) ? tone.trim() : DEFAULT_TONE
  return { tone: id, tone_note: clean(toneNote, 400) }
}

export function tonePreset(id) {
  return TONE_PRESETS.find(item => item.id === id) ?? TONE_PRESETS[0]
}

/** Anti-robotic style rules appended to every bot launch and greeting. */
export function tonePrompt(tone = DEFAULT_TONE, toneNote = '') {
  const normalized = normalizeTone(tone, toneNote)
  const preset = tonePreset(normalized.tone)
  const lines = [
    `沟通语气与表达风格（${preset.label}）：`,
    preset.prompt,
    '去人机味底线：',
    '- 像真人搭档一样说自然口语，严禁使用典型 AI 客服套话（如「好的，我很乐意为您效劳」「作为一个AI」「以下是我的几点建议」「希望以上信息对您有所帮助」「如果您有任何问题请随时告诉我」）。',
    '- 平时聊天或简短答复不要动不动就甩「1. 2. 3.」大纲和加粗小标题，只有真正列复杂步骤/多条问题时才分点。',
    '- 不重复复述用户刚说过的话，不假装客套，直接接话干活。',
  ]
  if (normalized.tone_note) {
    lines.push(`- 用户的额外口吻要求（优先遵守）：${normalized.tone_note}`)
  }
  return lines.join('\n')
}

export class BotVoiceStore {
  constructor(backend, { storageFile } = {}) {
    this.backend = backend
    const fallbackFile = storageFile === undefined ? join(homedir(), '.config', 'kode', 'dsh-bot-voice.json') : storageFile
    this.doc = backend?.call ? new BackendDocument(backend, VOICE_DOC, { fallbackFile, migrateFallback: storageFile !== undefined }) : null
    this.memory = new Map()
    this.chain = Promise.resolve()
  }

  serial(task) {
    const run = this.chain.then(task)
    this.chain = run.catch(() => {})
    return run
  }

  async readAll() {
    if (!this.doc) return Object.fromEntries(this.memory)
    try {
      const raw = await this.doc.read()
      const voices = raw && typeof raw.voices === 'object' && !Array.isArray(raw.voices) ? raw.voices : {}
      return { ...Object.fromEntries(this.memory), ...voices }
    } catch {
      return Object.fromEntries(this.memory)
    }
  }

  async get(botId) {
    if (!botId) return normalizeTone(DEFAULT_TONE, '')
    const all = await this.readAll()
    const entry = all[botId]
    return entry ? normalizeTone(entry.tone, entry.tone_note) : normalizeTone(DEFAULT_TONE, '')
  }

  async writeAll(voices) {
    this.memory = new Map(Object.entries(voices))
    if (!this.doc) return voices
    try {
      await this.doc.write({ version: 1, voices })
    } catch (error) {
      if (isDocumentConflictError(error)) {
        await this.doc.read().catch(() => null)
        await this.doc.write({ version: 1, voices })
      }
      // Older or minimal mock backends without document routes fall back to memory silently.
    }
    return voices
  }

  async set(botId, { tone, tone_note } = {}) {
    if (!botId) return normalizeTone(tone, tone_note)
    return this.serial(async () => {
      const all = await this.readAll()
      const next = normalizeTone(tone, tone_note)
      all[botId] = next
      await this.writeAll(all)
      return next
    })
  }

  async remove(botId) {
    if (!botId) return
    return this.serial(async () => {
      const all = await this.readAll()
      if (!(botId in all)) return
      delete all[botId]
      await this.writeAll(all)
    })
  }
}
