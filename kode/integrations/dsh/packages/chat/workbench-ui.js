/** Workbench status: one application-wide token island; jobs beside the composer.
 * The native job component retains its subscriptions, locale, output and kill UI. */
const defaultIslandAppearance = { tokenIsland: true, tokenPeriod: 'today' }
const idleIslandActivity = { state: 'idle', label: '全局：所有会话空闲' }
let kodeWorkbenchContext

// The native window has square corners; CSS owns only the two bottom corners.
// Paint through the camera clearance, so the real cutout and wings form one bar.
const nativeIslandStyle = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;min-height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.kode-token-rail{width:100%;height:var(--kode-menu-height,28px);min-height:var(--kode-menu-height,28px)}
.kode-token-notch,.kode-token-notch:hover{width:240px;height:min(var(--kode-menu-height,28px),100dvh);border-radius:0 0 8px 8px;background:#000;box-shadow:none}
.kode-token-panel{max-height:calc(100dvh - 4px);box-shadow:none}
button,input{font:inherit}
html[data-kode-menu-camera=true] .kode-token-notch,html[data-kode-menu-camera=true] .kode-token-notch:hover{display:grid;grid-template-columns:24px var(--kode-camera-gap,200px) 96px;position:absolute;left:calc(var(--kode-camera-center,124px) - var(--kode-camera-gap,200px)/2 - 24px);width:calc(120px + var(--kode-camera-gap,200px));gap:0;padding:0;background:#000}
html[data-kode-menu-camera=true] .kode-island-name,html[data-kode-menu-camera=true] .kode-island-period-label{display:none}
html[data-kode-menu-camera=true] .kode-token-notch::before{content:"";grid-column:2;grid-row:1}
html[data-kode-menu-camera=true] .kode-island-host{grid-column:1;grid-row:1;justify-content:flex-end;height:100%;padding:0 8px}
html[data-kode-menu-camera=true] .kode-island-usage{grid-column:3;grid-row:1;align-items:center;justify-content:flex-start;height:100%;margin:0;padding:0 22px 0 8px}
html[data-kode-menu-camera=true] .kode-token-notch>svg{position:absolute;right:8px;top:calc(50% - 6px)}
`

function relocateWorkbenchJobs(ctx) {
  const sourceSeat = 'conversation.session.header.actions', targetSeat = 'conversation.input.dock'
  ctx.slots.inject(sourceSeat, () => {
    const moved = new Map()
    const install = () => {
      for (const entry of ctx.slots.entries(sourceSeat)) {
        if (entry.options.id !== 'job-list' || moved.has(entry)) continue
        const native = entry.component, hidden = () => null
        const DockJobs = props => react.createElement('div', { className: 'kode-background-tasks' }, react.createElement(native, props))
        const dispose = ctx.slots.register({ ...entry.options, inject: entry.inject ?? entry.options.inject, locale: entry.locale ?? entry.options.locale, name: targetSeat, order: 20 }, DockJobs)
        moved.set(entry, { native, hidden, dispose }); entry.component = hidden
      }
    }
    const unsubscribe = ctx.slots.subscribe(sourceSeat, install); install()
    return () => { unsubscribe(); for (const [entry, row] of moved) { row.dispose(); if (entry.component === row.hidden) entry.component = row.native } }
  })
}
function usageNumber(value) {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
function usageTableRows(snapshot) {
  return [...(snapshot?.rows ?? [])].sort((a, b) => b.total_tokens - a.total_tokens)
}
const usagePalette = ['#88e5b2', '#78b8ff', '#e6a58b', '#bdabff', '#f1cd78', '#ef96bd', '#63d5d1', '#d5b899']
function usageGroupRows(rows, dimension) {
  const groups = new Map()
  for (const row of rows) {
    const key = row[dimension] || '未知'
    let group = groups.get(key)
    if (!group) { group = { key, input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 }; groups.set(key, group) }
    for (const field of ['input_tokens', 'output_tokens', 'cached_tokens', 'total_tokens']) group[field] += row[field] ?? 0
  }
  return [...groups.values()].sort((a, b) => b.total_tokens - a.total_tokens || a.key.localeCompare(b.key))
}
function usageView(snapshot, period, dimension, selected, now = new Date(), startAt = null) {
  const groups = usageGroupRows(snapshot?.rows ?? [], dimension).map((row, index) => ({ ...row, color: usagePalette[index % usagePalette.length] }))
  const chosen = new Set(selected ?? groups.map(row => row.key)), rows = groups.filter(row => chosen.has(row.key))
  const totals = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 }
  for (const row of rows) for (const field of Object.keys(totals)) totals[field] += row[field]
  const pad = n => String(n).padStart(2, '0'), dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const buckets = new Map((snapshot?.timeline ?? []).map(bucket => [bucket.date, usageGroupRows(bucket.rows, dimension)]))
  const keys = []
  const firstRecord = [...buckets.keys()].sort().find(key => buckets.get(key).some(row => chosen.has(row.key) && row.total_tokens > 0))
  const startDate = startAt === null ? null : new Date(startAt)
  let first = firstRecord
  if (startDate) {
    first = dateKey(startDate)
    if (period === 'today') first += `T${pad(startDate.getHours())}:00`
    else if (period === 'all') first = first.slice(0, 7)
  }
  if (first) {
    const parts = first.split(/[-T:]/).map(Number)
    const cursor = new Date(parts[0], parts[1] - 1, parts[2] ?? 1, parts[3] ?? 0)
    while (cursor <= now) {
      keys.push(period === 'today' ? `${dateKey(cursor)}T${pad(cursor.getHours())}:00` : period === 'month' ? dateKey(cursor) : dateKey(cursor).slice(0, 7))
      if (period === 'today') cursor.setHours(cursor.getHours() + 1)
      else if (period === 'month') cursor.setDate(cursor.getDate() + 1)
      else cursor.setMonth(cursor.getMonth() + 1)
    }
  }
  const timeline = keys.map(key => {
    const values = new Map((buckets.get(key) ?? []).map(row => [row.key, row.total_tokens]))
    const layers = rows.map(row => ({ key: row.key, color: row.color, value: values.get(row.key) ?? 0 }))
    return { key, layers, total: layers.reduce((sum, row) => sum + row.value, 0) }
  })
  return { groups, rows, totals, timeline, max: Math.max(1, ...timeline.map(bucket => bucket.total)) }
}
function usagePeriod(period, since, now = Date.now()) {
  if (period !== 'custom') return period
  const duration = now - since
  return duration <= 2 * 86400000 ? 'today' : duration <= 120 * 86400000 ? 'month' : 'all'
}
function usageAreaPaths(view) {
  const { timeline, rows, max } = view
  if (!timeline.length) return []
  const base = timeline.map(() => 0)
  return rows.map(row => {
    const lower = [...base]
    timeline.forEach((bucket, index) => { base[index] += bucket.layers.find(layer => layer.key === row.key)?.value ?? 0 })
    const points = values => values.length === 1 ? [[0, 100 - values[0] / max * 88], [560, 100 - values[0] / max * 88]] : values.map((value, index) => [index * 560 / (values.length - 1), 100 - value / max * 88])
    const upper = points(base), bottom = points(lower).reverse()
    const line = upper.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
    const area = line + bottom.map(([x, y]) => ` L${x.toFixed(2)} ${y.toFixed(2)}`).join('') + ' Z'
    return { key: row.key, color: row.color, line, area }
  })
}
function usageDateTime(value) {
  const date = new Date(value), pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
function usageDefaultStart(snapshot, period, end) {
  const first = (snapshot?.timeline ?? []).find(bucket => bucket.rows.some(row => row.total_tokens > 0))?.date
  if (first) return new Date(first.length === 7 ? `${first}-01T00:00` : first.length === 10 ? `${first}T00:00` : first).getTime()
  const start = new Date(end)
  start.setHours(0, 0, 0, 0)
  if (period === 'month') start.setDate(1)
  return period === 'all' ? end : start.getTime()
}
function KodeTokenIsland({ activity, appearance } = {}) {
  const h = react.createElement, { IconChevronDownOutlineRegular, IconCloseOutlineRegular } = _deepseek_ai_dsh_client_ui_primitives
  const ctx = kodeWorkbenchContext, transport = ctx?.get('kodeTransport')
  const preferences = react.useSyncExternalStore(appearance?.subscribe ?? (() => () => {}), appearance?.getSnapshot ?? (() => defaultIslandAppearance))
  const enabled = preferences.tokenIsland, tokenPeriod = preferences.tokenPeriod ?? 'today'
  const followRange = tokenPeriod === 'follow'
  const status = react.useSyncExternalStore(activity?.subscribe ?? (() => () => {}), activity?.getSnapshot ?? (() => idleIslandActivity))
  const host = react.useSyncExternalStore(react.useCallback(fn => transport?.subscribe(fn) ?? (() => {}), [transport]), () => transport?.current ?? 'local')
  const [open, setOpen] = react.useState(false), [present, setPresent] = react.useState(false), [period, setPeriod] = react.useState(followRange ? 'today' : tokenPeriod)
  const [dimension, setDimension] = react.useState('backend'), [selected, setSelected] = react.useState(null)
  const [result, setResult] = react.useState(null), [error, setError] = react.useState(''), [loading, setLoading] = react.useState(false), [refresh, setRefresh] = react.useState(0)
  const root = react.useRef(null), trigger = react.useRef(null), panelId = react.useId()
  const [rangeInputs, setRangeInputs] = react.useState({ start: null, end: null }), [range, setRange] = react.useState(null)
  const [nativeWindow, setNativeWindow] = react.useState(null)
  react.useEffect(() => { if (followRange) return; setPeriod(tokenPeriod); setRange(null); setRangeInputs({ start: null, end: null }); setSelected(null) }, [tokenPeriod])
  react.useEffect(() => {
    if (!enabled) { setNativeWindow(null); setOpen(false); setPresent(false); return }
    if (!globalThis.kodeDesktop?.island) return
    const popup = window.open('about:blank', 'kode-token-island', 'popup,width=240,height=28')
    if (!popup) return
    try {
      popup.document.title = 'Kode 用量'
      const style = popup.document.createElement('style')
      style.textContent = (document.querySelector('[data-kode-workbench]')?.textContent ?? '') + nativeIslandStyle
      popup.document.head.append(style)
      setNativeWindow(popup)
    } catch { popup.close(); return }
    return () => popup.close()
  }, [enabled])
  react.useEffect(() => {
    if (enabled && nativeWindow) globalThis.kodeDesktop?.resizeIsland({ width: open ? 640 : 240, height: open ? Math.min(820, nativeWindow.screen.availHeight - 32) : 28 })
  }, [enabled, nativeWindow, open])
  const bucketPeriod = usagePeriod(period, range?.since, range?.until)
  const tokenPeriodLabel = { today: '今日', month: '本月', all: '全部', custom: '所选范围' }[followRange ? period : tokenPeriod]
  const current = result?.host === host ? result : null
  const meter = current?.tokenPeriod === tokenPeriod && (!followRange || (current.period === period && current.range === range)) ? current.meter : null
  react.useEffect(() => {
    if (open) { setPresent(true); return }
    const timer = setTimeout(() => setPresent(false), 280)
    return () => clearTimeout(timer)
  }, [open])
  react.useEffect(() => {
    if (!enabled) return
    let alive = true, pending = false
    const controller = new AbortController()
    const visible = () => !document.hidden || Boolean(nativeWindow && !nativeWindow.closed && !nativeWindow.document.hidden)
    const load = async () => {
      if (pending || !visible()) return
      pending = true; setLoading(true); setError('')
      try {
        const read = async (period, start, end) => {
          const path = `/api/kode/model-usage?period=${period}&timezone_offset_minutes=${-new Date().getTimezoneOffset()}${start == null ? '' : `&since_ms=${start}`}${end == null ? '' : `&until_ms=${end}`}`
          const options = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }
          const response = await (transport ? transport.fetch(path, options, host) : fetch(path, options))
          if (response.status === 404) throw new Error('此主机尚未支持 token 统计，请更新 Kode 服务。')
          const value = await response.json()
          if (!response.ok) throw new Error(value.error ?? '读取 token 统计失败，请重试。')
          return value
        }
        const meter = followRange ? await read(bucketPeriod, range?.since, range?.until) : await read(tokenPeriod)
        const snapshot = open && !followRange && (period !== tokenPeriod || range) ? await read(bucketPeriod, range?.since, range?.until) : meter
        if (alive) setResult({ host, meter, tokenPeriod, snapshot, range: open || followRange ? range : null, period: open || followRange ? period : tokenPeriod })
      } catch (error) { if (alive && !controller.signal.aborted) setError(error.message) }
      finally { pending = false; if (alive) setLoading(false) }
    }
    void load()
    const timer = setInterval(load, 30000), wake = () => { void load() }
    document.addEventListener('visibilitychange', wake)
    nativeWindow?.document.addEventListener('visibilitychange', wake)
    nativeWindow?.addEventListener('focus', wake)
    return () => {
      alive = false; controller.abort(); clearInterval(timer)
      document.removeEventListener('visibilitychange', wake)
      nativeWindow?.document.removeEventListener('visibilitychange', wake)
      nativeWindow?.removeEventListener('focus', wake)
    }
  }, [enabled, host, transport, tokenPeriod, period, bucketPeriod, range, open, refresh, nativeWindow])
  react.useEffect(() => {
    if (!open) return
    const dismiss = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const snapshot = current?.period === period && current?.range === range ? current.snapshot : null
  const rangeEnd = range?.until ?? snapshot?.until_ms ?? Date.now()
  const rangeStart = range?.since ?? usageDefaultStart(snapshot, bucketPeriod, rangeEnd)
  const view = usageView(snapshot, bucketPeriod, dimension, selected, new Date(rangeEnd), rangeStart), { totals, rows, timeline } = view
  const unit = bucketPeriod === 'today' ? '小时' : bucketPeriod === 'month' ? '天' : '月'
  const formatTime = value => new Date(value).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const startLabel = formatTime(rangeStart), endLabel = formatTime(rangeEnd)
  const rangeLabel = `${startLabel} — ${endLabel} · 按${unit}`
  const startInput = rangeInputs.start ?? usageDateTime(rangeStart), endInput = rangeInputs.end ?? usageDateTime(rangeEnd)
  const startValue = new Date(startInput).getTime(), endValue = new Date(endInput).getTime()
  const rangeValid = Number.isFinite(startValue) && Number.isFinite(endValue) && startValue >= 0 && startValue <= endValue && endValue <= Date.now()
  const changeRange = (edge, value) => {
    const next = { start: startInput, end: endInput, [edge]: value }
    setRangeInputs(next)
    const since = new Date(next.start).getTime(), until = new Date(next.end).getTime()
    if (Number.isFinite(since) && Number.isFinite(until) && since >= 0 && since <= until && until <= Date.now()) {
      setRange({ since, until }); setPeriod('custom')
    }
  }
  const toggle = key => setSelected(prior => {
    const next = new Set(prior ?? view.groups.map(row => row.key))
    if (next.has(key)) next.delete(key); else next.add(key)
    return [...next]
  })
  const exact = value => Number.isFinite(value) ? value.toLocaleString() : '—'
  const content = h('div', { className: 'kode-token-rail', ref: root, onKeyDown: event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  } },
    h('button', { type: 'button', ref: trigger, className: 'kode-token-notch', 'aria-expanded': open, 'aria-controls': panelId, onClick: () => setOpen(!open), title: `当前主机的${tokenPeriodLabel} CLI 历史 token 用量`, 'aria-label': `${status.label}；${tokenPeriodLabel} tokens：${usageNumber(meter?.totals?.total_tokens)}` },
      h('span', { className: 'kode-island-host' }, h('i', { 'data-state': status.state, role: 'img', 'aria-label': status.label, title: status.label }), h('span', { className: 'kode-island-name' }, host === 'local' ? 'Kode' : '远端')), h('span', { className: 'kode-island-usage' }, h('strong', null, usageNumber(meter?.totals?.total_tokens)), h('span', { className: 'kode-island-period-label' }, `${tokenPeriodLabel} tokens`)),
      h(IconChevronDownOutlineRegular, { size: 12, style: { transform: open ? 'rotate(180deg)' : undefined } })),
    present && h('section', { id: panelId, className: 'kode-token-panel', 'data-open': open, inert: !open ? '' : undefined, 'aria-hidden': !open || undefined, 'aria-label': 'Token 用量', 'aria-busy': loading },
      h('header', null, h('div', null, h('strong', null, 'Token 用量'), h('p', null, `${host === 'local' ? '本机' : host} · CLI 历史统计`)),
        h('button', { type: 'button', className: 'kode-token-close', 'aria-label': '收起 token 统计', onClick: () => { setOpen(false); trigger.current?.focus() } }, h(IconCloseOutlineRegular, { size: 16 }))),
      h('div', { className: 'kode-token-periods', role: 'group', 'aria-label': '统计范围' }, ...[['today', '今天'], ['month', '本月'], ['all', '全部']].map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': period === id, onClick: () => { setPeriod(id); setRange(null); setRangeInputs({ start: null, end: null }); setSelected(null) } }, label))),
      h('div', { className: 'kode-token-start', role: 'group', 'aria-label': '统计时间范围' },
        ...[['start', '开始时间', startInput], ['end', '结束时间', endInput]].map(([edge, label, value]) => h('label', { key: edge }, label,
          h('input', { type: 'datetime-local', step: 1, value, onChange: event => changeRange(edge, event.target.value), 'aria-label': label, 'aria-invalid': !rangeValid || undefined }))),
        !rangeValid && h('span', { role: 'alert', className: 'kode-token-error' }, '开始时间不能晚于结束时间，结束时间不能晚于当前时间。')),
      error ? h('p', { role: 'alert', className: 'kode-token-error' }, error, ' ', h('button', { type: 'button', onClick: () => setRefresh(value => value + 1) }, '重试')) : !snapshot ? h('p', { role: 'status' }, '正在读取 CLI 历史…') : h(react.Fragment, null,
        h('dl', { className: 'kode-token-totals' }, ...[['总计', 'total_tokens'], ['输入', 'input_tokens'], ['输出', 'output_tokens'], ['缓存', 'cached_tokens']].map(([label, key]) => h('div', { key }, h('dt', null, label), h('dd', { title: exact(totals?.[key]) }, usageNumber(totals?.[key]))))),
        ...(snapshot.warnings ?? []).map((warning, i) => h('p', { key: i, className: 'kode-token-error' }, warning)),
        h('div', { className: 'kode-token-dimensions', role: 'group', 'aria-label': '统计维度' }, ...[['backend', 'Agent'], ['model', '模型']].map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': dimension === id, onClick: () => { setDimension(id); setSelected(null) } }, label)), h('button', { type: 'button', className: 'kode-token-select-all', onClick: () => setSelected(null) }, '全选')),
        view.groups.length > 0 && h('div', { className: 'kode-token-filters', role: 'group', 'aria-label': `选择${dimension === 'model' ? '模型' : ' Agent'}，支持多选` }, ...view.groups.map(group => h('button', { key: group.key, type: 'button', 'aria-pressed': selected === null || selected.includes(group.key), onClick: () => toggle(group.key), title: `${group.key} · ${exact(group.total_tokens)} tokens` }, h('i', { style: { background: group.color }, 'aria-hidden': true }), h('span', null, group.key), h('strong', null, usageNumber(group.total_tokens))))),
        snapshot.timeline ? h('div', { className: 'kode-token-visuals' },
          h('section', { className: 'kode-token-stack' }, h('h3', null, rangeLabel), h('div', { className: 'kode-token-scale' }, h('span', null, usageNumber(view.max)), h('span', null, 'tokens')),
            h('svg', { viewBox: '0 0 560 112', role: 'img', 'aria-label': `${rangeLabel}，按${dimension === 'model' ? '模型' : 'Agent'}堆积面积折线用量` },
              ...[12, 56, 100].map(y => h('path', { key: y, d: `M0 ${y}H560`, className: 'kode-token-axis' })),
              ...usageAreaPaths(view).flatMap(layer => [
                h('path', { key: `${layer.key}:area`, d: layer.area, fill: layer.color, fillOpacity: .42 }, h('title', null, layer.key)),
                h('path', { key: `${layer.key}:line`, d: layer.line, fill: 'none', stroke: layer.color, strokeWidth: 1.8, vectorEffect: 'non-scaling-stroke' }),
              ]),
              ...timeline.map((bucket, index) => h('rect', { key: bucket.key, x: Math.max(0, (index - .5) * 560 / Math.max(1, timeline.length - 1)), y: 0, width: timeline.length === 1 ? 560 : (index === 0 || index === timeline.length - 1 ? 280 : 560) / (timeline.length - 1), height: 112, tabIndex: 0, 'aria-label': `${bucket.key}，${exact(bucket.total)} tokens`, fill: 'transparent' }, h('title', null, `${bucket.key} · 合计 ${exact(bucket.total)} tokens\n${bucket.layers.map(layer => `${layer.key} ${exact(layer.value)}`).join('\n')}`)))),
            h('div', { className: 'kode-token-chart-labels' }, h('span', null, startLabel), h('span', null, endLabel))),
          h('section', { className: 'kode-token-heat' }, h('h3', null, `所选范围每${unit}活跃度`), h('div', { className: 'kode-token-activity', 'data-period': period }, ...timeline.map(bucket => h('span', { key: bucket.key, title: `${bucket.key} · ${exact(bucket.total)} tokens`, 'aria-label': `${bucket.key}: ${exact(bucket.total)} tokens`, 'data-level': bucket.total ? Math.max(1, Math.ceil(bucket.total / view.max * 4)) : 0 }, bucketPeriod === 'today' ? bucket.key.slice(11, 13) : bucketPeriod === 'month' ? bucket.key.slice(5) : bucket.key.slice(2)))))) : h('p', { className: 'kode-token-error', role: 'status' }, '此主机需更新 Kode 服务后才能显示分维度堆积统计。'),
        rows.length === 0 ? h('p', { className: 'kode-token-empty' }, selected?.length === 0 ? '未选择统计项，请选择 Agent 或模型。' : '这个时间段暂无 CLI 用量记录。') : h('div', { className: 'kode-token-table-scroll' }, h('table', null,
          h('thead', null, h('tr', null, ...[dimension === 'model' ? '模型' : 'Agent', '输入', '输出', 'Token 总计'].map(label => h('th', { key: label, scope: 'col' }, label)))),
          h('tbody', null, ...rows.map((row, index) => h('tr', { key: row.key }, h('th', { scope: 'row' }, h('span', null, row.key)), ...['input_tokens', 'output_tokens', 'total_tokens'].map(key => h('td', { key, title: exact(row[key]) }, usageNumber(row[key])))))))),
        h('p', { className: 'kode-token-model-note' }, '图表、活跃度与明细使用同一筛选 · 悬停查看完整 token 数')),
      h('footer', null, '每 30 秒更新 · CLI 历史统计，不等同于当前对话上下文占用')))
  return !enabled ? null : nativeWindow ? react_dom.createPortal(content, nativeWindow.document.body) : content
}
function installWorkbenchUi(ctx) {
  kodeWorkbenchContext = ctx
  relocateWorkbenchJobs(ctx)
  ctx.inject(['kodeActivity', 'kodeInterface'], scope => scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'kode-token-island', order: 10, inject: () => ({ activity: scope.get('kodeActivity'), appearance: scope.get('kodeInterface') }) }, KodeTokenIsland)))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.kodeWorkbench = ''
    style.textContent = `.kode-token-rail{--island-green:#88e5b2;--island-cyan:#78cef2;--island-text:#f5f5f7;--island-muted:#a4a8b0;--island-line:#292d32;position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:220;display:flex;justify-content:center;pointer-events:none;width:min(620px,calc(100vw - 24px));height:0;color-scheme:dark;-webkit-app-region:no-drag}.kode-token-notch{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:18px;width:min(250px,calc(100vw - 152px));height:34px;padding:0 13px;border:0;border-radius:0 0 16px 16px;background:#050608;color:var(--island-text);font:inherit;font-size:11px;cursor:pointer;pointer-events:auto;box-shadow:0 3px 8px #0002;font-variant-numeric:tabular-nums;transition:height 180ms cubic-bezier(.2,.78,.22,1),background 120ms}.kode-island-host{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#d7dbe2;font-weight:500}.kode-island-host i{width:6px;height:6px;border-radius:50%;background:#858c98}.kode-island-host i[data-state=ongoing]{background:#5b8def}.kode-island-host i[data-state=done]{background:#65c799}.kode-island-host i[data-state=awaiting]{background:#f0bd55}.kode-island-usage{display:flex;align-items:baseline;gap:6px;min-width:0;margin-left:auto;white-space:nowrap}.kode-island-usage strong{color:var(--island-green);font-size:13px;font-weight:650}.kode-island-usage>span{color:var(--island-muted);font-size:9px}.kode-token-notch>svg{color:var(--island-muted);flex-shrink:0}.kode-token-notch:hover{height:38px;background:#111418}.kode-token-notch:focus-visible,.kode-token-panel button:focus-visible{outline:2px solid var(--island-cyan);outline-offset:3px}.kode-token-panel{box-sizing:border-box;position:absolute;top:0;left:0;width:100%;max-height:calc(100dvh - 24px);overflow:auto;padding:52px 22px 18px;border:1px solid var(--island-line);border-top:0;border-radius:0 0 22px 22px;background:#090b0e;color:var(--island-text);box-shadow:0 12px 36px #0006;pointer-events:auto;font-size:13px;scrollbar-width:thin;scrollbar-color:#41464e transparent;transform-origin:50% 0;animation:kode-island-unfold 340ms cubic-bezier(.2,.78,.22,1) both;font-variant-numeric:tabular-nums}.kode-token-panel[data-open=false]{pointer-events:none;animation:kode-island-fold 280ms cubic-bezier(.45,0,.75,.2) both}.kode-token-panel::selection{background:#285248;color:#fff}.kode-token-panel header{display:flex;align-items:start;justify-content:space-between;gap:16px}.kode-token-panel header strong{font-size:17px;font-weight:600;letter-spacing:-.02em}.kode-token-panel header p{font-size:11px;color:var(--island-muted);margin:6px 0 0;overflow-wrap:anywhere}.kode-token-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--island-muted);cursor:pointer}.kode-token-close:hover{color:var(--island-text);background:#1c2026}.kode-token-periods{display:inline-flex;gap:3px;margin:18px 0 14px;padding:3px;border:1px solid var(--island-line);border-radius:9px;background:#0e1115}.kode-token-periods button{padding:5px 13px;border:0;border-radius:6px;background:transparent;color:var(--island-muted);font:inherit;font-size:12px;cursor:pointer}.kode-token-periods button:hover{color:var(--island-text)}.kode-token-periods button[aria-pressed=true]{color:var(--island-text);background:#262b32;box-shadow:0 1px 3px #0004}.kode-token-totals{display:grid;grid-template-columns:1.3fr repeat(3,minmax(0,1fr));margin:0 0 14px;border:1px solid var(--island-line);border-radius:12px;background:#111419;overflow:hidden}.kode-token-totals>div{padding:12px 14px;border-right:1px solid var(--island-line);min-width:0}.kode-token-totals>div:last-child{border:0}.kode-token-totals dt{font-size:11px;color:var(--island-muted)}.kode-token-totals dd{margin:7px 0 0;font-size:17px;font-weight:550;white-space:nowrap}.kode-token-totals>div:first-child dd{color:var(--island-green);font-size:22px;font-weight:650;letter-spacing:-.03em}.kode-token-backends{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 18px}.kode-token-backends>span{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--island-line);border-radius:8px;background:#13171d;padding:6px 9px;font-size:11px}.kode-token-backends i{width:5px;height:5px;border-radius:50%;background:var(--island-cyan)}.kode-token-backends [data-backend=codex] i{background:#bdabff}.kode-token-backends [data-backend=claude] i{background:#e6a58b}.kode-token-backends [data-backend=codebuddy] i{background:#78b8ff}.kode-token-backends strong{font-weight:550;margin-left:5px}.kode-token-visuals{display:grid;grid-template-columns:1.15fr 1fr;gap:22px;margin-bottom:18px;padding:0 0 16px;border-bottom:1px solid var(--island-line)}.kode-token-visuals section{min-width:0}.kode-token-visuals h3{margin:0 0 10px;color:var(--island-muted);font-size:10px;font-weight:500}.kode-token-trend svg{display:block;width:100%;height:60px;overflow:visible}.kode-token-axis{stroke:var(--island-line);fill:none}.kode-token-trend polygon{fill:#78cef215}.kode-token-trend polyline{stroke:var(--island-cyan);stroke-width:1.5;fill:none;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.kode-token-trend>div{display:flex;justify-content:space-between;margin-top:5px;font-size:9px;color:var(--island-muted)}.kode-token-days{display:grid;grid-template-rows:repeat(7,7px);grid-auto-flow:column;grid-auto-columns:7px;justify-content:space-between;gap:2px}.kode-token-days span{width:7px;height:7px;border-radius:2px;background:#20272b}.kode-token-days [data-level="1"]{background:#254a3b}.kode-token-days [data-level="2"]{background:#3e7c5c}.kode-token-days [data-level="3"]{background:#62b885}.kode-token-days [data-level="4"]{background:var(--island-green)}.kode-token-table-scroll{overflow-x:auto;max-height:260px;scrollbar-width:thin}.kode-token-panel table{width:100%;border-collapse:collapse;text-align:right;font-size:11px}.kode-token-panel th,.kode-token-panel td{padding:10px 6px;border-bottom:1px solid var(--island-line);white-space:nowrap;font-weight:400}.kode-token-panel th:first-child{text-align:left;max-width:225px;overflow:hidden;text-overflow:ellipsis;color:var(--island-text)}.kode-token-panel thead{position:sticky;top:0;background:#090b0e;color:var(--island-muted);font-size:10px}.kode-token-panel th small{display:block;margin-top:4px;color:var(--island-muted);font-size:10px}.kode-token-panel tbody td:last-child{color:var(--island-green);font-weight:550}.kode-token-model-note{font-size:10px;color:var(--island-muted);margin:10px 0 0}.kode-token-panel footer{padding-top:14px;font-size:10px;line-height:1.6;color:var(--island-muted)}.kode-token-empty{padding:20px 0;color:var(--island-muted)}.kode-token-error{color:#ffaaa6;line-height:1.6}.kode-token-error button{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.kode-background-tasks{box-sizing:border-box;display:flex;align-items:center;flex:none;min-width:0;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,calc(var(--dsh-chat-content-width,748px) + 32px));margin:0 auto;padding:4px 0 8px}.kode-background-tasks>div{max-width:100%}.kode-background-tasks button{font:inherit;font-size:12px}@keyframes kode-island-unfold{from{opacity:0;transform:scale(.44,.06);border-radius:0 0 16px 16px}70%{opacity:1;transform:scale(1.008,1.012)}to{opacity:1;transform:scale(1)}}@keyframes kode-island-fold{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.44,.06);border-radius:0 0 16px 16px}}@media(prefers-reduced-motion:reduce){.kode-token-panel,.kode-token-panel[data-open=false]{animation:none}.kode-token-notch{transition:none}}@media(max-width:480px){.kode-token-notch{width:200px;height:32px}.kode-token-panel{padding:48px 16px 16px}.kode-token-totals{grid-template-columns:repeat(2,minmax(0,1fr))}.kode-token-totals>div:nth-child(2){border-right:0}.kode-token-totals>div:nth-child(-n+2){border-bottom:1px solid var(--island-line)}.kode-token-visuals{grid-template-columns:1fr}.kode-token-days{grid-auto-columns:10px;grid-template-rows:repeat(7,10px);justify-content:start;gap:3px}.kode-token-days span{width:10px;height:10px}.kode-token-panel th:first-child{max-width:130px}}
`
    style.textContent += `
.kode-token-dimensions{display:flex;align-items:center;gap:4px;margin:4px 0 10px}.kode-token-dimensions button,.kode-token-filters button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--island-line);border-radius:7px;background:#13171d;color:var(--island-muted);padding:6px 10px}.kode-token-dimensions button[aria-pressed=true]{color:var(--island-green);background:#1c3028;border-color:#486c59}.kode-token-dimensions .kode-token-select-all{margin-left:auto;border-color:transparent;background:transparent}.kode-token-filters{display:flex;flex-wrap:wrap;gap:6px;max-height:132px;overflow:auto;margin-bottom:18px;padding:2px}.kode-token-filters button{display:flex;align-items:center;gap:7px;max-width:100%;opacity:.5}.kode-token-filters button[aria-pressed=true]{color:var(--island-text);opacity:1;border-color:#555e6a}.kode-token-filters button:hover{background:#242b33;opacity:1}.kode-token-filters button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-token-filters i{width:8px;height:8px;border-radius:2px;flex-shrink:0}.kode-token-filters strong{font-size:11px;font-weight:500;color:var(--island-muted)}.kode-token-visuals{grid-template-columns:minmax(0,1fr);gap:18px}.kode-token-stack svg{display:block;width:100%;height:112px}.kode-token-stack svg{overflow:hidden}.kode-token-start{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8px;margin:12px 0 18px}.kode-token-start label{flex:1;min-width:0;display:grid;gap:5px;font-size:11px;color:var(--island-muted)}.kode-token-start input{width:100%;min-width:0;min-height:32px;border:1px solid #48515d;border-radius:7px;background:#171c23;color:var(--island-text);font:inherit;font-size:12px;padding:4px 8px}.kode-token-start button{cursor:pointer}.kode-token-start button:disabled{opacity:.45;cursor:default}.kode-token-start button[aria-pressed=true]{border-color:var(--island-green);color:var(--island-green)}.kode-token-start input:focus-visible,.kode-token-start button:focus-visible{outline:2px solid var(--island-cyan);outline-offset:2px}.kode-token-scale,.kode-token-chart-labels{display:flex;justify-content:space-between;color:var(--island-muted);font-size:10px;margin:4px 0}.kode-token-activity{display:flex;flex-wrap:wrap;gap:4px;max-height:100px;overflow:auto}.kode-token-activity span{display:grid;place-items:center;min-width:24px;height:22px;padding:0 3px;border-radius:4px;background:#20272b;color:var(--island-muted);font-size:9px;font-variant-numeric:tabular-nums}.kode-token-activity [data-level="1"]{background:#254a3b;color:#d1f4df}.kode-token-activity [data-level="2"]{background:#356348;color:#e0ffe9}.kode-token-activity [data-level="3"]{background:#62b885;color:#07150d}.kode-token-activity [data-level="4"]{background:var(--island-green);color:#07150d}
`
    document.head.append(style)
    return () => { style.remove(); if (kodeWorkbenchContext === ctx) kodeWorkbenchContext = undefined }
  }, 'kode.workbench-ui')
}
