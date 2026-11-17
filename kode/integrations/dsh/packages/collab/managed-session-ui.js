import React from 'react'
import { IconButton } from './icons.js'
import { createManagedSessionNavigation, managedSessionReason } from './managed-session-navigation.js'
const h = React.createElement
export function installManagedSessionUi(ctx, selectMode, returnProcess) {
  const blocks = ctx.get('conversation')?.blocks, workspace = ctx.get('uiWorkspace')
  if (!blocks?.set || !blocks.storeFor || typeof workspace?.openSession !== 'function') return null
  const navigation = createManagedSessionNavigation({ blocks, workspace, sessions: ctx.get('sessions'), selectMode, returnProcess })
  function ManagedSessionBanner({ sessionId }) {
    const [state, setState] = React.useState('loading'), [version, setVersion] = React.useState(0)
    const [returnError, setReturnError] = React.useState(''), [returning, setReturning] = React.useState(false)
    const link = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
    React.useEffect(() => {
      if (!sessionId) return
      const controller = new AbortController()
      navigation.block(sessionId, '正在核对会话管理状态…')
      setState('loading')
      setReturnError(''); setReturning(false)
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
    const back = async () => {
      setReturning(true); setReturnError('')
      try { await navigation.returnToProcess(sessionId) }
      catch { setReturnError('无法核对任务读取权限或归属，请从原入口重新打开。') }
      finally { setReturning(false) }
    }
    return h('div', { className: 'kode-managed-session-banner', role: 'status' },
      h('p', null, state === 'managed' ? managedSessionReason : state === 'error' ? '无法核对会话管理状态，输入暂时受限。' : '正在核对会话管理状态…'),
      state === 'managed' && link?.sessionId === sessionId && h('button', { type: 'button', className: 'kode-collab-button', disabled: returning, onClick: () => void back() }, '返回任务工作过程'),
      returnError && h('p', null, returnError),
      state === 'error' && h(IconButton, { icon: 'refresh', label: '重试会话检查', onClick: () => setVersion(value => value + 1) }))
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'kode-managed-session', inject: sessionId => ({ sessionId }) }, ManagedSessionBanner))
  ctx.effect(() => navigation.close, 'kode.managed-session-ui')
  return navigation
}
