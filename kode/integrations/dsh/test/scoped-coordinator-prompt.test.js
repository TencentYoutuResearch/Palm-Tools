import test from 'node:test'
import assert from 'node:assert/strict'
import {publicTextHash,validatePublicManifest} from '../src/scoped-coordinator-prompt.js'
const key='a'.repeat(64)
const entry=text=>({text,sha256:publicTextHash(text)})
test('public manifest canonical hash is property-order independent and literal knowledge is immutable',()=>{
 const a={version:1,context_key:key,procedure:entry('{{literal_not_parent_variable}}'),shared:[],tools:[]}
 const b={tools:[],shared:[],procedure:{sha256:a.procedure.sha256,text:a.procedure.text},context_key:key,version:1}
 assert.equal(validatePublicManifest(a,key).hash,validatePublicManifest(b,key).hash)
 assert.ok(Object.isFrozen(validatePublicManifest(a,key).manifest.procedure))
 assert.throws(()=>validatePublicManifest({...a,authority:'user supplied'},key))
})
