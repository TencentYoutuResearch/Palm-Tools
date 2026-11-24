#!/usr/bin/env node
/**
 * Sample extension backend. Kode starts it with KODE_EXT_API / KODE_EXT_TOKEN
 * because the manifest asks for API capabilities; it never sees the admin
 * token. It follows the pushed events of the sessions it owns, logs them
 * (Settings → Extensions → logs) and serves the "API sample" panel, which
 * shows them live and reports a badge and a toast to Kode for each finished
 * turn. The page is read-only: starting work goes through the API.
 */
import { createServer } from 'node:http'
import { KodeExtension } from '../../../packages/extension-sdk/src/index.js'

const log = (...parts) => console.error('[kode.sample]', ...parts)
const kode = new KodeExtension()
const hello = await kode.hello()
log('connected', JSON.stringify({ api: hello.api_version, capabilities: hello.capabilities, gui: hello.runtimes.gui }))

const recent = []
const pages = new Set()
const controller = new AbortController()
;(async () => {
  for await (const event of kode.events({ signal: controller.signal })) {
    recent.push(event)
    if (recent.length > 100) recent.shift()
    log(event.kind, `session=${event.session_id}`, JSON.stringify(event.payload).slice(0, 300))
    for (const page of pages) page.write(`data: ${JSON.stringify(event)}\n\n`)
  }
})().catch(error => { if (!controller.signal.aborted) { log('event stream ended:', error.message); process.exit(1) } })

const PAGE = `<!doctype html><meta charset="utf-8"><title>API sample</title>
<style>body{font:13px -apple-system,system-ui,sans-serif;margin:24px;color:#222}@media(prefers-color-scheme:dark){body{color:#ddd;background:#1c1c1e}}
li{margin:4px 0;font-family:ui-monospace,monospace;font-size:12px}h1{font-size:16px}</style>
<h1>kode.api/v1 sample</h1><p>Turns of sessions this extension started (run <code>bin/demo.mjs</code>).</p><ul id="events"></ul>
<script>
const list = document.getElementById('events')
let finished = 0
function show(event, live) {
  const item = document.createElement('li')
  item.textContent = event.kind + ' · session ' + event.session_id + ' · ' + JSON.stringify(event.payload).slice(0, 160)
  list.prepend(item)
  if (live && event.kind === 'session.turn_completed') {
    finished += 1
    window.kodeHost?.request('badge', { count: finished })
    window.kodeHost?.request('notify', { title: 'Turn finished', body: event.payload.final_message?.text ?? '' })
  }
}
fetch('/state').then(r => r.json()).then(state => state.recent.forEach(e => show(e, false)))
new EventSource('/stream').onmessage = message => show(JSON.parse(message.data), true)
</script>`

const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return }
  if (req.url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello, recent }))
  } else if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    pages.add(res)
    req.on('close', () => pages.delete(res))
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  }
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ type: 'kode.extension.ready', protocol_version: 1, url: `http://127.0.0.1:${server.address().port}` }) + '\n')
})

// Kode closes stdin when it stops or disables the extension.
process.stdin.resume()
process.stdin.on('end', () => { controller.abort(); server.close(); process.exit(0) })
