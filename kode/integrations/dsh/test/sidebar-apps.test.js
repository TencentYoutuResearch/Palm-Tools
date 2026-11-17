import test from 'node:test'
import assert from 'node:assert/strict'
import { APPLICATION_CONNECTION_NOTE, createSidebarAppsSource, openPluginManagement, openSidebarApplication, sidebarApplications } from '../packages/collab/sidebar-app-source.js'

function fixture() {
  let entries = [], language = 'zh'
  const slotListeners = new Set(), localeListeners = new Set(), navigated = []
  const slots = {
    entriesOfSlot(name) { assert.equal(name, 'sidebar.panellist'); return [...entries] },
    subscribe(name, listener) { assert.equal(name, 'sidebar.panellist'); slotListeners.add(listener); return () => slotListeners.delete(listener) },
  }
  const locale = { subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener) } }
  const ctx = { slots, locale, layout: { selectPanel: id => navigated.push(id) },
    get sessions() { throw Error('Worker sessions must never be read for application navigation') } }
  return { ctx, source: createSidebarAppsSource(ctx), navigated,
    set(rows) { entries = rows.map(options => ({ options })); for (const listener of [...slotListeners]) listener() },
    translate() { return language === 'zh' ? '代码评审' : 'Code review' },
    locale(value) { language = value; for (const listener of [...localeListeners]) listener() },
    counts: () => ({ slots: slotListeners.size, locale: localeListeners.size }) }
}

test('application rows use only actual panel metadata, preserve registry order, and exclude the native base entries', () => {
  const f = fixture()
  f.set([{ id: 'plugins', label: '插件' }, { id: 'kode-settings', label: 'Kode' }, { id: 'schedules', label: '自动化任务' },
    { id: 'review', order: 50, label: '代码评审' }, { id: 'notes', order: 5, label: () => '笔记' }])
  assert.deepEqual(f.source.getSnapshot(), [{ id: 'review', order: 50, label: '代码评审' }, { id: 'notes', order: 5, label: '笔记' }])
  assert.equal(openSidebarApplication(f.ctx, 'review'), true)
  assert.deepEqual(f.navigated, ['review'])
  assert.equal(openSidebarApplication(f.ctx, 'tapd'), false)
  assert.equal(openSidebarApplication(f.ctx, 'git'), false)
  assert.deepEqual(f.navigated, ['review'])
})
test('dynamic registration, replacement, removal and locale changes publish stable cached snapshots', () => {
  const f = fixture(); let changes = 0
  const off = f.source.subscribe(() => changes++)
  const empty = f.source.getSnapshot()
  assert.equal(empty, f.source.getSnapshot())
  f.set([{ id: 'review', label: f.translate }])
  const initial = f.source.getSnapshot()
  assert.equal(changes, 1)
  assert.equal(initial, f.source.getSnapshot(), 'fresh registry arrays must not cause render loops')
  f.set([{ id: 'review', label: f.translate }])
  assert.equal(changes, 1)
  assert.equal(initial, f.source.getSnapshot())
  f.locale('en')
  assert.equal(changes, 2)
  assert.equal(f.source.getSnapshot()[0].label, 'Code review')
  f.set([{ id: 'replacement', label: 'Replacement' }])
  assert.equal(openSidebarApplication(f.ctx, 'review'), false, 'removed routes cannot be opened by a stale rendered row')
  f.set([])
  assert.deepEqual(f.source.getSnapshot(), [])
  off()
  assert.deepEqual(f.counts(), { slots: 0, locale: 0 })
})
test('empty applications expose only plugin management and never invent TAPD/Git installation or account status', () => {
  const f = fixture()
  assert.deepEqual(sidebarApplications(f.ctx.slots), [])
  assert.equal(openPluginManagement(f.ctx), true)
  assert.deepEqual(f.navigated, ['plugins'])
  assert.match(APPLICATION_CONNECTION_NOTE, /连接状态尚未接入/)
  assert.equal(APPLICATION_CONNECTION_NOTE.includes('已连接'), false)
  assert.equal(APPLICATION_CONNECTION_NOTE.includes('未配置'), false)
})
test('duplicate/invalid metadata cannot create phantom application rows or bypass missing navigation', () => {
  const f = fixture()
  f.set([{ id: null }, { id: 'review', label: () => { throw Error('localization unavailable') } }, { id: 'review', label: 'Duplicate' }])
  assert.deepEqual(f.source.getSnapshot(), [{ id: 'review', label: 'review', order: 0 }])
  assert.equal(openSidebarApplication({ slots: f.ctx.slots }, 'review'), false)
  assert.equal(openPluginManagement({}), false)
})
