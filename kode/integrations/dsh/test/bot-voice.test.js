import test from 'node:test'
import assert from 'node:assert/strict'
import { BotVoiceStore, DEFAULT_TONE, TONE_PRESETS, normalizeTone, tonePrompt } from '../src/bot-voice.js'

test('tone presets and tonePrompt produce natural anti-robotic instructions', () => {
  assert.ok(TONE_PRESETS.length >= 6)
  assert.deepEqual(normalizeTone('unknown-tone', '  叫我老王  '), { tone: DEFAULT_TONE, tone_note: '叫我老王' })
  assert.deepEqual(normalizeTone('humorous', '少用感叹号'), { tone: 'humorous', tone_note: '少用感叹号' })

  const prompt = tonePrompt('humorous', '叫我老王，别用感叹号')
  assert.match(prompt, /轻松风趣/)
  assert.match(prompt, /去人机味底线/)
  assert.match(prompt, /严禁使用典型 AI 客服套话/)
  assert.match(prompt, /叫我老王，别用感叹号/)
})

test('BotVoiceStore persists per-bot tone in workbench documents with CAS retry and cleanup', async () => {
  let doc = null
  let revision = 0
  let conflictOnce = true
  const backend = {
    call: async (path, body) => {
      assert.equal(path, '/api/v1/messaging/workbench/documents/bot-voice')
      if (!body) return doc ? { revision, value: doc } : { revision: 0, value: null }
      if (conflictOnce) {
        conflictOnce = false
        const err = new Error('conflict')
        err.status = 409
        throw err
      }
      revision += 1
      doc = body.value
      return { revision, value: doc }
    },
  }
  const store = new BotVoiceStore(backend)
  assert.deepEqual(await store.get('b1'), { tone: DEFAULT_TONE, tone_note: '' })

  const saved = await store.set('b1', { tone: 'direct', tone_note: '直接给结论' })
  assert.deepEqual(saved, { tone: 'direct', tone_note: '直接给结论' })
  assert.deepEqual(await store.get('b1'), { tone: 'direct', tone_note: '直接给结论' })

  await store.remove('b1')
  assert.deepEqual(await store.get('b1'), { tone: DEFAULT_TONE, tone_note: '' })
})
