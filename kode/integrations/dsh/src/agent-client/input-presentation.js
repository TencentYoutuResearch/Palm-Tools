  const textContent = content => (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  // Cordis returns a fresh context-bound Proxy on each method read. Compare
  // and retain the underlying function, never a Proxy tied to this plugin.
  const methodOf = (object, name) => {
    for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor) return descriptor.value ?? object[name]
    }
  }
  /** One fork per source and cut at a time, and a created child is always
   *  returned: upstream rejects when only the title increment fails, which hid
   *  the new conversation and invited another click. */
  function installForkGuard(sessions, ui) {
    const originalFork = sessions && methodOf(sessions, 'fork'), originalForkSession = ui && methodOf(ui, 'forkSession'), pending = new Map()
    if (!originalFork) return () => {}
    const fork = function(options) {
      const key = JSON.stringify([transport?.current ?? 'local', options.sessionId, options.atSeq ?? null])
      if (pending.has(key)) return pending.get(key)
      let childId
      const task = Promise.resolve(originalFork.call(this, { ...options, onCreated: id => { childId = id; options.onCreated?.(id) } })).catch(error => {
        if (childId === undefined) throw error
        console.warn('session forked, but its title was not updated:', error)
        return childId
      }).finally(() => { if (pending.get(key) === task) pending.delete(key) })
      pending.set(key, task)
      return task
    }
    // The sidebar menu and shortcut leave the child unopened upstream.
    const forkSession = originalForkSession && async function(...args) {
      const childId = await originalForkSession.apply(this, args)
      await this.openSession(childId)
      void refreshWorkspaceDirectory()
      return childId
    }
    sessions.fork = fork
    if (forkSession) ui.forkSession = forkSession
    return () => {
      if (methodOf(sessions, 'fork') === fork) sessions.fork = originalFork
      if (forkSession && methodOf(ui, 'forkSession') === forkSession) ui.forkSession = originalForkSession
    }
  }
  function installInputPresentation(ctx) {
    ctx.inject(['inputTriggers', 'commandUi', 'remote.commands'], scope => {
      const input = scope.inputTriggers, commands = scope.commandUi
      if (!input?.sessionOf || typeof commands?.candidates !== 'function') return
      const metadata = new Map(), skillLists = new Map(), adapted = new Map(), sourceName = 'kode-codex-skills'
      const originalCandidates = methodOf(commands, 'candidates'), originalSessionOf = methodOf(input, 'sessionOf')
      let candidateWrapper, sessionOf, active = true
      scope.effect(() => () => {
        active = false
        if (candidateWrapper && methodOf(commands, 'candidates') === candidateWrapper) commands.candidates = originalCandidates
        if (sessionOf && methodOf(input, 'sessionOf') === sessionOf) input.sessionOf = originalSessionOf
        for (const [controller, methods] of adapted) if (methodOf(controller, 'track') === methods.wrapper) { controller.dismiss(); controller.track = methods.track }
        metadata.clear(); skillLists.clear(); adapted.clear()
      }, 'kode.input-presentation')
      const keyOf = session => `${transport?.current ?? 'local'}:${session.sessionId}`
      const metadataFor = session => {
        const key = keyOf(session)
        if (!metadata.has(key)) metadata.set(key, scope.remote.commands.list(session.sessionId).then(result => {
          if (!result.ok) throw new Error(result.error.message)
          return new Map((Array.isArray(result.value) ? result.value : result.value.commands).map(row => [row.name, row]))
        }).catch(error => { metadata.delete(key); throw error }))
        return metadata.get(key)
      }
      const iconFor = name => name === 'new' ? IconPlusOutlineRegular : ['model', 'mode', 'effort'].includes(name) ? ModelGlyph : ['help', 'status', 'context', 'cost', 'usage'].includes(name) ? InfoGlyph : name === 'compact' ? CompactGlyph : ['permission', 'permissions', 'plan'].includes(name) ? PermissionGlyph : name === 'mcp' ? IconGlobeOutlineRegular : CommandGlyph
      candidateWrapper = async function(session, request) {
        // The native catalog first retains/opens the Session. Presentation
        // metadata must neither race that admission nor hide an otherwise
        // usable menu when its optional read is unavailable.
        const rows = await originalCandidates.call(this, session, request)
        if (!active) return rows
        const catalog = await metadataFor(session).catch(() => new Map())
        if (!active) return rows
        const groups = { '快捷操作': [], 'Agent 命令': [], '技能': [] }
        for (const row of rows) {
          const definition = catalog.get(row.name)?.definitionId ?? ''
          const skill = definition.startsWith('@kode/dsh/native/skill/')
          const section = skill ? '技能' : ['file', 'feedback', 'export', 'new', 'clear'].includes(row.name) ? '快捷操作' : 'Agent 命令'
          groups[section].push({ ...row, section, icon: row.icon ?? (skill ? SkillGlyph : iconFor(row.name)) })
        }
        return Object.values(groups).flat()
      }
      commands.candidates = candidateWrapper
      const resetting = new Map()
      const freshSession = (session, keepTitle = false) => {
        const sourceHost = transport?.current ?? 'local', key = `${sourceHost}:${session.sessionId}`
        if (resetting.has(key)) return resetting.get(key)
        const binding = scope.sessions.binding(session.sessionId)
        const task = (async () => {
          const store = directory(session.sessionId, sourceHost); await store.load()
          const data = store.getSnapshot().data, previous = scope.sessions.list.getSnapshot().byId[session.sessionId]
          if (!data?.currentProfile) throw new Error('请先选择此会话的 Agent。')
          const workspace = scope.get('workspaces')?.list.getSnapshot().items.find(row => row.sessionIds.includes(session.sessionId) && (!previous?.cwd || row.path === previous.cwd))
          const id = await scope.sessions.create({ ...(workspace ? { workspaceId: workspace.workspaceId } : previous?.cwd ? { cwd: previous.cwd } : {}), agentPreset: 'kode-native' })
          const checkHost = () => { if ((transport?.current ?? 'local') !== sourceHost) throw new Error('执行主机已切换，新会话保留在原主机。') }
          checkHost()
          const supportsFast = data.models?.find(row => row.id === data.selection?.model)?.fastCapability
          await call({ action: 'select', sessionId: id, profileId: data.currentProfile.id, model: data.selection?.model, reasoningEffort: data.selection?.reasoningEffort, ...(supportsFast ? { fast: data.fast } : {}) }, id, false, sourceHost)
          checkHost()
          const title = previous?.title ?? previous?.displayTitle
          if (keepTitle && title) {
            const result = await scope.sessions.using(id, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(title))
            if (result?.ok === false) throw new Error(result.error.message)
          }
          checkHost()
          await scope.get('uiWorkspace').openSession(id); await refreshWorkspaceDirectory()
        })().catch(error => binding?.ctx.get('conversation')?.input.for(binding.ctx).notify('error', error.message)).finally(() => resetting.delete(key))
        resetting.set(key, task); return task
      }
      const canStartFresh = session => Boolean(directory(session.sessionId).getSnapshot().data?.currentProfile && scope.get('uiWorkspace'))
      if (typeof commands.decorate === 'function') scope.effect(() => commands.decorate({
        name: 'new', available: canStartFresh,
        ui: { kind: 'action', run: session => freshSession(session) },
      }), 'kode.new-session-command')
      if (typeof commands.register === 'function') scope.effect(() => commands.register({
        name: 'clear', description: () => '清空上下文并开始同名新会话', icon: IconPlusOutlineRegular, available: canStartFresh,
        ui: { kind: 'action', run: session => freshSession(session, true) },
      }), 'kode.clear-session-command')
      if (typeof commands.register === 'function') scope.effect(() => commands.register({
        name: 'fork', description: () => '从当前对话拉出新分支', icon: IconPlusOutlineRegular,
        available: session => Boolean(scope.sessions?.fork && scope.get('uiWorkspace') && !scope.sessions.list.getSnapshot().byId[session.sessionId]?.blank),
        ui: { kind: 'action', run: session => {
          const binding = scope.sessions.binding(session.sessionId)
          return (async () => {
            const childId = await scope.sessions.fork({ sessionId: session.sessionId, increaseTitle: true })
            await scope.get('uiWorkspace')?.openSession(childId)
            await refreshWorkspaceDirectory()
          })().catch(error => {
            const text = /fork-unavailable|no completed turn/i.test(error?.message ?? '')
              ? '仅可从已完成至少一轮对话的会话拉出分支。'
              : (error?.message ?? '拉出分支失败。')
            binding?.ctx.get('conversation')?.input.for(binding.ctx).notify('error', text)
          })
        } },
      }), 'kode.fork-session-command')
      if (typeof commands.decorate === 'function') scope.effect(() => commands.decorate({
        name: 'resume',
        available: session => { const profile = directory(session.sessionId).getSnapshot().data?.currentProfile; return Boolean(profile && profile.type !== 'dsh') },
        ui: { kind: 'action', run: session => window.dispatchEvent(new CustomEvent('kode-resume-session', { detail: { sessionId: session.sessionId, hostId: transport?.current ?? 'local', profile: directory(session.sessionId).getSnapshot().data?.currentProfile } })) },
      }), 'kode.resume-session-command')
      if (typeof commands.decorate === 'function') scope.effect(() => commands.decorate({
        name: 'rename', available: () => typeof requestNativeRename === 'function',
        ui: { kind: 'action', run: ({ sessionId }) => {
          const summary = scope.sessions.list.getSnapshot().byId[sessionId]
          routedRename = undefined
          requestNativeRename?.(sessionId, summary?.title ?? '')
        } },
      }), 'kode.rename-session-command')
      const invalidate = () => { metadata.clear(); skillLists.clear() }
      scope.remote.$on?.('commands/change', invalidate)
      scope.on?.('connection/reset', invalidate)
      scope.on?.('command/executed', (_id, name) => { if (['skills', 'reload-skills', 'reload-plugins'].includes(name)) skillLists.clear() })
      scope.effect(() => input.registerSource({
        trigger: '$', name: sourceName, showGroupTitle: false,
        async candidates(session, request) {
          const key = keyOf(session)
          if (!skillLists.has(key)) skillLists.set(key, fetchHost(`${API}?session_id=${encodeURIComponent(session.sessionId)}&skills=1`, { credentials: 'same-origin', cache: 'no-store', signal: request.signal }).then(async response => {
            const value = await parseHostJson(response); if (!response.ok) throw new Error(value.error ?? '技能目录读取失败。')
            return value.skills ?? []
          }).catch(error => { skillLists.delete(key); throw error }))
          const rows = await skillLists.get(key), query = request.query.toLocaleLowerCase()
          return rows.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(query)).map(skill => ({ name: skill.name, description: (skill.description ?? '').replace(/\s+/g, ' ').trim(), icon: SkillGlyph, section: '技能', value: skill.path }))
        },
        onPick: ({ candidate }) => ({ text: `$${candidate.name} ` }),
      }), 'kode.native-skill-source')
      const decorate = (controller, sessionId, actx) => {
        if (adapted.has(controller)) return controller
        const track = methodOf(controller, 'track')
        let previous = null, dollar = false
        const wrapper = function(draft, caret, guard, draftRev) {
          if (!active) return track.call(this, draft, caret, guard, draftRev)
          const profile = directory(sessionId).getSnapshot().data?.currentProfile
          const match = guard.tier === 'plain' && (!profile || profile.type === 'codex' || profile.protocol === 'codex') && /(?:^|\s)\$([a-zA-Z0-9_:-]*)$/.exec(draft.slice(0, caret))
          if (!match) { if (dollar) controller.dismiss(); dollar = false; previous = null; return track.call(this, draft, caret, guard, draftRev) }
          const start = caret - match[1].length - 1, stamp = `${start}:${caret}:${match[1]}:${draftRev}`
          if (stamp === previous) return
          previous = stamp; dollar = true
          // The pinned public launcher supplies the same native menu, keyboard
          // arbitration, scrolling and guarded insertion used by / and @.
          track.call(this, draft, caret, guard, draftRev)
          controller.toggleSource(sourceName, { trigger: '$', query: match[1], quoted: false, position: draft.slice(0, start).trim() ? 'inline' : 'leading', span: { start, end: caret, draftRev } })
        }
        controller.track = wrapper; adapted.set(controller, { track, wrapper })
        const cacheKey = keyOf({ sessionId })
        actx?.effect?.(() => () => { if (methodOf(controller, 'track') === wrapper) controller.track = track; adapted.delete(controller); metadata.delete(cacheKey); skillLists.delete(cacheKey) }, 'kode.session-input-presentation')
        return controller
      }
      sessionOf = function(actx) {
        const controller = originalSessionOf.call(this, actx)
        if (!active) return controller
        const session = scope.sessions.sessionOf(actx)
        return session ? decorate(controller, session.sessionId, actx) : controller
      }
      input.sessionOf = sessionOf
      scope.slots.inject('conversation.input.overlay', () => scope.slots.register({ name: 'conversation.input.overlay', id: 'kode-input-adapter', inject: sessionId => {
        const binding = scope.sessions.binding(sessionId); if (binding) input.sessionOf(binding.ctx)
        return {}
      } }, () => null))
    })
  }
