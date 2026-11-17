import test from 'node:test'
import assert from 'node:assert/strict'
import {portableComposerSupport,portableDiscussionProps} from '../packages/collab/portable-composer.js'
test('stock and incompatible composer modules safely fall back',()=>{
 assert.equal(portableComposerSupport({}),null)
 assert.equal(portableComposerSupport({portableComposerCapabilities:{version:2,text:true},PortableTextComposer(){}}),null)
 const component=()=>null
 assert.equal(portableComposerSupport({portableComposerCapabilities:{version:1,text:true,attachments:false,voice:false},PortableTextComposer:component}),component)
})
test('portable adapter rejects a stale scope or text, retains durable send authority',async()=>{
 let sent=0,ready=true,error='',text='hello'
 const options={key:'host:workspace:root:surface:thread',text,pending:false,busy:false,ready,thread:'thread',draft:{current:{edit(value){text=value}}},setText(value){text=value},setError(value){error=value},setReady(value){ready=value},send:async()=>{sent++}}
 const props=portableDiscussionProps(options)
 await assert.rejects(props.onSubmit({scopeKey:'other',text:'hello'}))
 await assert.rejects(props.onSubmit({scopeKey:options.key,text:'changed'}))
 assert.equal(sent,0)
 await props.onSubmit({scopeKey:options.key,text:'hello'});assert.equal(sent,1)
 props.onChange('updated');assert.equal(text,'updated')
 options.draft.current.edit=()=>{throw Error('quota')};props.onChange('lost');assert.equal(ready,false);assert.match(error,/不能发送/);assert.equal(text,'updated')
 assert.equal(portableDiscussionProps({...options,pending:true}).editingDisabled,true)
 assert.equal(portableDiscussionProps({...options,ready:false}).disabled,true)
})
