import test from 'node:test'
import assert from 'node:assert/strict'
import {messagePreview} from '../packages/collab/message-preview.js'

test('compact DM is an explicit source excerpt, never an inferred result',()=>{
 const content='revision 13 · completion_authorized=false\n\n'+('原始证据。\n'.repeat(120))
 const preview=messagePreview(content,'superagent')
 assert.equal(preview.excerpt,'revision 13 · completion_authorized=false')
 assert.equal(preview.length,content.length)
 assert.equal(content.includes('completion_authorized=false'),true)
 assert.equal(messagePreview(content,'human'),null)
 assert.equal(messagePreview('短回复。','superagent'),null)
})
test('long first paragraphs and multiline replies have bounded previews with complete source untouched',()=>{
 const content='长'.repeat(700),copy=content
 assert.equal(messagePreview(content,'system').excerpt,'长'.repeat(280)+'…')
 assert.equal(content,copy)
 assert.ok(messagePreview('一\n'.repeat(10),'superagent'))
})
