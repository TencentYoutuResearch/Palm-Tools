/** Workbench status: CLI usage in the chat's top edge; jobs beside the composer.
 * The native job component retains its subscriptions, locale, output and kill UI. */
let kodeWorkbenchContext
function relocateWorkbenchJobs(ctx) {
  const sourceSeat = 'conversation.session.header.actions', targetSeat = 'conversation.input.dock'
  ctx.slots.inject(sourceSeat, () => {
    const moved = new Map()
    const install = () => {
      for (const entry of ctx.slots.entries(sourceSeat)) {
        if (entry.options.id !== 'job-list' || moved.has(entry)) continue
        const native = entry.component, hidden = () => null
        const DockJobs = props => react.createElement('div', { className: 'kode-background-tasks' }, react.createElement(native, props))
        const dispose = ctx.slots.register({ ...entry.options, name: targetSeat, order: 20 }, DockJobs)
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
function KodeTokenIsland() {
  const h = react.createElement, { IconChevronDownOutlineRegular, IconCloseOutlineRegular } = _deepseek_ai_dsh_client_ui_primitives
  const ctx = kodeWorkbenchContext, transport = ctx?.get('kodeTransport')
  const host = react.useSyncExternalStore(react.useCallback(fn => transport?.subscribe(fn) ?? (() => {}), [transport]), () => transport?.current ?? 'local')
  const [open, setOpen] = react.useState(false), [period, setPeriod] = react.useState('today')
  const [result, setResult] = react.useState(null), [error, setError] = react.useState(''), [loading, setLoading] = react.useState(false), [refresh, setRefresh] = react.useState(0)
  const root = react.useRef(null), trigger = react.useRef(null), panelId = react.useId()
  const current = result?.host === host ? result : null
  react.useEffect(() => {
    let alive = true, pending = false
    const controller = new AbortController()
    const load = async () => {
      if (pending || document.hidden) return
      pending = true; setLoading(true); setError('')
      try {
        const read = async period => {
          const path = `/api/kode/model-usage?period=${period}&timezone_offset_minutes=${-new Date().getTimezoneOffset()}`
          const options = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }
          const response = await (transport ? transport.fetch(path, options, host) : fetch(path, options))
          if (response.status === 404) throw new Error('此主机尚未支持 token 统计，请更新 Kode 服务。')
          const value = await response.json()
          if (!response.ok) throw new Error(value.error ?? '读取 token 统计失败，请重试。')
          return value
        }
        const today = await read('today'), snapshot = open && period !== 'today' ? await read(period) : today
        if (alive) setResult({ host, today, snapshot, period: open ? period : 'today' })
      } catch (error) { if (alive && !controller.signal.aborted) setError(error.message) }
      finally { pending = false; if (alive) setLoading(false) }
    }
    void load()
    const timer = setInterval(load, 30000), wake = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', wake)
    return () => { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', wake) }
  }, [host, transport, period, open, refresh])
  react.useEffect(() => {
    if (!open) return
    const dismiss = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const snapshot = current?.period === period ? current.snapshot : null
  const totals = snapshot?.totals, rows = usageTableRows(snapshot)
  const dailyMax = Math.max(1, ...(snapshot?.daily ?? []).map(day => day.total_tokens))
  const exact = value => Number.isFinite(value) ? value.toLocaleString() : '—'
  return h('div', { className: 'kode-token-rail', ref: root, onKeyDown: event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  } },
    h('button', { type: 'button', ref: trigger, className: 'kode-token-notch', 'aria-expanded': open, 'aria-controls': panelId, onClick: () => setOpen(!open), title: '当前主机的 CLI 历史 token 用量' },
      h('span', null, '今日'), h('strong', null, usageNumber(current?.today?.totals?.total_tokens)), h('span', null, 'tokens'),
      h(IconChevronDownOutlineRegular, { size: 12, style: { transform: open ? 'rotate(180deg)' : undefined } })),
    open && h('section', { id: panelId, className: 'kode-token-panel', 'aria-label': 'Token 用量', 'aria-busy': loading },
      h('header', null, h('div', null, h('strong', null, 'Token 用量'), h('p', null, `${host === 'local' ? '本机' : host} · CLI 历史统计`)),
        h('button', { type: 'button', className: 'kode-token-close', 'aria-label': '收起 token 统计', onClick: () => { setOpen(false); trigger.current?.focus() } }, h(IconCloseOutlineRegular, { size: 16 }))),
      h('div', { className: 'kode-token-periods', role: 'group', 'aria-label': '统计范围' }, ...[['today', '今天'], ['month', '本月'], ['all', '全部']].map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': period === id, onClick: () => setPeriod(id) }, label))),
      error ? h('p', { role: 'alert', className: 'kode-token-error' }, error, ' ', h('button', { type: 'button', onClick: () => setRefresh(value => value + 1) }, '重试')) : !snapshot ? h('p', { role: 'status' }, '正在读取 CLI 历史…') : h(react.Fragment, null,
        h('dl', { className: 'kode-token-totals' }, ...[['总计', 'total_tokens'], ['输入', 'input_tokens'], ['输出', 'output_tokens'], ['缓存', 'cached_tokens']].map(([label, key]) => h('div', { key }, h('dt', null, label), h('dd', { title: exact(totals?.[key]) }, usageNumber(totals?.[key]))))),
        ...(snapshot.warnings ?? []).map((warning, i) => h('p', { key: i, className: 'kode-token-error' }, warning)),
        rows.length === 0 ? h('p', { className: 'kode-token-empty' }, '这个时间段暂无 CLI 用量记录。') : h('div', { className: 'kode-token-table-scroll' }, h('table', null,
          h('thead', null, h('tr', null, ...['Agent / 模型', '输入', '输出', 'Token 总计'].map(label => h('th', { key: label, scope: 'col' }, label)))),
          h('tbody', null, ...rows.map((row, index) => h('tr', { key: `${row.source}:${row.backend}:${row.model}:${index}` }, h('th', { scope: 'row' }, h('span', null, row.model), h('small', null, row.backend)), ...['input_tokens', 'output_tokens', 'total_tokens'].map(key => h('td', { key, title: exact(row[key]) }, usageNumber(row[key])))))))),
        snapshot.daily?.length > 0 && h('details', { className: 'kode-token-daily' }, h('summary', null, '每日用量 · 最近 12 周'), h('div', { className: 'kode-token-days' }, ...snapshot.daily.map(day => h('span', { key: day.date, title: `${day.date} · ${exact(day.total_tokens)} tokens`, 'aria-label': `${day.date}: ${exact(day.total_tokens)} tokens`, style: { opacity: day.total_tokens > 0 ? .3 + .7 * Math.sqrt(day.total_tokens / dailyMax) : .12 } }))))),
      h('footer', null, '每 30 秒更新 · CLI 历史统计，不等同于当前对话上下文占用')))
}
function installWorkbenchUi(ctx) {
  kodeWorkbenchContext = ctx
  relocateWorkbenchJobs(ctx)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `.kode-token-rail{position:relative;flex:none;display:flex;justify-content:center;z-index:25;min-width:0;height:28px}.kode-token-notch{display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;height:26px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-top:0;border-radius:0 0 12px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;font-variant-numeric:tabular-nums}.kode-token-notch strong{font-weight:600;color:var(--dsw-alias-label-primary)}.kode-token-notch:hover,.kode-token-notch[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.kode-token-notch:focus-visible,.kode-token-panel button:focus-visible,.kode-token-panel summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}.kode-token-panel{position:absolute;top:30px;box-sizing:border-box;width:min(600px,calc(100% - 24px));max-height:min(600px,70vh);overflow:auto;padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px #0002;font-size:13px;scrollbar-width:thin}.kode-token-panel header{display:flex;justify-content:space-between;gap:16px;align-items:start}.kode-token-panel header p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}.kode-token-close{border:0;background:transparent;color:inherit;cursor:pointer;display:grid;place-items:center;width:28px;height:28px;border-radius:var(--dsw-radius-sm)}.kode-token-close:hover{background:var(--dsw-alias-interactive-bg-hover)}.kode-token-periods{display:flex;gap:4px;margin:16px 0}.kode-token-periods button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:6px 12px;border-radius:var(--dsw-radius-sm);cursor:pointer}.kode-token-periods button:hover,.kode-token-periods button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.kode-token-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 16px}.kode-token-totals dt{color:var(--dsw-alias-label-secondary);font-size:12px}.kode-token-totals dd{margin:4px 0 0;font-size:18px;font-weight:500;font-variant-numeric:tabular-nums}.kode-token-table-scroll{overflow-x:auto;scrollbar-width:thin}.kode-token-panel table{width:100%;border-collapse:collapse;text-align:right;font-variant-numeric:tabular-nums}.kode-token-panel th,.kode-token-panel td{padding:9px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;font-weight:400}.kode-token-panel th:first-child{text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis}.kode-token-panel th small{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}.kode-token-panel thead{font-size:11px;color:var(--dsw-alias-label-secondary)}.kode-token-panel footer{margin-top:16px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}.kode-token-empty{padding:12px 0;color:var(--dsw-alias-label-secondary)}.kode-token-error{color:var(--dsw-alias-state-error-primary);line-height:1.6}.kode-token-error button{font:inherit;color:inherit;cursor:pointer;border:0;background:transparent;text-decoration:underline;text-underline-offset:3px}.kode-token-daily{margin-top:16px;font-size:12px}.kode-token-daily summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.kode-token-days{display:grid;grid-template-columns:repeat(28,minmax(0,1fr));gap:3px;margin-top:10px}.kode-token-days span{aspect-ratio:1;background:var(--dsw-alias-label-primary);border-radius:2px}.kode-background-tasks{display:flex;align-items:center;min-width:0;padding:4px 6px 8px}.kode-background-tasks>div{max-width:100%}.kode-background-tasks button{font:inherit;font-size:12px}@media(max-width:480px){.kode-token-panel{padding:14px}.kode-token-totals{grid-template-columns:repeat(2,minmax(0,1fr))}.kode-token-panel th:first-child{max-width:130px}.kode-token-close{width:36px;height:36px}}`
    document.head.append(style)
    return () => { style.remove(); if (kodeWorkbenchContext === ctx) kodeWorkbenchContext = undefined }
  }, 'kode.workbench-ui')
}
