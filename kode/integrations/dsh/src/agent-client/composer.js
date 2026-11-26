  /** ↑/↓ recall over the shipped composer keymap; an open trigger menu keeps the arrows. */
  function ComposerRecall({ native, ...props }) {
    const { keyboard } = props
    const nodes = props.useChat?.(snapshot => snapshot.nodes)
    const live = useRef()
    live.current = { nodes, sessionId: props.sessionId, inputActions: props.inputActions }
    const recall = useMemo(() => {
      if (!keyboard) return undefined
      const state = { nav: null, peak: keyboard.snapshot?.draft ?? '', arrow: null }
      const label = () => {
        const root = keyboard.editor?.getRootElement?.(), text = composerRecallLabel(state.nav)
        if (text) root?.setAttribute('aria-description', text); else root?.removeAttribute('aria-description')
      }
      const arbitrate = (key, composing) => {
        const verdict = keyboard.arbitrate(key, composing), event = state.arrow
        state.arrow = null
        if (verdict !== 'pass' || composing || !event || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return verdict
        const input = keyboard.snapshot, draft = input?.draft ?? ''
        if (input?.phase !== 'plain') return verdict
        const step = composerRecallStep(state.nav, key, draft, keyboard.caretSpan(),
          () => composerRecallEntries(live.current.sessionId, live.current.nodes?.values(), draft))
        state.nav = step.nav; label()
        if (step.text === undefined) return verdict
        state.peak = step.text
        // Arrow commands run inside the editor update, where a discrete draft write throws.
        queueMicrotask(() => live.current.inputActions?.setDraft(step.text))
        return 'consumed'
      }
      const submit = (mode, ...args) => {
        archiveComposerText(live.current.sessionId, keyboard.snapshot?.draft, 'sent')
        state.nav = null; state.peak = ''; label()
        return keyboard.submit(mode, ...args)
      }
      // A draft emptied without sending is kept at its longest form.
      const observe = () => {
        const draft = keyboard.snapshot?.draft ?? ''
        if (draft.trim()) { if (!state.peak.trim() || draft.length >= state.peak.length) state.peak = draft }
        else if (state.peak.trim()) { archiveComposerText(live.current.sessionId, state.peak, 'draft'); state.peak = '' }
      }
      const wrapped = new Proxy(keyboard, { get(target, key) {
        if (key === 'arbitrate') return arbitrate
        if (key === 'submit') return submit
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      return { state, observe, keyboard: wrapped }
    }, [keyboard])
    useEffect(() => {
      if (!recall) return
      const editor = keyboard.editor
      // The keymap hands arbitrate the key name only; modifiers come from the keydown itself.
      const capture = event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') recall.state.arrow = editor?.getRootElement?.()?.contains(event.target) ? event : null
      }
      document.addEventListener('keydown', capture, true)
      const unregister = editor?.registerUpdateListener?.(() => queueMicrotask(recall.observe))
      return () => { document.removeEventListener('keydown', capture, true); unregister?.() }
    }, [recall])
    return h(native, { ...props, keyboard: recall?.keyboard ?? keyboard })
  }
  function SteeringControls({ native, seat, ...props }) {
    const binding = props.useProjection('kodeAgent')
    const capable = ['codex', 'claude', 'cursor', 'codebuddy'].includes(binding?.type)
    if (seat === 'conversation.composer.bar' || props.keyboard) {
      const keyboard = capable || !props.keyboard ? props.keyboard : Object.assign(Object.create(props.keyboard), {
        submit: (mode, ...args) => props.keyboard.submit(mode === 'steer' ? 'queue' : mode, ...args),
        steerQueue: () => {},
      })
      return h(native, { ...props, keyboard,
        useBusyEnter: capable ? props.useBusyEnter : select => props.useBusyEnter(() => select('queue')),
        useInput: capable ? props.useInput : select => props.useInput(input => select(input ? { ...input, queue: [] } : input)),
      })
    }
    // QueueDock is a pinned function component; retain its hooks and existing controls.
    const tree = native(props)
    const disableSteering = node => {
      if (!node || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(disableSteering)
      if (!React.isValidElement(node)) return node
      const children = node.props.children
      const steering = node.props['aria-label'] === props.t('queue.steer')
      return React.cloneElement(node, {
        ...(!capable && steering ? { disabled: true, title: '当前 Agent 不支持中途插话，请保留排队发送。', onClick: undefined } : {}),
      }, disableSteering(children))
    }
    return capable ? tree : disableSteering(tree)
  }
  function useDirectory(sessionId, sessions, host = transport?.current ?? 'local') {
    const listed = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
    const id = sessionId ?? Object.values(listed.byId).find(s => s.blank && (s.retainedBy.mainView ?? 0) > 0)?.id
    const selection = listed.byId[id]?.projectionValues?.modelSelection
    const selected = selection?.pending ?? selection?.next ?? selection?.lastUsed
    const selectedKey = `${selected?.provider ?? ''}/${selected?.model ?? ''}/${selected?.reasoningEffort ?? ''}`
    const store = directory(id, host), state = useSyncExternalStore(store.subscribe, store.getSnapshot)
    useEffect(() => {
      let alive = true
      void (async () => {
        await store.load()
        let value = store.getSnapshot().data
        if (alive && id && catalogBlank(sessions, id) && value?.defaultProfileId && !value.binding && value.canChangeAgent) {
          const fallback = value.profiles.find(p => p.id === value.configuredDefaultProfileId) ?? value.profiles.find(p => selected?.provider === 'kode-agent-' + p.id) ?? value.profiles.find(p => p.id === value.defaultProfileId)
          if (fallback) { await store.operate({ action: 'select', sessionId: id, profileId: fallback.id }); value = store.getSnapshot().data }
        }
        const staged = stagedAgent
        const catalog = sessions.list.getSnapshot().byId
        if (!alive || !id || !catalog[id]?.blank || !value?.canChangeAgent || !staged || staged.host !== (transport?.current ?? 'local') || staged.sourceId === id || Date.now() - staged.at > 120000 || catalog[staged.sourceId]?.blank === false) return
        // The workspace picker creates/reuses another blank session. Preserve
        // the Agent explicitly chosen for the unsent draft across that move.
        if (value.profiles.some(p => p.id === staged.profileId)) { stagedAgent = undefined; await store.operate({ action: 'select', sessionId: id, profileId: staged.profileId, model: staged.model, provider: staged.provider }) }
      })().catch(() => {})
      return () => { alive = false }
    }, [store, selectedKey])
    return { ...state, store, id }
  }
