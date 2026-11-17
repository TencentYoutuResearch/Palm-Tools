import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')

test('SuperAgent settings has exactly one inner vertical scrollport', async () => {
  const [panel, discussion] = await Promise.all([
    read('packages/collab/superagent-settings-panel.js'),
    read('packages/collab/discussion-ui.js'),
  ])
  assert.match(panel, /\.kode-superagent-settings-tab\{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden\}/)
  assert.match(panel, /\.kode-superagent-settings>\.kode-settings-main\{box-sizing:border-box;flex:1;min-height:0;height:100%;overflow-y:auto;/)
  assert.doesNotMatch(panel, /\.kode-superagent-settings-tab\{[^}]*overflow:auto/)
  assert.doesNotMatch(panel, /\.kode-superagent-settings>\.kode-settings-main\{[^}]*overscroll-behavior:contain/)
  assert.match(discussion, /\.kode-discussion-settings\.kode-superagent-settings-host\{display:flex;flex-direction:column;overflow:hidden\}/)
})

test('inline retry icons stay compact and never inherit sidebar text-link styling', async () => {
  const [rows, collabStyles, icons, discussion] = await Promise.all([
    read('packages/collab/native-rows.js'),
    read('packages/collab/styles.js'),
    read('packages/collab/icons.js'),
    read('packages/collab/discussion-ui.js'),
  ])
  assert.match(rows, /\.kode-sidebar-empty button:not\(\.kode-collab-icon-button\)/)
  assert.match(collabStyles, /\.kode-collab-icon-button\.kode-collab-icon-button-sm[^}]*width:22px;height:22px;min-width:22px;min-height:22px/)
  assert.match(collabStyles, /color:var\(--dsw-alias-label-secondary\);vertical-align:middle/)
  assert.match(collabStyles, /color:var\(--dsw-alias-label-primary\);background:var\(--dsw-alias-interactive-bg-hover\)/)
  assert.match(icons, /size === 'sm' \? 14 : 18/)
  assert.match(discussion, /icon:'refresh',size:'sm',label:'重新读取频道目录'/)
})

test('Orbit headers put the divider below native tabs, not between title and tabs', async () => {
  const [layout, builderStyles, discussion, resources, builder, client] = await Promise.all([
    read('packages/collab/collaboration-layout.js'),
    read('packages/collab/builder-conversation-styles.js'),
    read('packages/collab/discussion-ui.js'),
    read('packages/collab/project-resource-session-tabs.js'),
    read('packages/collab/builder-view.js'),
    read('packages/collab/client-source.js'),
  ])
  for (const source of [layout, builderStyles]) {
    assert.match(source, /border-bottom:\.5px solid var\(--dsw-alias-border-l3,var\(--dsw-alias-border-l2\)\)/)
  }
  assert.match(layout, /\.kode-discussion-heading\.kode-discussion-heading-with-tabs,\.kode-collab-header\.kode-collab-header-with-tabs\{border-bottom:0\}/)
  assert.match(builderStyles, /\.kode-builder-topbar\.kode-builder-topbar-with-tabs\{border-bottom:0\}/)
  assert.match(discussion, /className:'kode-discussion-view-tabs'/)
  assert.match(resources, /className:'kode-discussion-view-tabs'/)
  assert.match(builder, /className:'kode-builder-view-tabs'/)
  assert.match(client, /className:'kode-collab-view-tabs'/)
})

const reactStub = `
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
useSyncExternalStore:(subscribe,getSnapshot)=>getSnapshot(),useState:initial=>[initial,()=>{}],useEffect:()=>{},useMemo:fn=>fn()};
module.exports=React;module.exports.default=React;
`
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'react' ? reactStub : 'const any=new Proxy(function(){},{get:(t,k)=>k==="__esModule"?false:any,apply:()=>any});module.exports=any', loader: 'js' }))
} }

test('Orbit main Session passes native tabbed views into the embedded conversation', async () => {
  const out = await build({ absWorkingDir: new URL('..', import.meta.url).pathname, entryPoints: ['packages/collab/orbit-session-view.js'], bundle: true, format: 'esm', platform: 'node', plugins: [stub], write: false })
  const dir = await mkdtemp(join(tmpdir(), 'orbit-session-view-')), file = join(dir, 'view.mjs')
  await writeFile(file, out.outputFiles[0].text)
  try {
    const { OrbitSessionView } = await import(file)
    const calls = [], views = function NativeConversationViews() {}
    const host = {
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { session: { title: '会话' } } }) } },
      renderSession: (reference, props) => { calls.push({ reference, props }); return null },
    }
    const scopedViewSource = { subscribe: () => () => {}, getSnapshot: () => [{ id: 'chat' }, { id: 'trajectory' }] }
    let boundSession
    const viewSource = { subscribe: () => () => {}, getSnapshot: () => [], forSession(id) { boundSession = id; return scopedViewSource } }
    const tree = OrbitSessionView({ host, views, viewSource, sessionId: 'session' })
    assert.equal(boundSession, 'session')
    const walk = node => {
      if (!node || typeof node !== 'object') return null
      if (node.type?.name === 'PlanningSessionEmbed') return node
      for (const child of node.props?.children ?? []) { const found = walk(child); if (found) return found }
      return null
    }
    const embedded = walk(tree)
    assert.ok(embedded)
    const reference = {}
    embedded.props.host.renderSession(reference)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].reference, reference)
    assert.equal(calls[0].props.views, views)
    assert.match(tree.props.children[0].props.children[0], /kode-session-view-tabs/)
    assert.match(tree.props.children[1].props.className, /kode-builder-topbar-with-tabs/)
    const withoutTabs = OrbitSessionView({ host, views, sessionId: 'session' })
    assert.doesNotMatch(withoutTabs.props.children[1].props.className, /kode-builder-topbar-with-tabs/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
