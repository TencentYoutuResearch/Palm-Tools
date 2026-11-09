/** Migrate a previously cached generic Electron runtime at the next shell start.
 * Only the matching, sealed development copy is eligible; never mutate a running bundle. */
import { readdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const bundleIdentifier = app => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
export function findDevelopmentRuntime(executable, io = {}) {
  const readDirectory = io.readDirectory ?? readdirSync, realpath = io.realpath ?? realpathSync
  const identifier = io.identifier ?? bundleIdentifier
  const verify = io.verify ?? (app => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore', timeout: 10000 }))
  const marker = '/native-notifications/', index = executable.indexOf(marker)
  if (index < 0 || !executable.endsWith('/Electron.app/Contents/MacOS/Electron')) return null
  const cache = executable.slice(0, index + marker.length - 1)
  try {
    const currentApp = dirname(dirname(dirname(executable)))
    if (identifier(currentApp) !== 'com.github.Electron') return null
    const current = realpath(executable)
    for (const name of readDirectory(cache)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      try {
        const legacy = join(cache, name, 'Electron.app/Contents/MacOS/Electron')
        if (realpath(legacy) !== current) continue
        const target = join(cache, `dsh-development-v2-${name}`, 'Electron.app')
        if (identifier(target) !== 'com.deepseek.dsh.development') continue
        verify(target)
        return join(target, 'Contents/MacOS/Electron')
      } catch { /* An absent, incomplete or unsealed copy is never launched. */ }
    }
  } catch { /* Other installations keep their existing launch behavior. */ }
  return null
}
