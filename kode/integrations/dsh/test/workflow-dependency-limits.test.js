/** Synthetic only: no personal skill text, provider calls, or Hub writes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assignmentDependencies, dependencyInstructionMaxBytes, dependencyStageMaxBytes } from '../src/assignment-dependencies.js'
const hash = value => createHash('sha256').update(value).digest('hex')
function row(id, instructions) {
  const config = { id, version: '1', spec: { kind: 'workflow_dependency', artifact: {
    kind: 'skill', source: 'fixture://skill/' + id, source_version: '1', content_hash: hash(instructions), instructions,
    hosts: ['home'], tools: ['read_source'], capabilities: ['read'], network: false,
  } } }
  return { id, version: '1', hash: hash('kode.project.config.v1\n' + JSON.stringify(config)), config }
}
function mandate(rows) {
  const scope = { dependencies: rows.map(({ id, version, hash }) => ({ id, version, hash })), tools: ['read_source'], capabilities: ['read'], network: false }
  return { stage: { execution: scope }, worker: { node_id: 'home' }, grant_scope: structuredClone(scope), dependencies: rows }
}
test('complete UTF-8 instructions above 16KiB succeed through exact 64KiB', () => {
  const instructions = '界'.repeat(Math.floor(dependencyInstructionMaxBytes / 3)) + 'a'
  assert.equal(Buffer.byteLength(instructions), 65536)
  const input = mandate([row('full-skill', instructions)])
  assert.equal(assignmentDependencies(input)[0].content_hash, hash(instructions))
  assert.equal(input.dependencies[0].config.spec.artifact.instructions, instructions)
  assert.throws(() => assignmentDependencies(mandate([row('too-large', instructions + 'x')])), /binding mismatch/)
})
test('two complete synthetic skill bodies retain exact content and frozen hashes', () => {
  const input = mandate([row('design', 'd'.repeat(27509)), row('polish', 'p'.repeat(12541))])
  assert.equal(assignmentDependencies(input).length, 2)
  assert.equal(input.dependencies[0].config.spec.artifact.instructions.length, 27509)
  input.dependencies[0].config.spec.artifact.instructions += 'tampered'
  assert.throws(() => assignmentDependencies(input), /binding mismatch/)
})
test('96KiB bound includes full dependency row JSON, not only instruction strings', () => {
  const base = [row('one', 'x'.repeat(40000)), row('two', 'y'.repeat(40000))]
  const extra = dependencyStageMaxBytes - Buffer.byteLength(JSON.stringify(base))
  const exact = [row('one', 'x'.repeat(40000 + extra)), row('two', 'y'.repeat(40000))]
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 98304)
  assert.equal(assignmentDependencies(mandate(exact)).length, 2)
  const over = [row('one', 'x'.repeat(40001 + extra)), row('two', 'y'.repeat(40000))]
  assert.equal(Buffer.byteLength(JSON.stringify(over)), 98305)
  assert.throws(() => assignmentDependencies(mandate(over)), /binding mismatch/)
})
test('larger instructions still cannot expand Host, tools, network or dependency count', () => {
  const make = () => mandate([row('full-skill', 'x'.repeat(20000))])
  for (const mutate of [m => { m.worker.node_id = 'foreign' }, m => { m.grant_scope.tools = [] }, m => { m.grant_scope.capabilities = [] }, m => { m.dependencies[0].config.spec.artifact.network = true }]) {
    const input = make(); mutate(input); assert.throws(() => assignmentDependencies(input), /binding mismatch/)
  }
  assert.throws(() => assignmentDependencies(mandate(Array.from({ length: 9 }, (_, i) => row('skill-' + i, 'x')))), /binding mismatch/)
})
