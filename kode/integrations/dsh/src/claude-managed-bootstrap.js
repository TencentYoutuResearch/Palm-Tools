/** Pin the owner's native engine after wrapper authentication, without user settings. */
import { access, writeFile, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
export async function prepareClaudeBootstrap(directory, bootstrap, args, base) {
  await access(bootstrap.executable, constants.X_OK)
  const manifest = join(directory, 'bootstrap.json'), launcher = join(directory, 'bootstrap'), report = join(directory, 'transport.json')
  await writeFile(manifest, JSON.stringify({ executable: bootstrap.executable, directory, args, base, report }), { mode: 0o600 })
  await writeFile(launcher, '#!/bin/sh\nexec ' + [process.execPath, fileURLToPath(import.meta.url), manifest].map(quote).join(' ') + ' "$@"\n', { mode: 0o700 })
  return { env: { [bootstrap.pathVariable]: launcher }, report }
}
export function claudeWrapperEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Claude wrapper must expose a loopback gateway origin')
  return url.href
}
async function main() {
  try {
    const m = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const wrapperEnv = { ...process.env }
    const args = process.argv.slice(3)
    for (let i = 0; i < args.length; i++) {
      const value = args[i] === '--settings' ? args[++i] : args[i].startsWith('--settings=') ? args[i].slice(11) : null
      if (!value) continue
      const settings = JSON.parse(value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'))
      for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (typeof settings.env?.[key] === 'string') wrapperEnv[key] = settings.env[key]
    }
    const endpoint = claudeWrapperEndpoint(wrapperEnv.ANTHROPIC_BASE_URL)
    await writeFile(m.report, JSON.stringify({ endpoint }), { mode: 0o600 })
    const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: m.directory,
      CLAUDE_CONFIG_DIR: m.directory, XDG_CONFIG_HOME: m.directory,
      ANTHROPIC_BASE_URL: m.base, ANTHROPIC_AUTH_TOKEN: wrapperEnv.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY: wrapperEnv.ANTHROPIC_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' }
    const child = spawn(m.executable, m.args, { env, stdio: 'inherit', shell: false })
    return await new Promise(resolve => { child.once('exit', code => resolve(code ?? 1)); child.once('error', () => resolve(1)) })
  } catch { process.stderr.write('Managed Claude bootstrap failed\n'); return 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main())
