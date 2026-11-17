/** Preferences are pure; disclosure preservation is checked in an actual browser. */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

const result = await build({ entryPoints: ['packages/collab/sidebar-sections.js'], bundle: true, format: 'cjs', platform: 'browser',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false })
const module = { exports: {} }
const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useState: value => [value, () => {}], useId: () => 'fixture-section' }
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {} })
const { SidebarSection, loadSections, saveSections, SIDEBAR_SECTIONS_KEY } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
const defaults = { channels: true, direct: true, sessions: true, apps: true, threads: true }

test('section preferences accept only their own boolean presentation fields', () => {
  let key, saved
  const storage = { getItem: name => { key = name; return JSON.stringify({ channels: false, sessions: false, direct: 'false', apps: null, mode: 'im', draft: 'must not persist' }) },
    setItem: (name, value) => { key = name; saved = value } }
  assert.deepEqual(plain(loadSections(storage)), { ...defaults, channels: false, sessions: false })
  assert.equal(key, SIDEBAR_SECTIONS_KEY)
  assert.equal(saveSections(storage, { ...defaults, apps: false, mode: 'session', draft: 'private draft' }), true)
  assert.equal(key, SIDEBAR_SECTIONS_KEY)
  assert.deepEqual(JSON.parse(saved), { ...defaults, apps: false })
  assert.equal(saved.includes('draft'), false)
  assert.deepEqual(plain(loadSections({ getItem: () => saved })), { ...defaults, apps: false })
})
test('unavailable, malformed or future preferences cannot break navigation', () => {
  for (const raw of ['{broken', '[]', 'null', 'false', '5', '"sessions"']) assert.deepEqual(plain(loadSections({ getItem: () => raw })), defaults)
  assert.deepEqual(plain(loadSections({ getItem() { throw Error('denied') } })), defaults)
  assert.deepEqual(plain(loadSections()), defaults)
  assert.equal(saveSections(undefined, defaults), false)
  assert.equal(saveSections({ setItem() { throw Error('quota full') } }, defaults), false)
  const a = loadSections(); a.apps = false
  assert.deepEqual(plain(loadSections()), defaults, 'fallback snapshots do not mutate the shared defaults')
})

test('section is a native project-row disclosure: folder slot, chevron slot, title, hover actions', () => {
  for (const icon of ['session', undefined]) {
    const tree = SidebarSection({ id: 'sessions', label: '会话', icon, open: false, children: 'retained content' })
    const [summary, body] = tree.props.children, [folder, chevron, text] = summary.props.children
    assert.equal(tree.type, 'details')
    assert.equal(tree.props.open, false)
    assert.equal(summary.type, 'summary')
    const P = summary.props.className.match(/(\S+_)projectRow\b/)[1]
    assert.match(summary.props.className, /_projectRow\b/)
    assert.equal(summary.props['aria-label'], '会话')
    assert.equal(summary.props['aria-expanded'], false)
    assert.equal(summary.props['aria-controls'], body.props.id)
    assert.equal(body.props['aria-labelledby'], summary.props.id)
    assert.equal(folder.props.className, icon ? `${P}slot ${P}folder` : `${P}slot`)
    assert.equal(folder.props['aria-hidden'], true)
    assert.equal(folder.props.children.filter(Boolean).length, icon ? 1 : 0)
    assert.equal(chevron.props.className, `${P}slot ${P}chevron`)
    assert.equal(text.props.className, `${P}projectText`)
    assert.deepEqual(body.props.children, ['retained content'])
  }
})

test('native section keyboard folding preserves the mounted Session node and draft', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-sidebar-sections-'))
  let server, browser
  try {
    const bundle = await build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {SidebarSection,loadSections,saveSections} from './packages/collab/sidebar-sections.js';
      const h=React.createElement;let mounted=0,unmounted=0;
      function Session(){React.useEffect(()=>{mounted++;return()=>unmounted++},[]);return h('textarea',{'aria-label':'preserved session draft',defaultValue:'尚未发送'})}
      function App(){const [state,setState]=React.useState(()=>loadSections(localStorage));return h(SidebarSection,{id:'sessions',label:'会话',icon:'panel',open:state.sessions,onToggle:(open,id)=>setState(previous=>{const next={...previous,[id]:open};saveSections(localStorage,next);return next})},h(Session))}
      const root=document.createElement('div');root.id='section-proof';root.style='position:fixed;inset:0;background:white;z-index:10000';document.body.append(root);createRoot(root).render(h(App));
      window.sectionProof={mounted:()=>mounted,unmounted:()=>unmounted};
    `, resolveDir: process.cwd() }, bundle: true, format: 'iife', platform: 'browser', external: ['react','react-dom/client','@deepseek-ai/dsh-client-ui-primitives'],
      write: false, banner: { js: 'const require=name=>window.__KODE_TEST_MODULES__[name];' } })
    server = createServer(async (req, res) => {
      if (req.url === '/section-proof.js') { res.setHeader('content-type','text/javascript'); res.end(bundle.outputFiles[0].text); return }
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end('{}')
    })
    server.listen(0,'127.0.0.1'); await once(server,'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(`new Promise((resolve,reject)=>{const start=()=>{if(!window.fixture)return setTimeout(start,20);const script=document.createElement('script');script.src='/section-proof.js';script.onload=resolve;script.onerror=reject;document.head.append(script)};start()})`)
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+5000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,20))}throw Error('Section fixture timed out '+JSON.stringify({open:document.querySelector('#section-proof details')?.open,expanded:document.querySelector('#section-proof summary')?.getAttribute('aria-expanded'),active:document.activeElement?.tagName,events:window.sectionEvents,errors:window.fixtureErrors}))})()`)
    await wait(`document.querySelector('#section-proof textarea') && sectionProof.mounted()===1`)
    await page.evaluate(`window.originalSessionNode=document.querySelector('#section-proof textarea');originalSessionNode.focus()`)
    await page.call('Input.insertText',{text:'，继续保留'})
    const draft = await page.evaluate('originalSessionNode.value')
    await page.evaluate(`window.sectionEvents=[];for(const name of ['keydown','keyup','toggle'])document.querySelector('#section-proof details').addEventListener(name,e=>sectionEvents.push({name,key:e.key,open:e.currentTarget.open}),true);document.querySelector('#section-proof summary').focus()`)
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13})
    await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await wait(`document.querySelector('#section-proof summary').getAttribute('aria-expanded')==='false'`)
    assert.equal(await page.evaluate(`document.querySelector('#section-proof details').open`),false)
    assert.equal(await page.evaluate(`document.querySelector('#section-proof textarea')===originalSessionNode`),true)
    assert.equal(await page.evaluate('sectionProof.unmounted()'),0)
    assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SIDEBAR_SECTIONS_KEY)})).sessions`),false)
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',text:' ',unmodifiedText:' ',windowsVirtualKeyCode:32})
    await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32})
    await wait(`document.querySelector('#section-proof summary').getAttribute('aria-expanded')==='true'`)
    assert.equal(await page.evaluate('originalSessionNode.value'),draft)
    assert.equal(await page.evaluate('sectionProof.mounted()'),1)
    assert.equal(await page.evaluate(`document.querySelector('#section-proof textarea')===originalSessionNode`),true)
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
    await rm(profile,{recursive:true,force:true})
  }
})
