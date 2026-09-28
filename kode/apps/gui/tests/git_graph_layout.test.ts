import assert from 'node:assert/strict'
import test from 'node:test'
import { graphContinuationPath, layoutGitGraph } from '../src/lib/git_graph_layout.ts'

test('linear history stays in one continuous lane', () => {
  const rows = layoutGitGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.deepEqual(rows.map(({ lane, width }) => [lane, width]), [[0, 1], [0, 1], [0, 1]])
  assert.deepEqual(rows[0].bottom, [0])
  assert.deepEqual(rows[2].bottom, [])
})

test('merge retains both parents and closes the secondary lane at its ancestor', () => {
  const rows = layoutGitGraph([
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'base', parents: [] },
  ])
  assert.equal(rows[0].width, 2)
  assert.deepEqual(rows[0].segments.filter((s) => s.kind === 'parent').map((s) => s.to), [0, 1])
  assert.equal(rows[1].lane, 0)
  assert.equal(rows[2].lane, 1)
  assert.deepEqual(rows[2].bottom.map((color) => color), [0])
  assert.equal(graphContinuationPath(rows[2], 0), 'M 11 26 L 11 52')
  assert.equal(rows[3].lane, 0)
})

test('independent tips do not gain invented connections', () => {
  const rows = layoutGitGraph([
    { hash: 'a', parents: ['base'] },
    { hash: 'other', parents: ['base'] },
    { hash: 'base', parents: [] },
  ])
  assert.equal(rows[1].top.includes(rows[1].color), false)
  assert.equal(rows[1].segments.some((s) => s.kind === 'through' && s.color === rows[1].color), false)
  assert.equal(rows[2].lane, 0)
})
