/** Resolve defaults on the executing Host; never use a GUI launcher as a CLI. */
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, isAbsolute } from 'node:path'
import { AGENT_TYPES } from './agent-profiles.js'

export async function findExecutable(command, path = process.env.PATH ?? '') {
  const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map(directory => join(directory, command))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate } catch { /* keep searching PATH */ }
  }
}
export async function agentDefaults(path = process.env.PATH ?? '') {
  const types = structuredClone(AGENT_TYPES)
  for (const [type, commands] of Object.entries({ codex: ['codex'], claude: ['claude'], cursor: ['agent', 'cursor-agent'] })) {
    let resolved
    for (const command of commands) { resolved = await findExecutable(command, path); if (resolved) break }
    types[type] = { ...types[type], executable: resolved ?? commands[0], available: Boolean(resolved) }
  }
  return types
}
export const builtinProfiles = types => ['dsh', 'codex', 'cursor', 'claude'].map(type => ({ id: `builtin-${type}`, name: types[type].name, type, ...(type === 'dsh' ? {} : { executable: types[type].executable, args: [], env: {} }) }))
