import { createHash } from 'node:crypto'
import path from 'node:path'

import type { RegistryEntry } from './commands.js'
import type { GraphEdge, GraphNode } from './assurance.js'
import { exists, pathInside, readText } from '../store/workspace.js'

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha1').update(value).digest('hex').slice(0, 16)}`
}

export async function structuredSpecNodes(workspace: string, documents: RegistryEntry[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const document of documents) {
    const file = pathInside(workspace, document.path)
    if (!await exists(file) || !document.path.endsWith('.md')) continue
    let content: string
    try { content = await readText(file) } catch { continue }
    let heading = 'Overview'
    for (const line of content.split(/\r?\n/)) {
      const headingMatch = /^#{1,4}\s+(.+)$/.exec(line)
      if (headingMatch !== null) { heading = headingMatch[1]!.trim(); continue }
      const bullet = /^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line)?.[1]?.trim()
      if (bullet === undefined || bullet.length < 4) continue
      const text = `${heading} ${bullet}`.toLowerCase()
      const kind: GraphNode['kind'] = /api|endpoint|request|response|接口/.test(text) ? 'api'
        : /click|select|submit|enter|action|点击|选择|提交|输入/.test(text) ? 'action'
          : /screen|page|dialog|view|页面|弹窗|视图/.test(text) ? 'screen'
            : /state|status|loading|error|状态|失败|加载/.test(text) ? 'state'
              : /test|verify|assert|测试|验证|验收/.test(text) ? 'verification' : 'requirement'
      const id = stableId(document.id, `${heading}\n${bullet}`)
      nodes.push({ id, kind, label: bullet.slice(0, 160), status: document.status, path: document.path, parent_id: document.id })
      edges.push({ from: document.id, to: id, relation: 'contains' })
    }
  }
  return { nodes, edges }
}

export async function productAdapterNodes(workspace: string, files: string[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const file of files) {
    let content: string
    try { content = await readText(pathInside(workspace, file)) } catch { continue }
    const definitions: Array<{ kind: GraphNode['kind']; pattern: RegExp; label: (match: RegExpExecArray) => string }> = [
      { kind: 'action', pattern: /(?:on:click|onclick|onClick)\s*=\s*[{"']?([A-Za-z_$][\w$]*)/g, label: (m) => `click:${m[1]}` },
      { kind: 'api', pattern: /#\[(?:tauri::)?command\][\s\S]{0,120}?fn\s+([A-Za-z_][\w]*)/g, label: (m) => `tauri:${m[1]}` },
      { kind: 'api', pattern: /(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"]([^'"]+)/g, label: (m) => `http:${m[1]}` },
      { kind: 'screen', pattern: /class\s+([A-Za-z_]\w*(?:Screen|Page|View))\b/g, label: (m) => m[1]! },
      { kind: 'test', pattern: /(?:test|it)\(\s*['"]([^'"]+)/g, label: (m) => `test:${m[1]}` },
    ]
    for (const definition of definitions) {
      for (const match of content.matchAll(definition.pattern)) {
        const label = definition.label(match)
        const id = stableId('product', `${file}:${definition.kind}:${label}`)
        nodes.push({ id, kind: definition.kind, label, status: 'present', path: file, parent_id: `file:${file}`, adapter: path.extname(file).slice(1) })
        edges.push({ from: `file:${file}`, to: id, relation: 'contains' })
      }
    }
  }
  return { nodes, edges }
}
