/** Workbench status: one application-wide token island; jobs beside the composer.
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
  const [open, setOpen] = react.useState(false), [present, setPresent] = react.useState(false), [period, setPeriod] = react.useState('today')
  const [result, setResult] = react.useState(null), [error, setError] = react.useState(''), [loading, setLoading] = react.useState(false), [refresh, setRefresh] = react.useState(0)
  const root = react.useRef(null), trigger = react.useRef(null), panelId = react.useId()
  const current = result?.host === host ? result : null
  react.useEffect(() => {
    if (open) { setPresent(true); return }
    const timer = setTimeout(() => setPresent(false), 280)
    return () => clearTimeout(timer)
  }, [open])
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
  const trend = (snapshot?.daily ?? []).slice(-30), trendMax = Math.max(1, ...trend.map(day => day.total_tokens))
  const points = trend.map((day, i) => `${i * 280 / Math.max(1, trend.length - 1)},${52 - day.total_tokens / trendMax * 44}`).join(' ')
  const backendTotals = new Map()
  for (const row of rows) backendTotals.set(row.backend, (backendTotals.get(row.backend) ?? 0) + row.total_tokens)
  const exact = value => Number.isFinite(value) ? value.toLocaleString() : '—'
  return h('div', { className: 'kode-token-rail', ref: root, onKeyDown: event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  } },
    h('button', { type: 'button', ref: trigger, className: 'kode-token-notch', 'aria-expanded': open, 'aria-controls': panelId, onClick: () => setOpen(!open), title: '当前主机的 CLI 历史 token 用量' },
      h('span', { className: 'kode-island-host' }, h('i', { 'aria-hidden': true }), host === 'local' ? 'Kode' : '远端'), h('span', { className: 'kode-island-usage' }, h('strong', null, usageNumber(current?.today?.totals?.total_tokens)), h('span', null, '今日 tokens')),
      h(IconChevronDownOutlineRegular, { size: 12, style: { transform: open ? 'rotate(180deg)' : undefined } })),
    present && h('section', { id: panelId, className: 'kode-token-panel', 'data-open': open, inert: !open ? '' : undefined, 'aria-hidden': !open || undefined, 'aria-label': 'Token 用量', 'aria-busy': loading },
      h('header', null, h('div', null, h('strong', null, 'Token 用量'), h('p', null, `${host === 'local' ? '本机' : host} · CLI 历史统计`)),
        h('button', { type: 'button', className: 'kode-token-close', 'aria-label': '收起 token 统计', onClick: () => { setOpen(false); trigger.current?.focus() } }, h(IconCloseOutlineRegular, { size: 16 }))),
      h('div', { className: 'kode-token-periods', role: 'group', 'aria-label': '统计范围' }, ...[['today', '今天'], ['month', '本月'], ['all', '全部']].map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': period === id, onClick: () => setPeriod(id) }, label))),
      error ? h('p', { role: 'alert', className: 'kode-token-error' }, error, ' ', h('button', { type: 'button', onClick: () => setRefresh(value => value + 1) }, '重试')) : !snapshot ? h('p', { role: 'status' }, '正在读取 CLI 历史…') : h(react.Fragment, null,
        h('dl', { className: 'kode-token-totals' }, ...[['总计', 'total_tokens'], ['输入', 'input_tokens'], ['输出', 'output_tokens'], ['缓存', 'cached_tokens']].map(([label, key]) => h('div', { key }, h('dt', null, label), h('dd', { title: exact(totals?.[key]) }, usageNumber(totals?.[key]))))),
        ...(snapshot.warnings ?? []).map((warning, i) => h('p', { key: i, className: 'kode-token-error' }, warning)),
        backendTotals.size > 0 && h('div', { className: 'kode-token-backends', 'aria-label': '按 Agent 汇总' }, ...[...backendTotals].map(([backend, total]) => h('span', { key: backend, 'data-backend': backend }, h('i', { 'aria-hidden': true }), h('span', null, backend), h('strong', null, usageNumber(total))))),
        trend.length > 0 && h('div', { className: 'kode-token-visuals' },
          h('section', { className: 'kode-token-trend' }, h('h3', null, '近 30 天用量'), h('svg', { viewBox: '0 0 280 56', role: 'img', 'aria-label': '最近三十天 token 用量曲线' }, h('path', { d: 'M0 52H280', className: 'kode-token-axis' }), h('polygon', { points: `0,52 ${points} 280,52` }), h('polyline', { points })), h('div', null, h('span', null, trend[0]?.date.slice(5)), h('span', null, trend.at(-1)?.date.slice(5)))),
          h('section', { className: 'kode-token-heat' }, h('h3', null, '近 12 周活跃度'), h('div', { className: 'kode-token-days' }, ...(snapshot?.daily ?? []).map(day => h('span', { key: day.date, title: `${day.date} · ${exact(day.total_tokens)} tokens`, 'aria-label': `${day.date}: ${exact(day.total_tokens)} tokens`, 'data-level': day.total_tokens ? Math.max(1, Math.ceil(day.total_tokens / dailyMax * 4)) : 0 }))))),
        rows.length === 0 ? h('p', { className: 'kode-token-empty' }, '这个时间段暂无 CLI 用量记录。') : h('div', { className: 'kode-token-table-scroll' }, h('table', null,
          h('thead', null, h('tr', null, ...['Agent / 模型', '输入', '输出', 'Token 总计'].map(label => h('th', { key: label, scope: 'col' }, label)))),
          h('tbody', null, ...rows.map((row, index) => h('tr', { key: `${row.source}:${row.backend}:${row.model}:${index}` }, h('th', { scope: 'row' }, h('span', null, row.model), h('small', null, row.backend)), ...['input_tokens', 'output_tokens', 'total_tokens'].map(key => h('td', { key, title: exact(row[key]) }, usageNumber(row[key])))))))),
        h('p', { className: 'kode-token-model-note' }, '模型用量明细 · 数值悬停可查看完整 token 数')),
      h('footer', null, '每 30 秒更新 · CLI 历史统计，不等同于当前对话上下文占用')))
}
function installWorkbenchUi(ctx) {
  kodeWorkbenchContext = ctx
  relocateWorkbenchJobs(ctx)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kode-token-island', order: 10 }, KodeTokenIsland))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `.kode-token-rail{--island-green:#88e5b2;--island-cyan:#78cef2;--island-text:#f5f5f7;--island-muted:#a4a8b0;--island-line:#292d32;position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:220;display:flex;justify-content:center;pointer-events:none;width:min(620px,calc(100vw - 24px));height:0;color-scheme:dark;-webkit-app-region:no-drag}.kode-token-notch{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:18px;width:min(250px,calc(100vw - 152px));height:34px;padding:0 13px;border:0;border-radius:0 0 16px 16px;background:#050608;color:var(--island-text);font:inherit;font-size:11px;cursor:pointer;pointer-events:auto;box-shadow:0 3px 8px #0002;font-variant-numeric:tabular-nums;transition:height 180ms cubic-bezier(.2,.78,.22,1),background 120ms}.kode-island-host{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#d7dbe2;font-weight:500}.kode-island-host i{width:6px;height:6px;border-radius:50%;background:var(--island-green)}.kode-island-usage{display:flex;align-items:baseline;gap:6px;min-width:0;margin-left:auto;white-space:nowrap}.kode-island-usage strong{color:var(--island-green);font-size:13px;font-weight:650}.kode-island-usage>span{color:var(--island-muted);font-size:9px}.kode-token-notch>svg{color:var(--island-muted);flex-shrink:0}.kode-token-notch:hover{height:38px;background:#111418}.kode-token-notch:focus-visible,.kode-token-panel button:focus-visible{outline:2px solid var(--island-cyan);outline-offset:3px}.kode-token-panel{box-sizing:border-box;position:absolute;top:0;left:0;width:100%;max-height:calc(100dvh - 24px);overflow:auto;padding:52px 22px 18px;border:1px solid var(--island-line);border-top:0;border-radius:0 0 22px 22px;background:#090b0e;color:var(--island-text);box-shadow:0 12px 36px #0006;pointer-events:auto;font-size:13px;scrollbar-width:thin;scrollbar-color:#41464e transparent;transform-origin:50% 0;animation:kode-island-unfold 340ms cubic-bezier(.2,.78,.22,1) both;font-variant-numeric:tabular-nums}.kode-token-panel[data-open=false]{pointer-events:none;animation:kode-island-fold 280ms cubic-bezier(.45,0,.75,.2) both}.kode-token-panel::selection{background:#285248;color:#fff}.kode-token-panel header{display:flex;align-items:start;justify-content:space-between;gap:16px}.kode-token-panel header strong{font-size:17px;font-weight:600;letter-spacing:-.02em}.kode-token-panel header p{font-size:11px;color:var(--island-muted);margin:6px 0 0;overflow-wrap:anywhere}.kode-token-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--island-muted);cursor:pointer}.kode-token-close:hover{color:var(--island-text);background:#1c2026}.kode-token-periods{display:inline-flex;gap:3px;margin:18px 0 14px;padding:3px;border:1px solid var(--island-line);border-radius:9px;background:#0e1115}.kode-token-periods button{padding:5px 13px;border:0;border-radius:6px;background:transparent;color:var(--island-muted);font:inherit;font-size:12px;cursor:pointer}.kode-token-periods button:hover{color:var(--island-text)}.kode-token-periods button[aria-pressed=true]{color:var(--island-text);background:#262b32;box-shadow:0 1px 3px #0004}.kode-token-totals{display:grid;grid-template-columns:1.3fr repeat(3,minmax(0,1fr));margin:0 0 14px;border:1px solid var(--island-line);border-radius:12px;background:#111419;overflow:hidden}.kode-token-totals>div{padding:12px 14px;border-right:1px solid var(--island-line);min-width:0}.kode-token-totals>div:last-child{border:0}.kode-token-totals dt{font-size:11px;color:var(--island-muted)}.kode-token-totals dd{margin:7px 0 0;font-size:17px;font-weight:550;white-space:nowrap}.kode-token-totals>div:first-child dd{color:var(--island-green);font-size:22px;font-weight:650;letter-spacing:-.03em}.kode-token-backends{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 18px}.kode-token-backends>span{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--island-line);border-radius:8px;background:#13171d;padding:6px 9px;font-size:11px}.kode-token-backends i{width:5px;height:5px;border-radius:50%;background:var(--island-cyan)}.kode-token-backends [data-backend=codex] i{background:#bdabff}.kode-token-backends [data-backend=claude] i{background:#e6a58b}.kode-token-backends [data-backend=codebuddy] i{background:#78b8ff}.kode-token-backends strong{font-weight:550;margin-left:5px}.kode-token-visuals{display:grid;grid-template-columns:1.15fr 1fr;gap:22px;margin-bottom:18px;padding:0 0 16px;border-bottom:1px solid var(--island-line)}.kode-token-visuals section{min-width:0}.kode-token-visuals h3{margin:0 0 10px;color:var(--island-muted);font-size:10px;font-weight:500}.kode-token-trend svg{display:block;width:100%;height:60px;overflow:visible}.kode-token-axis{stroke:var(--island-line);fill:none}.kode-token-trend polygon{fill:#78cef215}.kode-token-trend polyline{stroke:var(--island-cyan);stroke-width:1.5;fill:none;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.kode-token-trend>div{display:flex;justify-content:space-between;margin-top:5px;font-size:9px;color:var(--island-muted)}.kode-token-days{display:grid;grid-template-rows:repeat(7,7px);grid-auto-flow:column;grid-auto-columns:7px;justify-content:space-between;gap:2px}.kode-token-days span{width:7px;height:7px;border-radius:2px;background:#20272b}.kode-token-days [data-level="1"]{background:#254a3b}.kode-token-days [data-level="2"]{background:#3e7c5c}.kode-token-days [data-level="3"]{background:#62b885}.kode-token-days [data-level="4"]{background:var(--island-green)}.kode-token-table-scroll{overflow-x:auto;max-height:260px;scrollbar-width:thin}.kode-token-panel table{width:100%;border-collapse:collapse;text-align:right;font-size:11px}.kode-token-panel th,.kode-token-panel td{padding:10px 6px;border-bottom:1px solid var(--island-line);white-space:nowrap;font-weight:400}.kode-token-panel th:first-child{text-align:left;max-width:225px;overflow:hidden;text-overflow:ellipsis;color:var(--island-text)}.kode-token-panel thead{position:sticky;top:0;background:#090b0e;color:var(--island-muted);font-size:10px}.kode-token-panel th small{display:block;margin-top:4px;color:var(--island-muted);font-size:10px}.kode-token-panel tbody td:last-child{color:var(--island-green);font-weight:550}.kode-token-model-note{font-size:10px;color:var(--island-muted);margin:10px 0 0}.kode-token-panel footer{padding-top:14px;font-size:10px;line-height:1.6;color:var(--island-muted)}.kode-token-empty{padding:20px 0;color:var(--island-muted)}.kode-token-error{color:#ffaaa6;line-height:1.6}.kode-token-error button{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.kode-background-tasks{display:flex;align-items:center;min-width:0;padding:4px 6px 8px}.kode-background-tasks>div{max-width:100%}.kode-background-tasks button{font:inherit;font-size:12px}@keyframes kode-island-unfold{from{opacity:0;transform:scale(.44,.06);border-radius:0 0 16px 16px}70%{opacity:1;transform:scale(1.008,1.012)}to{opacity:1;transform:scale(1)}}@keyframes kode-island-fold{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.44,.06);border-radius:0 0 16px 16px}}@media(prefers-reduced-motion:reduce){.kode-token-panel,.kode-token-panel[data-open=false]{animation:none}.kode-token-notch{transition:none}}@media(max-width:480px){.kode-token-notch{width:200px;height:32px}.kode-token-panel{padding:48px 16px 16px}.kode-token-totals{grid-template-columns:repeat(2,minmax(0,1fr))}.kode-token-totals>div:nth-child(2){border-right:0}.kode-token-totals>div:nth-child(-n+2){border-bottom:1px solid var(--island-line)}.kode-token-visuals{grid-template-columns:1fr}.kode-token-days{grid-auto-columns:10px;grid-template-rows:repeat(7,10px);justify-content:start;gap:3px}.kode-token-days span{width:10px;height:10px}.kode-token-panel th:first-child{max-width:130px}}
`
    document.head.append(style)
    return () => { style.remove(); if (kodeWorkbenchContext === ctx) kodeWorkbenchContext = undefined }
  }, 'kode.workbench-ui')
}
