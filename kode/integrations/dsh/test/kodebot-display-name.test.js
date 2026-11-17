import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { BUILDER_PROMPT } from '../src/builder-prompt.js'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
test('Team Builder is the temporary public name without changing stable builder identity', () => {
  for (const file of readdirSync(new URL('../packages/collab/', import.meta.url))) {
    if (!file.endsWith('.js') || file === 'client.js') continue
    assert.doesNotMatch(read('../packages/collab/' + file), /团队搭建助手|创建助手|搭建助手|KodeBot/, file)
  }
  const view = read('../packages/collab/builder-view.js')
  assert.match(view, /'aria-label': 'Team Builder'/)
  // Heading shows the draft title once one exists; the public name is the fallback.
  assert.match(view, /draft \? builderDraftTitle\(draft\.interview\.purpose\) : 'Team Builder'/)
  assert.match(read('../packages/collab/client-source.js'), /label:'私信 Team Builder'/)
  const conversation = read('../packages/collab/builder-conversation-view.js')
  assert.match(conversation, /给 Team Builder 的消息/)
  assert.match(conversation, /row.role === 'user' \? '你' : 'Team Builder'/)
  assert.match(read('../packages/collab/member-invite-ui.js'), /打开 Team Builder/)
  assert.match(read('../packages/collab/discussion-ui.js'), /打开 Team Builder/)
  assert.match(read('../packages/collab/client-source.js'), /view.selectSuperagent\('kode-builtin-builder'/)
  assert.match(view, /\/api\/kode\/builder\/drafts/)
  assert.match(BUILDER_PROMPT, /You are KodeBot, the creation assistant/)
})
