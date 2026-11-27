/** Resolve defaults on the executing Host; never use a GUI launcher as a CLI. */
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, resolve, sep, extname } from 'node:path'
import { AGENT_TYPES } from './agent-profiles.js'

export async function findExecutable(command, path = process.env.PATH ?? '', cwd = process.cwd()) {
  if (!command) return
  const explicitPath = command.includes('/') || command.includes(sep)
  const directories = explicitPath ? [''] : path.split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' && !extname(command) ? ['.exe', '.com'] : ['']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(cwd, directory, command + suffix)
      try {
        await access(candidate, constants.X_OK)
        if ((await stat(candidate)).isFile()) return candidate
      } catch { /* try the next candidate */ }
    }
  }
}
export async function agentDefaults(path = process.env.PATH ?? '') {
  const types = structuredClone(AGENT_TYPES)
  for (const [type, commands] of Object.entries({ codex: ['codex'], claude: ['claude'], codebuddy:['codebuddy'], cursor: ['agent', 'cursor-agent'], antigravity: ['agy'] })) {
    let resolved
    for (const command of commands) { resolved = await findExecutable(command, path); if (resolved) break }
    types[type] = { ...types[type], executable: resolved ?? commands[0], available: Boolean(resolved) }
  }
  return types
}
export const builtinProfiles = types => ['dsh', 'codex', 'cursor', 'claude', 'codebuddy', 'antigravity'].map(type => ({ id: `builtin-${type}`, name: types[type].name, type, ...(type === 'dsh' ? {} : { executable: types[type].executable, args: [], env: {} }) }))
