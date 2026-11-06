import React from 'react'
import { createManagedSessionNavigation, managedSessionReason } from './managed-session-navigation.js'
const h = React.createElement
export function installManagedSessionUi(ctx, selectMode) {
  const blocks = ctx.get('conversation')?.blocks, workspace = ctx.get('uiWorkspace')
  if (!blocks?.set || !blocks.storeFor || typeof workspace?.openSession !== 'function') return null
  const navigation = createManagedSessionNavigation({ blocks, workspace, sessions: ctx.get('sessions'), selectMode })
  function ManagedSessionBanner({ sessionId }) {
    const [state, setState] = React.useState('loading'), [version, setVersion] = React.useState(0)
    React.useEffect(() => {
      if (!sessionId) return
      const controller = new AbortController()
      navigation.block(sessionId, '正在核对会话管理状态…')
      setState('loading')
      void navigation.read(sessionId, controller.signal).then(value => {
        if (controller.signal.aborted || navigation.closed) return
        if (value.read_only) { navigation.block(sessionId, managedSessionReason); setState('managed') }
        else { navigation.clear(sessionId); setState('ordinary') }
      }).catch(() => {
        if (!controller.signal.aborted && !navigation.closed) { navigation.block(sessionId, '无法核对会话管理状态，请重试。'); setState('error') }
      })
      return () => controller.abort()
    }, [sessionId, version])
    if (state === 'ordinary') return null
    return h('div', { className: 'kode-managed-session-banner', role: 'status' },
      h('p', null, state === 'managed' ? managedSessionReason : state === 'error' ? '无法核对会话管理状态，输入暂时受限。' : '正在核对会话管理状态…'),
      state === 'error' && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => setVersion(value => value + 1) }, '重试会话检查'))
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'kode-managed-session', inject: sessionId => ({ sessionId }) }, ManagedSessionBanner))
  ctx.effect(() => navigation.close, 'kode.managed-session-ui')
  return navigation
}
