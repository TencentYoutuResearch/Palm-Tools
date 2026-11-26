  function GoalSidebar({ sessionId, sessions }) {
    const host = transport?.current ?? 'local'
    const face = sessions.binding(sessionId)?.session.projections.faceOf('kodeGoal')
    const subscribe = React.useCallback(listener => face ? face.subscribe(listener) : () => {}, [face])
    const getSnapshot = React.useCallback(() => face?.getSnapshot() ?? null, [face])
    const goal = useSyncExternalStore(subscribe, getSnapshot)
    const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => { setDraft(goal?.objective ?? ''); setError('') }, [goal?.revision, sessionId])
    if (!goal) return h('section', { className: 'kode-goal-sidebar' }, '当前没有 Goal')
    const save = async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await hubCall({ action: 'goal', sessionId, command: 'edit ' + draft.trim() }, host) }
      catch (error) { setError(error.message) }
      finally { setBusy(false) }
    }
    return h('section', { className: 'kode-goal-sidebar', 'aria-label': '编辑 Goal' },
      h('span', { className: 'kode-goal-status' }, 'Goal · ' + goal.status),
      h('form', { onSubmit: save },
        h('label', { className: 'kode-field' }, '目标', h('textarea', { rows: 10, required: true, maxLength: 4000, value: draft, disabled: busy, onChange: event => setDraft(event.target.value) })),
        h(Failure, { text: error }),
        h(Button, { type: 'submit', variant: 'primary', disabled: busy || !draft.trim() }, '保存目标')))
  }
  // DSH ships its GoalBar as a public export of @deepseek-ai/dsh-client-ui-goal. Kode keeps its
  // own state (Codex owns the goal) and only borrows the strip; older hosts fall back to Kode's strip.
  const nativeGoalUi = { GoalBar: null, listeners: new Set() }
  const loadNativeGoalUi = () => {
    const ready = module => { if (typeof module?.GoalBar !== 'function') return; nativeGoalUi.GoalBar = module.GoalBar; for (const listener of nativeGoalUi.listeners) listener() }
    try { ready(require('@deepseek-ai/dsh-client-ui-goal')); return } catch {}
    require.async?.('@deepseek-ai/dsh-client-ui-goal').then(ready, () => {})
  }
  const subscribeNativeGoalUi = listener => { nativeGoalUi.listeners.add(listener); return () => nativeGoalUi.listeners.delete(listener) }
  // Codex reports budget and usage stops as their own statuses; DSH's strip folds them into blocked.
  const KODE_GOAL_BLOCKED = { blocked: '目标受阻', budgetLimited: '目标预算已用完', usageLimited: '用量已达上限' }
  function nativeGoalSnapshot(goal, sessionId) {
    if (!goal) return goal
    const phase = ['active', 'paused', 'complete'].includes(goal.status) ? goal.status : 'blocked'
    return { id: `kode:${sessionId}:${goal.id ?? goal.createdAt ?? 'current'}`, revision: 1, objective: goal.objective, phase, maxGoalRounds: 1,
      ...(phase === 'blocked' ? { blockedReason: { code: goal.status, message: KODE_GOAL_BLOCKED[goal.status] ?? goal.status } } : {}) }
  }
  function useSessionProjection(sessions, sessionId, key) {
    const face = useMemo(() => { try { return sessions?.binding(sessionId)?.session.projections.faceOf(key) } catch { return undefined } }, [sessions, sessionId, key])
    const subscribe = useCallback(listener => face ? face.subscribe(listener) : () => {}, [face])
    return useSyncExternalStore(subscribe, () => face?.getSnapshot() ?? null)
  }
  function GoalBar({ sessionId, sessions, useProjection, t }) {
    const goal = useProjection('kodeGoal'), host = transport?.current ?? 'local'
    const NativeGoalBar = useSyncExternalStore(subscribeNativeGoalUi, () => nativeGoalUi.GoalBar)
    // A goal created through DSH's own /goal already has DSH's strip; never show a second one.
    const dshGoal = useSessionProjection(sessions, sessionId, 'goal')
    const run = useCallback(command => async () => {
      try { return { ok: true, value: await hubCall({ action: 'goal', sessionId, command }, host) } }
      catch (error) { return { ok: false, error: { code: 'kode', message: error.message } } }
    }, [sessionId, host])
    const actions = useMemo(() => ({ onEdit: objective => run('edit ' + objective)(), onPause: run('pause'), onResume: run('resume'), onClear: run('clear') }), [run])
    if (dshGoal?.goal) return null
    if (!NativeGoalBar || typeof t !== 'function') return h(KodeGoalStrip, { sessionId, goal })
    return h(NativeGoalBar, { goal: nativeGoalSnapshot(goal, sessionId), ...(goal?.status === 'active' ? { activation: 'armed' } : {}), ...actions, t })
  }
  function KodeGoalStrip({ sessionId, goal }) {
    const host = transport?.current ?? 'local'
    const [error, setError] = useState(''), [busy, setBusy] = useState(false)
    const [editing, setEditing] = useState(false), [objective, setObjective] = useState('')
    useEffect(() => { setEditing(false); setError('') }, [sessionId, host])
    const operate = async command => {
      setBusy(true); setError('')
      try { await hubCall({ action: 'goal', sessionId, command }, host); setEditing(false) }
      catch (error) { setError(error.message) }
      finally { setBusy(false) }
    }
    if (!goal && !editing) return null
    const labels = { active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '预算耗尽' }
    const edit = () => { setObjective(goal.objective); setEditing(true); setError('') }
    return h('div', { className: 'kode-goal-bar', 'data-goal-status': goal?.status, 'aria-label': '会话目标 · ' + (labels[goal?.status] ?? goal?.status ?? '编辑中') },
      h('div', { className: 'kode-goal-panel' },
        editing ? h('form', { onSubmit: event => { event.preventDefault(); void operate('edit ' + objective.trim()) } },
          h('label', { className: 'kode-field' }, '编辑目标', h('input', { autoFocus: true, required: true, maxLength: 4000, value: objective, disabled: busy, onChange: event => setObjective(event.target.value) })),
          h(Button, { type: 'submit', disabled: busy || !objective.trim() }, '保存'), h(Button, { type: 'button', disabled: busy, onClick: () => setEditing(false) }, '取消')) :
        h(React.Fragment, null, h('span', { className: 'kode-goal-leading', title: labels[goal.status] ?? goal.status, 'aria-hidden': true }, h(IconGoalOutlineRegular, { size: 14 })),
          h('button', { className: 'kode-goal-objective', type: 'button', title: goal.objective, disabled: busy, onClick: edit, 'aria-label': '编辑目标：' + goal.objective }, goal.objective),
          h('div', { className: 'kode-goal-actions' },
            h('button', { className: 'kode-goal-icon', type: 'button', title: goal.status === 'active' ? '暂停 Goal' : '继续 Goal', 'aria-label': goal.status === 'active' ? '暂停 Goal' : '继续 Goal', disabled: busy || goal.status === 'complete', onClick: () => void operate(goal.status === 'active' ? 'pause' : 'resume') }, h(goal.status === 'active' ? IconPauseOutlineRegular : IconPlayOutlineRegular, { size: 14 })),
            h('button', { className: 'kode-goal-icon', type: 'button', title: '清除 Goal', 'aria-label': '清除 Goal', disabled: busy, onClick: () => void operate('clear') }, h(IconCloseOutlineRegular, { size: 14 })),
            h('button', { className: 'kode-goal-icon', type: 'button', title: '编辑目标', 'aria-label': '编辑目标', disabled: busy, onClick: edit }, h(IconEditOutlineRegular, { size: 14 })))),
        h(Failure, { text: error })))
  }
