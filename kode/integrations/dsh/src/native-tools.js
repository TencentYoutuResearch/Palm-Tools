/** Protocol data becomes tool presentation, never a second tool execution. */
export function nativeToolDescriptor(item) {
  let input = item.input ?? item.rawInput ?? {}
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = { command: input } } }
  const command = item.command ?? input.command ?? input.cmd
  if (item.type === 'commandExecution' && typeof command === 'string') return { name: 'exec_command', args: { cmd: command, ...((item.cwd ?? input.cwd) ? { cwd: item.cwd ?? input.cwd } : {}) } }
  if (item.type === 'fileChange') {
    const paths = [...new Set([input.file_path ?? input.path, ...(item.changes ?? []).map(change => change.path)].filter(path => typeof path === 'string' && path))]
    return { name: 'apply_patch', args: { patch: (item.changes ?? []).map(change => change.diff ?? '').join('\n') || input.patch || input.content || input.new_string || '', ...(paths.length ? { path: paths[0], paths } : {}), title: item.title } }
  }
  if (item.type === 'webSearch') return { name: 'web_search', args: item }
  return { name: `kode_native_${item.type}`, args: { ...item, ...(input.file_path || input.path ? { path: input.file_path ?? input.path } : {}), ...(item.kind ? { kind: item.kind } : {}) } }
}

export function acpToolItem(old, update) {
  const kind = update.kind ?? old.kind
  const contents = update.content
  const changes = contents?.filter(c => c.type === 'diff').map(c => ({ path: c.path, diff: `--- ${c.path}\n+++ ${c.path}\n${c.oldText ?? ''}\n${c.newText ?? ''}` }))
  return { ...old, ...(kind ? { kind, type: kind === 'edit' ? 'fileChange' : 'commandExecution' } : {}),
    ...(update.title ? { title: update.title } : {}), ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
    ...(update.status ? { status: update.status } : {}), ...(changes?.length ? { changes } : {}),
    ...(contents ? { aggregatedOutput: contents.map(c => c.type === 'content' && c.content.type === 'text' ? c.content.text : c.type === 'diff' ? `${c.path}\n${c.newText ?? ''}` : c.type === 'terminal' ? '' : JSON.stringify(c)).filter(Boolean).join('\n') } : {}),
    ...(update.rawOutput !== undefined && !contents ? { aggregatedOutput: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput) } : {}),
  }
}
