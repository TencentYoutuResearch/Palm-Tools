import { describe, expect, test } from 'vitest'

import { buildLaunchTasks, checklistProgress } from '../frontend/src/lib/launch-tasks.js'

describe('launch task parsing', () => {
  test('uses only top-level checklist items and keeps nested bullets as task detail', () => {
    const tasks = buildLaunchTasks([
      '# Tasks',
      '- [ ] **T1 工程初始化与验证基线**',
      '  - 初始化 Vite + React + TypeScript。',
      '  - 验证：lint、test、build。',
      '- [ ] **T2 实现统一计分模块 `typingMetrics`**',
      '  - 添加公式和边界测试。',
    ].join('\n'), 'Typing game', '.specops/changes/typing-game')

    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => task.id)).toEqual(['task-1', 'task-2'])
    expect(tasks[0]?.title).toContain('T1 工程初始化')
    expect(tasks[1]?.title).toContain('T2 实现统一计分模块 typingMetrics')
  })

  test('falls back to one implementation task when no checklist exists', () => {
    const tasks = buildLaunchTasks('- Scope detail only', 'Typing game', '.specops/changes/typing-game')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('Implement Typing game')
  })

  test('launches only unchecked tasks and reports partial progress', () => {
    const markdown = [
      '# Tasks',
      '- [x] T1 Build the application shell',
      '  - completed detail must not count as a task',
      '- [X] T2 Add the typing engine',
      '- [ ] T3 Complete browser acceptance',
      '- [ ] T4 Record delivery evidence',
    ].join('\n')

    const tasks = buildLaunchTasks(markdown, 'Typing game', '.specops/changes/typing-game')
    expect(tasks.map((task) => task.title)).toEqual([
      'T3 Complete browser acceptance',
      'T4 Record delivery evidence',
    ])
    expect(checklistProgress(markdown)).toEqual({ total: 4, completed: 2, remaining: 2 })
  })

  test('does not create a fallback task when every checklist item is complete', () => {
    const markdown = '- [x] T1 Build the application shell\n- [x] T2 Verify delivery\n'
    expect(buildLaunchTasks(markdown, 'Typing game', '.specops/changes/typing-game')).toEqual([])
    expect(checklistProgress(markdown)).toEqual({ total: 2, completed: 2, remaining: 0 })
  })
})
