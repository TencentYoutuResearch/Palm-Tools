import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { registerIntegrationApi } from '../src/integration-api.js'
import { sessionNamingPolicy } from '../src/session-create.js'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
const between = (from, to) => { const start = source.indexOf(from); assert.ok(start >= 0, from); return source.slice(start, source.indexOf(to, start)) }
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const nodes = tree => { const out = []; const visit = value => { if (!value || typeof value !== 'object') return; out.push(value); for (const child of value.children ?? []) visit(child) }; visit(tree); return out }
const text = tree => !tree || typeof tree !== 'object' ? (typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '') : tree.children.map(text).join('')
const icons = { IconCheckOutlineRegular: 'check', IconWarningOutlineRegular: 'warning', IconLoadingOutlineRegular: 'loading', IconChevronDownOutlineRegular: 'chevron' }

test('notification state separates macOS-managed, delivery failure, default, denied and unsupported', () => {
  const scope = {}
  vm.runInNewContext(between('  function notificationState(', '  function NotificationSettingsBody('), scope)
  const state = snapshot => scope.notificationState(snapshot)
  assert.deepEqual([state({ permission: 'loading' }).tone, state({ permission: 'unsupported' }).tone], ['checking', 'off'])
  // Electron always reports granted, so the system row never claims a permission it cannot read.
  const system = state({ permission: 'granted', systemSettings: true })
  assert.equal(system.title, '由 macOS 系统设置管理'); assert.equal(system.system, true); assert.match(system.detail, /系统设置 → 通知.*允许通知/)
  assert.equal(state({ permission: 'granted', systemSettings: true, deliveryError: 'x' }).tone, 'error')
  assert.equal(state({ permission: 'default' }).enable, true)
  assert.match(state({ permission: 'denied' }).detail, /网站设置或 macOS 系统设置/)
  assert.equal(state({ permission: 'granted' }).title, '已允许通知')
  for (const snapshot of [{ permission: 'granted' }, { permission: 'granted', systemSettings: true }, { permission: 'default' }]) assert.equal('test' in state(snapshot), false)
})

test('agent update status names the failure once and explains slow Cursor updates', () => {
  const scope = { h, ...icons }
  vm.runInNewContext(between('  function AgentUpdateStatus(', '  function AgentUpdateButton('), scope)
  const render = (type, outcome) => scope.AgentUpdateStatus({ profile: { id: 'p', type }, state: { outcomes: { p: outcome } } })
  const failed = render('cursor', { phase: 'failed', update: true, message: '更新失败，请检查安装权限和发布源后重试。' })
  assert.equal(failed.props.role, 'alert'); assert.equal(failed.props['data-phase'], 'failed')
  assert.equal(text(failed), '更新失败：请检查安装权限和发布源后重试。')
  assert.equal(text(render('cursor', { phase: 'failed', message: '' })), '检查失败：请重试。')
  const updating = render('cursor', { phase: 'updating' })
  assert.equal(updating.props.role, 'status'); assert.match(text(updating), /Cursor 需下载完整安装包/)
  assert.equal(nodes(updating)[1].props.className, 'kode-spin')
  assert.equal(text(render('codex', { phase: 'updating' })), '正在更新…')
  assert.equal(text(render('cursor', { phase: 'updated', from: '2025.11.06', to: '2025.11.20' })), '已更新：2025.11.06 → 2025.11.20')
  assert.equal(render('dsh', { phase: 'failed', message: 'x' }), null)
  assert.match(source, /\.kode-agent-update-status\[data-phase=failed\]\{[^}]*color:var\(--dsw-alias-/)
})

test('the partner sidebar collapses, remembers its state and keeps unseen activity visible', () => {
  const storage = new Map()
  const scope = { h, ...icons, IconChevronDownOutlineRegular: 'chevron',
    useSyncExternalStore: (_, read) => read(), useBots: () => ({ data: { bots: [{id:'b1'}] } }),
    useWatches: () => ({ data: { unseen: { b1: 2 } } }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } }
  const effects = []
  scope.useRef = initial => ({ current: initial }); scope.useEffect = fn => effects.push(fn)
  vm.runInNewContext(between('  const BOTS_COLLAPSED_KEY', '  function botBannerStyle('), scope)
  const render = () => scope.BotsNavTrailing()
  const control = () => render().children.find(node => node?.props?.role === 'button')
  assert.equal(control().props['aria-expanded'], true)
  let stopped = 0, prevented = 0
  const event = { stopPropagation() { stopped++ }, preventDefault() { prevented++ } }
  control().props.onClick(event)
  assert.equal(storage.get('kode.dsh.botsCollapsed'), '1')
  assert.deepEqual([stopped, prevented], [1, 1])
  assert.equal(control().props['aria-expanded'], false)
  assert.match(text(render()), /2/)
  control().props.onKeyDown({ ...event, key: 'Enter' })
  assert.equal(storage.get('kode.dsh.botsCollapsed'), '0')
  control().props.onKeyDown({ ...event, key: ' ' })
  assert.equal(storage.get('kode.dsh.botsCollapsed'), '1')
  assert.deepEqual([stopped, prevented], [3, 3])
  assert.match(source, /\[class\*="panelEntry"\]:has\(\.kode-bots-collapse\) \[class\*="panelRow"\]\{padding-right:38px\}/)
  assert.match(source, /:is\(:hover,:has\(:focus-visible\)\) \[class\*="panelTrailing"\]:has\(\.kode-bots-trailing\)\{opacity:1\}/)
  assert.match(source, /\.kode-bots-collapse:focus-visible\{outline:/)
  // At rest the arrow hides on hover-capable pointers; touch keeps it visible and the title text toggles.
  assert.match(source, /@media\(hover:hover\)\{[^@]*\[class\*="panelEntry"\]:has\(\.kode-bots-collapse\):not\(:hover\):not\(:has\(:focus-visible\)\) \.kode-bots-collapse\{opacity:0\}/)
  const listeners = {}, classes = new Set()
  const title = { addEventListener: (type, fn) => { listeners[type] = fn }, removeEventListener: type => { delete listeners[type] }, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }
  render().props.ref.current = { closest: () => ({ querySelector: selector => selector === '[class*="panelTitle"]' ? title : null }) }
  const cleanup = effects.at(-1)()
  assert.ok(classes.has('kode-bots-title'))
  const before = storage.get('kode.dsh.botsCollapsed')
  listeners.click(event)
  assert.notEqual(storage.get('kode.dsh.botsCollapsed'), before)
  assert.deepEqual([stopped, prevented], [4, 4])
  cleanup(); assert.equal(listeners.click, undefined); assert.ok(!classes.has('kode-bots-title'))

})

test('collapsed communication rows name the peer and direction but never the body', () => {
  const directory = { nodeId: 'local', sessions: [{ address: { node_id: 'n3', session_id: 'long' }, title: 'GPU 训练机上的发布值班会话（SSH）' }], error: '' }
  const local = { byId: { here: { title: '修复登录跳转' }, peer: { title: 'Bug-SSH Workspace Resume' } } }
  let captured
  const scope = {
    h, React: { Fragment: 'fragment' }, ...icons,
    IconClockOutlineRegular: 'clock', IconPaperPlaneOutlineRegular: 'plane', IconMailReadOutlineRegular: 'read', IconMailUnreadOutlineRegular: 'unread',
    useSyncExternalStore: (subscribe, get) => get(), useEffect() {}, refreshNames() {},
    namesStore: { subscribe() {}, getSnapshot: () => directory },
    DisclosurePanelRows: 'disclosure', PanelMarkdown: 'markdown', cardKey: id => id,
  }
  vm.runInNewContext([
    between('  function useNames(', '  // Presentation only'),
    between('  const relayKinds = {', '  // Agent prose reads'),
    between('  const deliveryStatusLabels =', '\n') + '\n',
    between('  function relayKind(', '  function KodeCommunication('),
  ].join('\n'), scope)
  const body = 'SECRET-BODY 请勿出现在折叠行'
  const messages = [
    { id: 'a', direction: 'sent', nodeId: 'local', sessionId: 'peer', title: '请复核登录修复', content: body, status: 'accepted' },
    { id: 'b', direction: 'received', nodeId: 'n3', sessionId: 'long', title: '值班交接', content: body },
    { id: 'c', direction: 'received', content: body },
  ]
  captured = scope.CommunicationRows({ sessionId: 'here', sessions: { list: { subscribe() {}, getSnapshot: () => local } }, messages }).props
  const [sent, incoming, legacy] = messages.map(captured.rowProps)
  assert.equal(sent.detailTitle, '发往 Bug-SSH Workspace Resume')
  assert.equal(sent.actionLabel, '请复核登录修复，等待对方回复，发往 Bug-SSH Workspace Resume')
  assert.equal(incoming.detailTitle, '来自 GPU 训练机上的发布值班会话（SSH）')
  assert.equal(text(incoming.detail), '来自 GPU 训练机上的发布值班会话（SSH）')
  // Old rows without an address and without a title stay generic.
  assert.equal(legacy.detailTitle, '来自 对端会话'); assert.equal(legacy.label, '会话消息')
  for (const row of [sent, incoming, legacy]) assert.ok(!JSON.stringify(row).includes('SECRET-BODY'))
  const meta = row => text(nodes(captured.content(row)).find(node => node.props.className === 'kode-panel-meta'))
  assert.equal(meta(messages[0]), '等待对方回复 · 本会话 修复登录跳转 → Bug-SSH Workspace Resume · 发送时已交给目标会话')
  assert.equal(meta(messages[1]), '收到消息 · GPU 训练机上的发布值班会话（SSH） → 本会话 修复登录跳转')
  assert.equal(meta(messages[2]), '收到消息 · 对端会话 → 本会话 修复登录跳转')
  assert.match(source, /detailTitle = detail/)
})

test('Kode dialogs size to content between per-dialog bounds and go full width on narrow screens', () => {
  assert.match(source, /:is\(\.kode-project-dialog,\.kode-handoff-dialog,\.kode-subagent-dialog,\.kode-confirm-dialog,\.kode-source-dialog,\.kode-avatar-dialog\)\{width:fit-content;min-width:min\(var\(--kode-dialog-min\),100%\);max-width:min\(var\(--kode-dialog-max\),100%\)\}/)
  for (const name of ['project', 'handoff', 'subagent', 'confirm', 'source', 'avatar']) assert.match(source, new RegExp(`\\.kode-${name}-dialog[,{][^}]*--kode-dialog-min:\\d+px`), name)
  assert.match(source, /@media\(min-width:1440px\)\{[^@]*\.kode-subagent-dialog\{--kode-dialog-max:960px\}/)
  assert.match(source, /\.kode-source-dialog\{--kode-dialog-min:480px;--kode-dialog-max:960px;max-height:min\(720px,calc\(100dvh - 64px\)\)\}/)
  // The native dialog width rule outranks a single class; the doubled selector widens plugin details.
  assert.match(source, /\.kode-source-dialog\.kode-source-dialog\{width:min\(960px,calc\(100vw - 48px\)\)\}/)
  assert.match(source, /@media\(min-width:1440px\)\{[^@]*\.kode-source-dialog\{--kode-dialog-max:1120px;max-height:min\(800px,calc\(100dvh - 64px\)\)\}[^@]*\.kode-source-dialog\.kode-source-dialog\{width:1120px\}/)
  assert.match(source, /@media\(max-width:600px\)\{[^@]*\.kode-source-dialog\.kode-source-dialog\{width:100%\}/)
  assert.match(source, /@media\(max-width:600px\)\{[^@]*:is\(\.kode-project-dialog,[^)]*\)\{width:100%;min-width:0\}/)
})

test('the integrations GET exposes the built-in naming rule for display and editing', async () => {
  let handler
  registerIntegrationApi({
    webServer: { register: route => { handler = route.handler } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
  }, { call: async path => ({ path }) })
  const req = Readable.from([]); req.method = 'GET'
  let payload
  const res = { setHeader() {}, end: value => { payload = JSON.parse(value) } }
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(payload.sessionNaming, { defaultPrompt: sessionNamingPolicy().prompt, maxWords: sessionNamingPolicy().maxWords })
  assert.ok(payload.sessionNaming.defaultPrompt.length > 0)
})

test('the bot settings dialog sizes itself and lays out by its own width, never by the window', () => {
  const rules = [...source.matchAll(/\.kode-bot-settings\{([^}]*)\}/g)].map(match => match[1])
  assert.equal(rules.length, 2, 'one base rule and one width rule, no later rule resetting the width')
  const width = rules.map(rule => /width:([^;]+)/.exec(rule)?.[1]).filter(Boolean)
  assert.deepEqual(width.at(-1), 'min(1040px,calc(100vw - 32px))')
  assert.match(rules.join(';'), /container-type:inline-size/, 'the dialog is the query container for its body')
  assert.doesNotMatch(source, /\.kode-bot-settings-body\{[^}]*container-type/, 'a container cannot style itself')
  assert.doesNotMatch(source, /\.kode-bot-settings\{width:fit-content/, 'no fit-content reset')
  assert.match(source, /\.kode-bot-pane-columns\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,280px\),1fr\)\)/)
  assert.match(source, /@container \(max-width:820px\)\{[^@]*\.kode-bot-settings-nav\{flex-direction:row/)
  assert.match(source, /@container \(max-width:600px\)\{[^@]*\.kode-bot-pane-columns\{grid-template-columns:minmax\(0,1fr\)/)
  assert.doesNotMatch(source, /@media \(max-width:860px\)\{[^@]*kode-bot-pane-columns/, 'window width must not decide the dialog layout')
})
