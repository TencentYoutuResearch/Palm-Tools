import { describe, expect, test } from 'vitest'

import { orderTaskDag } from '../src/domain/run.js'

describe('task DAG', () => {
  test('orders dependencies before consumers', () => {
    const ordered = orderTaskDag([
      { id: 'verify-ui', title: 'Verify UI', prompt: 'verify', verify: [], depends_on: ['build-api'] },
      { id: 'build-api', title: 'Build API', prompt: 'build', verify: [] },
    ])
    expect(ordered.map((item) => item.id)).toEqual(['build-api', 'verify-ui'])
  })

  test('rejects cycles and unknown dependencies', () => {
    expect(() => orderTaskDag([{ id: 'a', title: 'A', prompt: 'a', verify: [], depends_on: ['missing'] }])).toThrow('unknown task')
    expect(() => orderTaskDag([
      { id: 'a', title: 'A', prompt: 'a', verify: [], depends_on: ['b'] },
      { id: 'b', title: 'B', prompt: 'b', verify: [], depends_on: ['a'] },
    ])).toThrow('cycle')
  })
})
