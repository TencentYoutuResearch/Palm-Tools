/** Run all integration contracts against the packages carried by a Desktop release. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
if (!process.argv[2]) throw new Error('Usage: npm run test:desktop-runtime -- /path/to/extracted-desktop/dsh')
const runtime = resolve(process.argv[2])
await access(join(runtime, 'node_modules/@deepseek-ai/dsh-session/package.json'))
const child = spawn(process.execPath, [fileURLToPath(new URL('test-integration.js', import.meta.url))], { stdio: 'inherit', env: { ...process.env, KODE_DSH_COMPAT_RUNTIME: runtime } })
child.on('error', error => { throw error })
const [code] = await once(child, 'exit')
process.exitCode = code ?? 1
