// @include helpers.js
window.__ModuleLoader__.load({ id: '@kode/dsh', factory(require) {
  const React = require('react'), h = React.createElement
  const { createPortal } = require('react-dom')
  const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
  const CARD_SECTIONS = 'conversation.session.panel.section'
  const CARD_ENVIRONMENT = 'conversation.session.panel.environment.row'
  const { Menu, Modal, Button, Toast, Tooltip, MarkdownText, TerminalBlock, FishLogo, BrandWordmark, StateDot, IconApiOutlineRegular, IconEditOutlineRegular, IconChevronDownOutlineRegular, IconAgentPresetOutlineRegular, MenuItemButton, IconFolderCloseRegular, IconPlusOutlineRegular, IconGlobeOutlineRegular, IconPaperPlaneOutlineRegular, IconMailUnreadOutlineRegular, IconMailReadOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconCloseOutlineRegular, IconGoalOutlineRegular, IconCheckOutlineRegular, IconClockOutlineRegular, IconSearchOutlineRegular, IconLoadingOutlineRegular, IconUsersOutlineRegular, IconWarningOutlineRegular, IconBranchOutlineRegular, IconChevronRightOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
  const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' } }, footnotes: '脚注' }
  // @include agent-directory.js
  // @include composer.js
  // @include session-appearance.js
  // @include agent-controls.js
  // @include host-settings.js
  // @include integration-hub.js
  // @include goal.js
  // @include desktop-navigation.js
  // @include bot-profile.js
  // @include bot-watches.js
  // @include bot-connectors.js
  // @include bot-board.js
  // @include bots-page.js
  // @include wecom-settings.js
  // @include memory-page.js
  // @include desktop-panels.js
  // @include settings-page.js
  // @include agent-appearance-and-model.js
  // @include workspace-sidebar.js
  // @include input-presentation.js
  // @include shared-conversation.js
  // @include account-devices.js
  // @include internal-messages.js
  // @include session-messaging.js
  // @include session-panel.js
  // @include git-changes.js
  return { inject: ['slots', 'sessions', 'remote', 'remote.agentPresets', 'kodeNotifications', 'uiSession', 'uiSession.sessionStatus'], apply(ctx) {
    ctx.provide('kodeActivity', globalActivity)
    installGlobalActivitySubscriptions(ctx)
    avatarContext = ctx
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kode-avatar-dialog' }, AvatarDialog))
    ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'kode-conversation-background', inject: sessionId => ({ sessionId, sessions: ctx.sessions }) }, ConversationBackground))
    ctx.inject(['kodeTransport'], scope => {
      if (!scope.kodeTransport) return
      transport = scope.kodeTransport
      scope.effect(() => {
        let events
        const connect = () => {
          events?.close()
          if (typeof EventSource === 'undefined') return
          const host = transport.current
          events = new EventSource(transport.path(`${API}/runtimes`))
          events.onmessage = event => {
            for (const [key, store] of stores) if (key.startsWith(`${host}:`)) void store.load()
            void refreshWorkspaceDirectory()
          }
        }
        let current = transport.current
        const unsubscribe = transport.subscribe(() => {
          if (current === transport.current) return
          current = transport.current; stagedAgent = undefined; connect()
          void refreshWorkspaceDirectory(); for (const refresh of hostListeners) refresh()
        })
        connect()
        return () => { events?.close(); unsubscribe(); transport = undefined }
      }, 'kode.transport-binding')
    })
    installInputPresentation(ctx)
    for (const seat of ['conversation.input.dock', 'conversation.composer.bar']) ctx.slots.inject(seat, () => {
      const adapted = new Map()
      const install = () => {
        for (const entry of ctx.slots.entries(seat)) {
          if (seat === 'conversation.input.dock' && entry.options.id !== 'queue' || adapted.has(entry)) continue
          const native = entry.component, steering = props => h(SteeringControls, { ...props, native, seat })
          const wrapper = seat === 'conversation.composer.bar' ? props => h(ComposerRecall, { ...props, native: steering }) : steering
          adapted.set(entry, { native, wrapper }); entry.component = wrapper
        }
      }
      const unsubscribe = ctx.slots.subscribe(seat, install); install()
      return () => { unsubscribe(); for (const [entry, { native, wrapper }] of adapted) if (entry.component === wrapper) entry.component = native }
    })
    if (document.addEventListener && document.documentElement) ctx.effect(() => {
      const update = () => document.documentElement.classList.toggle('kode-motion-paused', document.hidden)
      update(); document.addEventListener('visibilitychange', update)
      return () => { document.removeEventListener('visibilitychange', update); document.documentElement.classList.remove('kode-motion-paused') }
    }, 'kode.connection-motion')
    ctx.inject(['sidebarRightTabs'], scope => {
      if (!scope.sidebarRightTabs) return
      scope.effect(() => scope.sidebarRightTabs.register({ id: 'kode-goal', kind: 'kode-goal', priority: 'builtin', title: () => 'Goal' }), 'kode-goal-tab')
    })
    loadNativeGoalUi()
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'kode-goal-bar', order: 100, locale: 'goal', inject: sessionId => ({ sessionId, sessions: ctx.sessions }) }, GoalBar))
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'kode-goal', inject: sessionId => ({ sessionId, sessions: ctx.sessions }) }, GoalSidebar))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'kode-goal' }, () => h(React.Fragment, null, h(IconGoalOutlineRegular, { size: 16 }), 'Goal')))
    installGitChangesSidebar(ctx)
    installSessionPanel(ctx)
    if (kodeEmbedded()) {
      // Kode's window buttons sit over the page; keep a titlebar strip for
      // them that also drags the window. dsh's own desktop layout
      // (data-platform) needs its Electron bridge, so it is not used here.
      const titlebar = document.createElement('div')
      titlebar.setAttribute('data-kode-titlebar', '')
      document.body.append(titlebar)
      ctx.effect(() => () => titlebar.remove(), 'kode.embed-titlebar')
    }
    wrapSlot(ctx, 'main.conversation', entry => typeof entry.component === 'function', native => props => h(ConversationNavigation, { ...props, native }))
    wrapSlot(ctx, 'settings.launcher', entry => typeof entry.component === 'function', native => props => h(KodeAccountLauncher, { ...props, native }))
    wrapSlot(ctx, 'shell.overlay', entry => entry.options.id === 'workspace.session-rename', native => props => h(RoutedRenameDialog, { ...props, native }))
    wrapSlot(ctx, 'conversation.session.header.actions', entry => entry.options.id === 'subagent-catalog', native => props => h(FilteredSubagentCatalog, { ...props, native }))
    wrapSlot(ctx, 'conversation.session.header.lineage', entry => typeof entry.component === 'function', native => props => h(FilteredSubagentCatalog, { ...props, native }))
    ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({ name: 'sidebar.session.row.hover', id: 'kode-saved-time' }, SavedSessionHover))
    ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'kode-agent-avatar' }, SidebarAgentAvatar))
    ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'kode-avatar', order: 350 }, SessionAvatarMenuItem))
    ctx.slots.inject('conversation.view',()=>{
      let source,original,wrapper
      const restore=()=>{if(source&&source.component===wrapper)source.component=original}
      const install=()=>{
        const entry=ctx.slots.entries('conversation.view').find(entry=>entry.options.id==='chat'&&entry.store)
        if(!entry||entry===source)return
        restore();source=entry;original=entry.component
        const native=original;wrapper=props=>h(InlineFileChat,{...props,native});entry.component=wrapper
      }
      const unsubscribe=ctx.slots.subscribe('conversation.view',install);install()
      return()=>{unsubscribe();restore()}
    })
    // Keep each native seat's injections, locale, reasoning/image children and
    // actions. This also upgrades already imported history without rewriting it.
    ctx.slots.inject('conversation.chat.node', () => {
      const adapted=new Map(), kinds=new Set(['user','steering','context','turn-trigger','assistant-step'])
      const install=()=>{
        for(const entry of ctx.slots.entries('conversation.chat.node')) {
          if(!kinds.has(entry.options.key) || entry.component===RelayTrigger || adapted.has(entry))continue
          const original=entry.component, wrapper=props=>h(InternalMessageAdapter,{...props,native:original,kodeSessions:ctx.sessions})
          adapted.set(entry,{original,wrapper});entry.component=wrapper
        }
      }
      const unsubscribe=ctx.slots.subscribe('conversation.chat.node',install);install()
      return()=>{unsubscribe();for(const [entry,{original,wrapper}] of adapted)if(entry.component===wrapper)entry.component=original}
    })
    ctx.slots.inject('sidebar.workspaces', () => {
      let source, original, wrapper
      const restore = () => { if (source && source.component === wrapper) source.component = original }
      const install = () => {
        const native = ctx.slots.entries('sidebar.workspaces').find(entry => entry.store)
        if (!native || native === source) return
        restore(); source = native; original = native.component
        const component = original
        wrapper = props => h(FederatedWorkspaceBrowser, { ...props, slots: ctx.slots, native: component })
        native.component = wrapper
      }
      const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', install)
      install()
      return () => { unsubscribe(); restore() }
    })
    ctx.effect(() => { const timer = setInterval(() => { if (workspaceListeners.size) void refreshWorkspaceDirectory() }, 5000); return () => clearInterval(timer) }, 'kode.workspace-directory')
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kode-project-host-appearance' }, ProjectHostAppearance))
    // Optional glyph face. Font family and size remain entirely user settings.
    if (typeof FontFace !== 'undefined') ctx.effect(() => {
      let active = true
      const face = new FontFace('Kode Terminal Symbols', 'url("/api/kode/terminal-font.ttf")')
      void face.load().then(loaded => { if (active) document.fonts.add(loaded) }).catch(() => {})
      return () => { active = false; document.fonts.delete(face) }
    }, 'kode.terminal-font')
    ctx.inject(['sessions', 'uiWorkspace'], scope => { scope.effect(() => installForkGuard(scope.sessions, scope.uiWorkspace), 'kode.fork-guard') })
    ctx.inject(['workspaces', 'uiWorkspace', 'layout'], scope => {
      scope.slots.inject('conversation.hero.workspace', () => scope.slots.register({ name: 'conversation.hero.workspace', priority: -10, inject: sessionId => ({ sessionId, workspaces: scope.workspaces, slots: scope.slots, remote: scope.remote, uiWorkspace: scope.uiWorkspace }) }, WorkspacePicker))
      scope.slots.inject('sidebar.workspaces.directoryFlow', () => scope.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -10, inject: () => ({ slots: scope.slots, workspaces: scope.workspaces }) }, ProjectFlow))
      scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'kode-workspace-arrival', inject: () => ({ uiWorkspace: scope.uiWorkspace, workspaces: scope.workspaces, sessions: scope.sessions, layout: scope.layout }) }, WorkspaceArrival))
      scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'kode-project-arrival', inject: () => ({ slots: scope.slots, workspaces: scope.workspaces, uiWorkspace: scope.uiWorkspace }) }, ProjectArrival))
      scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: 'turn-trigger', priority: -10, locale: 'conversation', inject: sessionId => ({ slots: scope.slots, sessions: scope.sessions, sessionId }) }, RelayTrigger))
    })
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const key of ['kode_sessions_list', 'kode_sessions_create', 'kode_sessions_send', 'kode_sessions_read', 'kode_sessions_wait']) yield ctx.slots.register({ name: 'tool.call.toolview', key, inject: sessionId => ({ sessions: ctx.sessions, sessionId }) }, MessagingTool)
      // Official renderers may already own these keys. Shadow them at a
      // separate priority so either activation order and hot reload are valid.
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'subagent_native', priority: -10 }, NativeSubagentTool)
      for (const key of ['exec_command','apply_patch','kode_native_commandExecution','kode_native_fileChange','kode_native_operation']) yield ctx.slots.register({name:'tool.call.toolview',key,priority:-10},NativeOperationTool)
    })
    ctx.effect(() => { const timer = setInterval(() => { if (nameListeners.size && !document.hidden) void refreshNames() }, 10000); return () => clearInterval(timer) }, 'kode.session-names')
    // @include styles.js
    ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register({ name: 'conversation.hero.agentPreset', id: 'kode-agent', inject: sessionId => ({ sessionId, sessions: ctx.sessions, remote: ctx.remote, slots: ctx.slots }) }, AgentControl))
    ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, KodeBrandMark))
    ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, SidebarBrandMark))
    ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, KodeBrandName))
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-presets', order: 5, label: () => 'Kode 设置', inject: () => ({ sessions: ctx.sessions, slots: ctx.slots }) }, KodeSettings))
    ctx.inject(['layout'], scope => {
      if (!scope.layout?.selectPanel) return
      const KodeMainPage = () => h('div', { className: 'kode-settings-main' }, h(KodeSettings, { sessions: scope.sessions, slots: scope.slots, close: () => {} }))
      scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'kode-settings' }, KodeMainPage))
      // Native panels can be pinned or moved to More using the sidebar's controls.
      scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: 'kode-settings', order: 6, label: 'Kode 设置' }, IconAgentPresetOutlineRegular))
      if (kodeEmbedded()) {
        const KodeMoreItems = ({ onDismiss }) => h(React.Fragment, null,
          h(MenuItemButton, { icon: glyph(TERMINAL_GLYPH), onSelect: () => { onDismiss?.(); scope.layout.selectPanel('kode-leave') } }, 'Kode 终端'),
          h(MenuItemButton, { icon: glyph(HISTORY_GLYPH), onSelect: () => { onDismiss?.(); scope.layout.selectPanel('kode-resume') } }, '恢复会话'))
        scope.slots.inject('sidebar.panellist.actions', () => scope.slots.register({ name: 'sidebar.panellist.actions', id: 'kode-entries', order: -10 }, KodeMoreItems))
      }
      scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'kode-bots' }, () => h(KodeBotsPage, { ui: () => scope.get('uiWorkspace'), leave: () => scope.layout.selectPanel(null) })))
      // A 创建伙伴 conversation ends with a kode-bot block: show it as a card to confirm.
      scope.slots.inject('conversation.chat.markdown.fence', () => scope.slots.register({ name: 'conversation.chat.markdown.fence', key: 'kode-bot', id: 'kode-bot-proposal' }, BotProposalCard))
      scope.slots.inject('main', () => {
        const KodeMemoryMainPage = () => h('div', { className: 'kode-settings-main' }, h(KodeMemoryPage, { slots: scope.slots }))
        return scope.slots.register({ name: 'main', key: 'kode-memory' }, KodeMemoryMainPage)
      })
      const openBotSession = async id => { scope.layout.selectPanel(null); await scope.get('uiWorkspace')?.openSession(id) }
      openBotChat = openBotSession
      scope.slots.inject('sidebar.panellist.trailing', () => scope.slots.register({ name: 'sidebar.panellist.trailing', id: 'schedules' }, () => h('span', { className: 'kode-schedules-marker', hidden: true })))
      scope.slots.inject('sidebar.panellist.trailing', () => scope.slots.register({ name: 'sidebar.panellist.trailing', id: 'plugins' }, () => h('span', { className: 'kode-plugins-marker', hidden: true })))
      scope.slots.inject('sidebar.panellist.trailing', () => scope.slots.register({ name: 'sidebar.panellist.trailing', id: 'kode-bots' }, BotsNavTrailing))
      scope.slots.inject('sidebar.panellist.trailing', () => scope.slots.register({ name: 'sidebar.panellist.trailing', id: 'kode-memory' }, MemoryPendingBadge))
      scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: 'kode-bots', order: 5, label: '伙伴' }, props => h(BotsNavGlyph, { ...props, openSession: openBotSession })))
      scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: 'kode-memory', order: 5.5, label: '共享记忆' }, MemoryNavIcon))
      if (kodeEmbedded()) {
        scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'kode-leave' }, () => h(KodeLeavePage, { layout: scope.layout })))
        scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'kode-resume' }, () => h(KodeResumePage, { layout: scope.layout })))
        // Kode's extension panels follow the installed extensions and their badges.
        let panelSlots = []
        const showPanels = panels => {
          for (const dispose of panelSlots) dispose()
          panelSlots = panels.flatMap((panel, index) => {
            const key = `kode-panel:${panel.extension}:${panel.id}`
            const label = panel.badge > 0 ? `${panel.title} (${panel.badge > 99 ? '99+' : panel.badge})` : panel.title
            return [
              scope.slots.register({ name: 'main', key }, () => h(KodePanelPage, { panel })),
              scope.slots.register({ name: 'sidebar.panellist', id: key, order: 20 + index, label }, ({ size } = {}) => panel.extension === 'kode.team' && panel.id === 'team' ? teamIcon(size) : glyph(PANEL_GLYPH, size)),
            ]
          })
        }
        const onHost = event => {
          const message = event.detail
          if (message?.type === 'kode-panels' && Array.isArray(message.panels)) showPanels(message.panels)
          if (message?.type === 'kode-panel-closed') scope.layout.selectPanel(null)
          if (message?.type === 'kode-open-panel' && typeof message.panel === 'string') scope.layout.selectPanel(message.panel)
          if (message?.type === 'kode-open-bot' && typeof message.botId === 'string') {
            void botsCall({
              action: 'greet',
              id: message.botId,
              idempotency_key: `bot-greet-${message.botId}-${Date.now()}`,
            }).then(res => {
              if (res?.sessionId) void openBotSession(res.sessionId)
              else { requestedBotStart = message.botId; scope.layout.selectPanel('kode-bots') }
            }).catch(() => {
              requestedBotStart = message.botId
              scope.layout.selectPanel('kode-bots')
            })
          }
        }
        window.addEventListener('kode-host', onHost)
        window.kodeHost.request('panels')
        scope.effect(() => () => {
          window.removeEventListener('kode-host', onHost)
          for (const dispose of panelSlots) dispose()
        }, 'kode.extension-panels')
      }
      closeKodePanel = () => { scope.layout.selectPanel(null) }
      openBotsPage = () => { scope.layout.selectPanel('kode-bots') }
      openMemoryPage = () => { scope.layout.selectPanel('kode-memory') }
      openKodeSettings = section => {
        requestedSettingsSection = section
        scope.layout.selectPanel('kode-settings')
        window.dispatchEvent(new CustomEvent('kode-settings-navigate'))
      }
      const onMemoryShortcut = event => {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'm') {
          event.preventDefault()
          scope.layout.selectPanel('kode-memory')
        }
      }
      window.addEventListener?.('keydown', onMemoryShortcut)
      scope.effect(() => () => {
        closeKodePanel = undefined
        openKodeSettings = undefined
        openMemoryPage = undefined
        window.removeEventListener?.('keydown', onMemoryShortcut)
      }, 'kode.settings-panel')
    })
    ctx.slots.inject('conversation.input.model', () => ctx.slots.register({ name: 'conversation.input.model', inject: sessionId => ({ sessionId, sessions: ctx.sessions }) }, ModelControl))
  } }
} })
