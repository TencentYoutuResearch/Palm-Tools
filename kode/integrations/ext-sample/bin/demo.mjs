#!/usr/bin/env node
/**
 * End-to-end check of kode.api/v1 against a running Kode: create a session
 * with an initial prompt and wait for its turn to complete, using only pushed
 * events. Development only: it mints the sample's grant with the local admin
 * connection, exactly as Kode does when it starts the extension.
 *
 *   node bin/demo.mjs <backend_key> <cwd> "<prompt>"
 *
 * It starts a real CLI session in Kode; close the tab afterwards.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KodeExtension } from '../../../packages/extension-sdk/src/index.js'

const [backendKey, cwd, prompt] = process.argv.slice(2)
if (!backendKey || !cwd || !prompt) {
  console.error('usage: node bin/demo.mjs <backend_key> <cwd> "<prompt>"')
  process.exit(2)
}
const connectionPath = process.env.KODE_WORKBENCH_CONNECTION
  ?? (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/kode/workbench-connection.json') : join(homedir(), '.config/kode/workbench-connection.json'))
const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
const admin = (await readFile(connection.token_file, 'utf8')).trim()
const origin = connection.url.replace(/\/+$/, '')
const granted = await fetch(`${origin}/api/v1/messaging/extensions/grants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
  body: JSON.stringify({ extension_id: 'kode.sample', capabilities: ['sessions.create', 'sessions.input', 'events.subscribe'] }),
})
if (!granted.ok) throw new Error(`grant failed (${granted.status}): ${await granted.text()}; is this Kode build new enough?`)
const kode = new KodeExtension({ api: `${origin}/api/ext/v1`, token: (await granted.json()).token })

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000)
const { event_cursor: after } = await kode.hello()
const events = kode.events({ after, signal: controller.signal })
const { session } = await kode.createSession({ backendKey, cwd, initialInput: prompt, labels: ['sample:demo'] })
console.log(`created session ${session.id} (${session.backend_key}); waiting for its turn…`)
for await (const event of events) {
  if (event.session_id !== session.id) continue
  console.log(`${event.kind}`, JSON.stringify(event.payload).slice(0, 200))
  if (event.kind === 'session.input_result' && event.payload.status !== 'delivered') break
  if (event.kind === 'session.turn_completed' || event.kind === 'session.exited') break
}
clearTimeout(timeout)
controller.abort()
