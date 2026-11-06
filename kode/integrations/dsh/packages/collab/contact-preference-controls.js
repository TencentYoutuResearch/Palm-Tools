import React from 'react'
import { changeContactPreference, contactPreferenceKey, verifyContactIntent } from './contact-preference.js'
const h = React.createElement

export function ContactPreferenceControls({ team, storage, onChanged }) {
  const [preference, setPreference] = React.useState(team.contact?.preference)
  const [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const running = React.useRef(false)
  const active = React.useRef(null)
  React.useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    void storage.read(contactPreferenceKey(team)).then(value => {
      if (controller.signal.aborted) return
      if (value) verifyContactIntent(value, team)
      setPending(value?.state === 'prepared' ? value : null)
      setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取联系人设置记录，请重新打开此对话。') })
    return () => controller.abort()
  }, [team.home_hub, team.id])
  React.useEffect(() => { setPreference(team.contact?.preference) }, [team.contact?.preference])

  const change = async action => {
    if (running.current || !ready || !preference) return
    running.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await changeContactPreference({ storage, team: { ...team, contact: { ...team.contact, preference } },
        action, requestId: pending?.request_id ?? crypto.randomUUID(), signal: active.current.signal })
      if (active.current.signal.aborted) return
      setPreference(result.preference)
      setPending(null)
      setMessage(result.superseded ? '原请求未生效，联系人设置已更新。请核对后重新操作。' : '联系人设置已保存。')
      await onChanged()
    } catch {
      if (!active.current.signal.aborted) {
        setMessage('联系人设置结果尚未确认，请恢复原请求。')
        try {
          const value = await storage.read(contactPreferenceKey(team))
          if (value) verifyContactIntent(value, team)
          setPending(value?.state === 'prepared' ? value : null)
        } catch { setReady(false) }
      }
    } finally {
      running.current = false
      if (!active.current.signal.aborted) setBusy(false)
    }
  }
  if (!preference) return null
  return h('div', { className: 'kode-collab-contact-preferences' },
    pending ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void change(pending.command.action) }, '恢复原联系人设置请求') :
      h(React.Fragment, null,
        h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !ready, onClick: () => void change(preference.pinned ? 'unpin' : 'pin') }, preference.pinned ? '取消置顶' : '置顶联系人'),
        h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !ready, onClick: () => void change(preference.archived ? 'unarchive' : 'archive') }, preference.archived ? '移出归档' : '归档联系人')),
    h('p', { className: 'kode-collab-note' }, '归档保留对话和任务。有在途任务或新消息时，联系人继续显示在主列表。'),
    message && h('p', { role: 'status' }, message))
}
