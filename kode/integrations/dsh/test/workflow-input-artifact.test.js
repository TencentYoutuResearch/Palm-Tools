import test from 'node:test'
import assert from 'node:assert/strict'
import { selectInputArtifact } from '../src/assignment-input-artifact.js'
test('explicit cwd selects fixed while retaining a different baseline ancestor', () => {
  const rows = [{ source_stage:'baseline', output:'base', sequence:1, artifact:{ repository_binding:'code', snapshot_hash:'a' } },
    { source_stage:'implement', output:'fixed', sequence:2, artifact:{ repository_binding:'code', snapshot_hash:'b' } }]
  const stage = {execution:{repository_binding:'code', input_artifact:{stage:'implement',output:'fixed'}}}
  assert.equal(selectInputArtifact(stage,rows,new Set(['fixed'])),rows[1])
  assert.equal(rows.length,2)
  assert.equal(selectInputArtifact({execution:{}},rows),null,'legacy ambiguity handling remains at the existing caller')
  assert.throws(()=>selectInputArtifact(stage,rows,new Set(['base'])),/judged/)
  assert.throws(()=>selectInputArtifact(stage,rows.slice(0,1)),/frozen/)
  assert.throws(()=>selectInputArtifact({...stage,execution:{...stage.execution,input_artifact:{stage:'baseline',output:'base'}}},rows,new Set(['fixed'])),/judged/)
})
test('own entry lists do not confuse legal constructor identities with inherited properties', () => {
  const sources=JSON.parse('{"constructor":{"outputs":{"constructor":{"sequence":1,"artifact":{"repository_binding":"code"}}}}}')
  const rows=Object.entries(sources).flatMap(([source_stage,source])=>Object.entries(source.outputs).map(([output,value])=>({source_stage,output,...value})))
  assert.equal(selectInputArtifact({execution:{repository_binding:'code',input_artifact:{stage:'constructor',output:'constructor'}}},rows).sequence,1)
  assert.throws(()=>selectInputArtifact({execution:{repository_binding:'code',input_artifact:{stage:'toString',output:'constructor'}}},rows),/frozen/)
})

test('mapping identities match Home valid_id including colon and leading punctuation', () => {
  for (const name of ['stage:one','_baseline','.snapshot','-prior','constructor','toString']) {
    const sources=JSON.parse(JSON.stringify({[name]:{outputs:{[name]:{sequence:1,artifact:{repository_binding:'code'}}}}}))
    const rows=Object.entries(sources).flatMap(([source_stage,source])=>Object.entries(source.outputs).map(([output,value])=>({...value,source_stage,output})))
    assert.equal(selectInputArtifact({execution:{repository_binding:'code',input_artifact:{stage:name,output:name}}},rows).sequence,1)
  }
  for (const bad of ['', 'a'.repeat(161), 'space id', '注入', 'a/b']) {
    assert.throws(()=>selectInputArtifact({execution:{input_artifact:{stage:bad,output:'ok'}}},[]),/Invalid/)
  }
  assert.throws(()=>selectInputArtifact({execution:{input_artifact:{stage:'ok',output:'ok',extra:true}}},[]),/Invalid/)
})
