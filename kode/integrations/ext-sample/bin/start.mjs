#!/usr/bin/env node
/**
 * Sample extension backend. Kode starts it with KODE_EXT_API / KODE_EXT_TOKEN
 * because the manifest asks for API capabilities; it never sees the admin
 * token. It serves a read-only status page and logs every pushed event of the
 * sessions it owns (Settings → Extensions → logs).
 */
import { createServer } from 'node:http'
import { KodeExtension } from '../../../packages/extension-sdk/src/index.js'

const log = (...parts) => console.error('[kode.sample]', ...parts)
const kode = new KodeExtension()
const hello = await kode.hello()
log('connected', JSON.stringify({ api: hello.api_version, capabilities: hello.capabilities, gui: hello.runtimes.gui }))

const recent = []
const controller = new AbortController()
;(async () => {
  for await (const event of kode.events({ signal: controller.signal })) {
    recent.push(event)
    if (recent.length > 100) recent.shift()
    log(event.kind, `session=${event.session_id}`, JSON.stringify(event.payload).slice(0, 300))
  }
})().catch(error => { if (!controller.signal.aborted) { log('event stream ended:', error.message); process.exit(1) } })

// Read-only: anything that starts work goes through the authenticated API.
const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ hello, recent }, null, 2))
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ type: 'kode.extension.ready', protocol_version: 1, url: `http://127.0.0.1:${server.address().port}` }) + '\n')
})

// Kode closes stdin when it stops or disables the extension.
process.stdin.resume()
process.stdin.on('end', () => { controller.abort(); server.close(); process.exit(0) })
