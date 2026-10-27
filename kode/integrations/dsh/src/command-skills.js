/** Match advertised commands against installed skill manifests, never a name-only guess. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

export async function classifyCommands(commands, profile, cwd, { home = homedir() } = {}) {
  if (!['claude', 'codebuddy'].includes(profile.type)) return commands.map(command => ({ ...command, kind: command._meta?.type === 'skill' || command._meta?.jetbrains?.air?.kind === 'skill' ? 'skill' : 'command' }))
  const roots = [join(cwd, '.agents'), join(cwd, '.claude'), join(cwd, '.codebuddy'), ...['.claude', '.tclaude', '.codebuddy'].map(name => join(home, name)), ...['CLAUDE_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR'].flatMap(key => profile.env?.[key] ? [profile.env[key]] : [])]
  const known = new Set(); let scanned = 0
  const scan = async (root, depth, scope) => {
    if (depth < 0 || scanned++ > 3000) return
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
    if (entries.some(entry => entry.name === 'SKILL.md')) {
      let text = ''
      try { const file = join(root, 'SKILL.md'); if ((await stat(file)).size <= 1024 * 1024) text = await readFile(file, 'utf8') } catch { return }
      const name = /^name:\s*["']?([^\r\n"']+)/m.exec(text.split('---')[1] ?? '')?.[1]?.trim() || basename(root)
      known.add(name); if (scope) known.add(`${scope}:${name}`)
      return
    }
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || ['node_modules', '.git', 'target', '__pycache__'].includes(entry.name)) continue
      const nextScope = entry.name === 'skills' ? basename(root).replace(/@.*/, '') : scope
      await scan(join(root, entry.name), depth - 1, nextScope)
    }
  }
  for (const root of [...new Set(roots)]) {
    await scan(join(root, 'skills'), 2)
    // CLI plugin caches are marketplace/plugin/version/skills. Reading only
    // these bounded trees also covers package-defined skill namespaces.
    await scan(join(root, 'plugins', 'cache'), 6)
    await scan(join(root, 'plugins', 'marketplaces'), 6)
  }
  return commands.map(command => ({ ...command, kind: command._meta?.type === 'skill' || command._meta?.jetbrains?.air?.kind === 'skill' || known.has(command.name) || (command.name.includes(':') && !command.name.startsWith('mcp:') && known.has(command.name.split(':').at(-1))) ? 'skill' : 'command' }))
}
