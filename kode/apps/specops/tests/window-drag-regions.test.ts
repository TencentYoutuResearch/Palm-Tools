import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

const frontend = path.resolve(import.meta.dirname, '../frontend/src/components')

describe('SpecOps window drag regions', () => {
  test.each([
    ['chat right panel', 'chat/ProgressPanel.svelte', 'class="col-title" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}'],
    ['iwiki right panel', 'iwiki/HistoryPanel.svelte', 'class="history-head" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}'],
    ['chat left panel', 'chat/SessionList.svelte', 'class="list-head" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}'],
    ['iwiki left panel', 'iwiki/DocTree.svelte', 'class="tree-header" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}'],
  ])('%s header remains draggable when the panel is open', async (_label, relative, marker) => {
    const source = await readFile(path.join(frontend, relative), 'utf8')
    expect(source).toContain("import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';")
    expect(source).toContain(marker)
  })
})
