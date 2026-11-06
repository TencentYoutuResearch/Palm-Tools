import React from 'react'
import { visibleRefresh } from './visible-refresh.js'
const h = React.createElement
const terminal = new Set(['completed', 'failed', 'cancelled'])
const messages = {
  waiting_accounting: '本次执行缺少可核验用量，自动推进已暂停并等待对账。预算预留与已扣款以账本为准，增加预算或重复执行不能补齐计量。',
  progression_failed: '执行端遇到问题，自动推进已暂停。请核对执行资源、权限与证据记录。',
  recovery_required: '执行结果尚未核实，自动推进已暂停。请核对停止状态和用量记录。',
  waiting_adapter: '当前执行器尚不能运行此阶段。请核对团队的执行资源。',
  waiting_user: '执行端正在等待流程中的人工决定。',
  paused: '执行端已暂停，等待人工处理后恢复。',
  taking_over: '执行端正在等待接管停止确认。',
  unavailable: '执行端暂时不可用，未确认任务正在推进。',
  not_observed: '尚未获取执行端推进记录。',
  stale: '执行端记录尚未更新到当前任务版本。',
  unrecognized: '执行端返回了尚不能识别的状态，请刷新检查。',
}
export function ExecutionStatusView({ run, request, onObservation }) {
  const [observation, setObservation] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(false)
  const active = React.useRef(null), loading = React.useRef(false), latestLoad = React.useRef(null)
  const load = async () => {
    if (loading.current) return 3000
    const controller = new AbortController(); active.current = controller; loading.current = true
    setBusy(true)
    try {
      const value = await request(`/api/kode/work-run/execution?run_id=${encodeURIComponent(run.id)}&team_id=${encodeURIComponent(run.team_id)}`, { signal: controller.signal })
      if (value.home_hub !== run.home_hub || value.run_id !== run.id || value.team_id !== run.team_id || value.run_revision !== run.revision || value.authority !== 'host_observation'
          || typeof value.state !== 'string' || ![true, false, null].includes(value.blocked) || typeof value.retry_allowed !== 'boolean') throw Error('Execution observation changed')
      if (!controller.signal.aborted) { setObservation(value); setError(false); onObservation?.(value) }
    } catch { if (!controller.signal.aborted) setError(true); return 10000 }
    finally { if (active.current === controller) loading.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => {
    active.current?.abort(); loading.current = false; setObservation(null); onObservation?.(null)
    if (!terminal.has(run.state)) void load()
    return () => active.current?.abort()
  }, [run.id, run.home_hub, run.revision, run.state])
  latestLoad.current = load
  React.useEffect(() => {
    if (terminal.has(run.state)) return
    let first = true
    return visibleRefresh({ refresh: () => { if (first) { first = false; return 3000 } return latestLoad.current() } })
  }, [run.id, run.home_hub, run.state])
  if (terminal.has(run.state)) return null
  const message = observation?.run_revision === run.revision ? messages[observation.state] : null
  return h('section', { className: 'kode-collab-execution-status', 'aria-label': '执行端检查' },
    error ? h('p', { role: 'status' }, '暂时无法读取执行端状态。任务状态仍以 Hub 记录为准。') :
      message ? h('p', { role: 'status' }, message) : !observation && h('p', { role: 'status' }, '正在核对执行端状态…'),
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load() }, busy ? '正在核对执行端…' : '刷新执行检查'))
}
