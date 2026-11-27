  // Kode Account (primary) + DSH native account (secondary) + Multi-Device Switching.
  const KODE_RELAY_STORAGE_KEY = 'kode.accountRelayUrl'

  async function kodeAccountFetch(path, body) {
    const init = body !== undefined
      ? { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' }
    const response = await fetch(path, init)
    const value = await parseHostJson(response)
    if (!response.ok) throw Object.assign(new Error(value.error ?? '请求失败，请重试。'), { code: value.code, status: response.status })
    return value
  }

  let kodeAccountSnapshot = { status: null, loaded: false, error: '' }
  let kodeAccountPending = null
  const kodeAccountListeners = new Set()
  const kodeAccountStore = {
    subscribe: fn => { kodeAccountListeners.add(fn); return () => kodeAccountListeners.delete(fn) },
    getSnapshot: () => kodeAccountSnapshot,
  }
  function publishKodeAccount(next) {
    kodeAccountSnapshot = next
    for (const fn of kodeAccountListeners) fn()
  }
  async function refreshKodeAccount() {
    if (kodeAccountPending) return kodeAccountPending
    kodeAccountPending = kodeAccountFetch('/api/kode/account/status')
      .then(status => { publishKodeAccount({ status, loaded: true, error: '' }); return status })
      .catch(error => { publishKodeAccount({ ...kodeAccountSnapshot, loaded: true, error: error.message }); return null })
      .finally(() => { kodeAccountPending = null })
    return kodeAccountPending
  }
  function useKodeAccount() {
    const snap = useSyncExternalStore(kodeAccountStore.subscribe, kodeAccountStore.getSnapshot)
    useEffect(() => {
      void refreshKodeAccount()
      const timer = setInterval(() => { if (!document.hidden) void refreshKodeAccount() }, 15000)
      return () => clearInterval(timer)
    }, [])
    return snap
  }
  function activeAccountBackend(status) {
    if (!status) return null
    const list = Array.isArray(status.backends) ? status.backends : []
    return list.find(b => b.active && b.kind === 'account_relay')
      ?? list.find(b => b.kind === 'account_relay')
      ?? null
  }
  function isKodeAccountSignedIn(status) {
    return Boolean(activeAccountBackend(status) || status?.account_email || status?.account_label || status?.account_name)
  }
  function kodeAccountDisplayName(status) {
    const backend = activeAccountBackend(status)
    return (status?.account_name || status?.account_label || status?.account_email || backend?.account_label || backend?.account_email || '').trim()
  }

  // Secondary DSH native account bridge captured when wrapping `settings.launcher`.
  let dshSecondaryBridge = { signedIn: false, label: '', openSettings: null, signIn: null, signOut: null }
  const dshSecondaryListeners = new Set()
  const dshSecondaryStore = {
    subscribe: fn => { dshSecondaryListeners.add(fn); return () => dshSecondaryListeners.delete(fn) },
    getSnapshot: () => dshSecondaryBridge,
  }
  function updateDshSecondaryBridge(next) {
    if (
      dshSecondaryBridge.signedIn === next.signedIn
      && dshSecondaryBridge.label === next.label
      && dshSecondaryBridge.openSettings === next.openSettings
      && dshSecondaryBridge.signIn === next.signIn
      && dshSecondaryBridge.signOut === next.signOut
    ) return
    dshSecondaryBridge = next
    for (const fn of dshSecondaryListeners) fn()
  }
  function useDshSecondaryAccount() {
    return useSyncExternalStore(dshSecondaryStore.subscribe, dshSecondaryStore.getSnapshot)
  }

  // Multi-device state: activeAccountDevice = null means local ("此设备");
  // non-null selects another Kode desktop signed into the same account.
  let devicesSnapshot = { devices: [], selfDeviceId: '', activeDeviceId: null, loaded: false, loading: false, error: '' }
  let devicesPending = null
  const devicesListeners = new Set()
  const devicesStore = {
    subscribe: fn => { devicesListeners.add(fn); return () => devicesListeners.delete(fn) },
    getSnapshot: () => devicesSnapshot,
  }
  function publishDevices(next) {
    devicesSnapshot = next
    for (const fn of devicesListeners) fn()
  }
  async function refreshAccountDevices() {
    if (devicesPending) return devicesPending
    publishDevices({ ...devicesSnapshot, loading: true, error: '' })
    devicesPending = kodeAccountFetch('/api/kode/devices', { action: 'devices' })
      .then(result => {
        const list = Array.isArray(result?.devices) ? result.devices : []
        const selfId = String(result?.self_device_id ?? '')
        const activeStillValid = !devicesSnapshot.activeDeviceId || list.some(d => d.device_id === devicesSnapshot.activeDeviceId)
        publishDevices({
          devices: list,
          selfDeviceId: selfId,
          activeDeviceId: activeStillValid ? devicesSnapshot.activeDeviceId : null,
          loaded: true,
          loading: false,
          error: '',
        })
        return list
      })
      .catch(error => {
        publishDevices({ ...devicesSnapshot, loaded: true, loading: false, error: error.message })
        return []
      })
      .finally(() => { devicesPending = null })
    return devicesPending
  }
  function selectAccountDevice(deviceId) {
    const nextId = deviceId && deviceId !== devicesSnapshot.selfDeviceId ? deviceId : null
    if (devicesSnapshot.activeDeviceId === nextId) {
      if (nextId) closeKodePanel?.()
      return
    }
    publishDevices({ ...devicesSnapshot, activeDeviceId: nextId })
    if (sharedTarget?.kind === 'remote-device' && sharedTarget.device?.device_id !== nextId) {
      showShared(null)
    }
    if (nextId) closeKodePanel?.()
  }
  function useAccountDevices(enabled) {
    const snap = useSyncExternalStore(devicesStore.subscribe, devicesStore.getSnapshot)
    useEffect(() => {
      if (!enabled) {
        if (devicesSnapshot.activeDeviceId) selectAccountDevice(null)
        return
      }
      void refreshAccountDevices()
      const timer = setInterval(() => { if (!document.hidden) void refreshAccountDevices() }, 20000)
      return () => clearInterval(timer)
    }, [enabled])
    return snap
  }

  function kodeSyncStateLabel(status) {
    const backend = activeAccountBackend(status)
    if (backend && backend.active === false) return { text: '未启用同步', tone: 'warn' }
    const state = status?.state ?? ''
    if (state === 'syncing' || status?.sync_enabled) return { text: '同步中', tone: 'online' }
    if (state === 'standby' || status?.connected) return { text: '在线待机', tone: 'online' }
    if (state === 'connecting' || state === 'reconnecting') return { text: '连接中…', tone: 'warn' }
    if (status?.last_error) return { text: '连接异常', tone: 'error' }
    return { text: '已登录', tone: 'idle' }
  }

  function accountInitial(label) {
    const trimmed = String(label ?? '').trim()
    if (!trimmed) return 'K'
    return Array.from(trimmed)[0].toUpperCase()
  }

  // Primary bottom-left sidebar launcher: Kode Account first; DSH native account demoted to secondary menu item.
  function KodeAccountLauncher({ native, ...props }) {
    const { status } = useKodeAccount()
    const signedIn = isKodeAccountSignedIn(status)
    const displayName = kodeAccountDisplayName(status)
    const syncInfo = kodeSyncStateLabel(status)
    const devicesSnap = useAccountDevices(signedIn)
    const [menuOpen, setMenuOpen] = useState(false)
    const [signingOut, setSigningOut] = useState(false)
    const [dshModalOpen, setDshModalOpen] = useState(false)
    const wide = props.wide !== false

    // Read DSH's native DeepSeek account state via injected hook if available.
    const dshAccount = typeof props.useAccount === 'function' ? props.useAccount(state => state) : null
    const dshSignedIn = dshAccount?.view?.status === 'credential-stored'
    const dshProfile = dshAccount?.details?.profile
    const dshLabel = dshProfile?.status === 'ready'
      ? (dshProfile.value?.name || dshProfile.value?.contact || '已登录')
      : (dshSignedIn ? '已登录' : '未登录')

    useEffect(() => {
      updateDshSecondaryBridge({
        signedIn: Boolean(dshSignedIn),
        label: dshLabel,
        openSettings: typeof props.openSettings === 'function' ? () => props.openSettings() : null,
        signIn: typeof props.start === 'function' ? () => { void props.start().catch(() => undefined) } : null,
        signOut: typeof props.signOut === 'function' ? () => props.signOut() : null,
      })
    }, [dshSignedIn, dshLabel, props.openSettings, props.start, props.signOut])

    const otherDevices = devicesSnap.devices.filter(d => d.device_id !== devicesSnap.selfDeviceId)
    const onlineOthers = otherDevices.filter(d => d.online).length

    const signOutKode = async () => {
      const backend = activeAccountBackend(status)
      if (!backend) return
      setSigningOut(true)
      try {
        await kodeAccountFetch('/api/kode/account', { action: 'sign_out', backend_id: backend.id })
        selectAccountDevice(null)
        await refreshKodeAccount()
      } finally {
        setSigningOut(false)
      }
    }

    const items = [
      { id: 'kode-account', label: signedIn ? `Kode 账号 · ${displayName}` : '登录 Kode 账号', icon: h(IconUsersOutlineRegular, { size: 14 }) },
      ...(signedIn ? [{ id: 'kode-devices', label: onlineOthers > 0 ? `多设备切换（${onlineOthers} 台在线）` : '多设备切换', icon: h(RemoteComputerIcon, { size: 14 }) }] : []),
      { id: 'kode-mobile', label: '手机与同步', icon: h(IconGlobeOutlineRegular, { size: 14 }) },
      { id: 'dsh-secondary', label: `DSH 账号（二级管理 · ${dshSignedIn ? dshLabel : '未登录'}）`, icon: h(IconApiOutlineRegular, { size: 14 }) },
      { id: 'kode-settings', label: 'Kode 设置', icon: h(IconAgentPresetOutlineRegular, { size: 14 }) },
      ...(signedIn ? [{ id: 'kode-signout', label: signingOut ? '正在退出…' : '退出 Kode 账号', icon: h(IconCloseOutlineRegular, { size: 14 }), disabled: signingOut }] : []),
    ]

    return h('div', { className: 'kode-account-launcher', 'data-collapsed': !wide },
      // Keep native launcher invisibly mounted so DSH native login/signout modals & effects remain alive.
      native && h('div', { className: 'kode-dsh-native-host', 'aria-hidden': !dshAccount?.loginVisible || undefined }, h(native, props)),
      h(Menu, {
        open: menuOpen,
        side: 'top',
        portal: true,
        autoFocus: true,
        items,
        onClose: () => setMenuOpen(false),
        onSelect: id => {
          setMenuOpen(false)
          if (id === 'kode-account') openKodeSettings?.('account')
          else if (id === 'kode-devices') openKodeSettings?.('account')
          else if (id === 'kode-mobile') openKodeSettings?.('mobile')
          else if (id === 'kode-settings') openKodeSettings?.('general')
          else if (id === 'dsh-secondary') setDshModalOpen(true)
          else if (id === 'kode-signout') void signOutKode()
        },
        anchor: h('button', {
          type: 'button',
          className: 'kode-account-trigger',
          'data-collapsed': !wide,
          'data-signed-in': signedIn,
          'aria-label': signedIn ? `Kode 账号：${displayName}` : '登录 Kode 账号',
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          onClick: () => setMenuOpen(v => !v),
        },
          h('span', { className: 'kode-account-avatar' },
            status?.account_picture
              ? h('img', { src: status.account_picture, alt: '' })
              : h('span', null, signedIn ? accountInitial(displayName) : 'K'),
            h('span', { className: `kode-account-dot kode-dot-${signedIn ? syncInfo.tone : 'off'}`, 'aria-hidden': true }),
          ),
          wide && h('span', { className: 'kode-account-copy' },
            h('span', { className: 'kode-account-name' }, signedIn ? displayName : '登录 Kode 账号'),
            h('span', { className: 'kode-account-sub' }, signedIn
              ? `${syncInfo.text}${onlineOthers > 0 ? ` · ${onlineOthers} 台设备在线` : ''}`
              : '跨设备同步与远程切换'),
          ),
        ),
      }),
      dshModalOpen && h(Modal, {
        open: true,
        title: 'DSH 账号（二级管理）',
        closeLabel: '关闭',
        className: 'kode-secondary-account-modal',
        onClose: () => setDshModalOpen(false),
        footer: h(Button, { variant: 'outline', onClick: () => setDshModalOpen(false) }, '关闭'),
      },
        h('p', { className: 'kode-config-note' }, 'Kode 账号是当前工作台的主账号（用于手机同步与多设备切换）。DeepSeek Harness（DSH）原生账号作为二级管理，仅在需要 DeepSeek 模型服务或 DSH 原生设置时使用。'),
        h('div', { className: 'kode-settings-card kode-settings-card-padded' },
          h('div', { className: 'kode-secondary-row' },
            h('div', null,
              h('strong', null, 'DeepSeek Harness 账号'),
              h('p', { className: 'kode-config-note' }, dshSignedIn ? `已登录：${dshLabel}` : '当前未登录 DSH 原生账号')),
            h('div', { className: 'kode-secondary-actions' },
              typeof props.openSettings === 'function' && h(Button, {
                size: 'sm', variant: 'outline',
                onClick: () => { setDshModalOpen(false); props.openSettings() },
              }, '打开 DSH 原生设置'),
              !dshSignedIn && typeof props.start === 'function' && h(Button, {
                size: 'sm', variant: 'primary',
                onClick: () => { setDshModalOpen(false); void props.start().catch(() => undefined) },
              }, '登录 DSH 账号'),
              dshSignedIn && typeof props.signOut === 'function' && h(Button, {
                size: 'sm', variant: 'outline', className: 'kode-delete',
                onClick: () => { setDshModalOpen(false); void props.signOut() },
              }, '退出 DSH 账号'),
            ),
          ),
        ),
      ),
    )
  }

  // Full Kode Account + Multi-Device + Secondary DSH Account management inside KodeSettings.
  function AccountSettingsBody() {
    const { status, error: loadError } = useKodeAccount()
    const dshSecondary = useDshSecondaryAccount()
    const signedIn = isKodeAccountSignedIn(status)
    const activeBackend = activeAccountBackend(status)
    const devicesSnap = useAccountDevices(signedIn)

    const [relayUrl, setRelayUrl] = useState(() => {
      try { return localStorage.getItem(KODE_RELAY_STORAGE_KEY) || '' } catch { return '' }
    })
    const [supportedMethods, setSupportedMethods] = useState(['email', 'palmx', 'palm'])
    const [method, setMethod] = useState('email')
    const [email, setEmail] = useState('')
    const [code, setCode] = useState('')
    const [codeSent, setCodeSent] = useState(false)
    const [qrFlow, setQrFlow] = useState(null) // { kind: 'palmx' | 'palm' | 'bind', qr_data_url, qr_payload, state }
    const [linked, setLinked] = useState([])
    const [nameDraft, setNameDraft] = useState('')
    const [editingName, setEditingName] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [message, setMessage] = useState('')

    useEffect(() => {
      const configured = activeBackend?.server_url || status?.server_url || ''
      if (configured && !relayUrl) {
        setRelayUrl(configured)
        return
      }
      if (!relayUrl) {
        void kodeAccountFetch('/api/kode/account', { action: 'default_relay' })
          .then(res => {
            const url = String(res?.server_url ?? '').trim()
            if (url) setRelayUrl(prev => prev || url)
          })
          .catch(() => {})
      }
    }, [activeBackend?.server_url, status?.server_url])

    useEffect(() => {
      const trimmed = relayUrl.trim()
      if (signedIn || !/^https?:\/\/\S+/i.test(trimmed)) return
      let alive = true
      const timer = setTimeout(() => {
        void kodeAccountFetch('/api/kode/account', { action: 'methods', server_url: trimmed })
          .then(res => {
            if (!alive) return
            const raw = Array.isArray(res?.methods) ? res.methods : []
            const allowed = raw.filter(m => ['email', 'palmx', 'palm'].includes(m))
            if (allowed.length) {
              setSupportedMethods(allowed)
              setMethod(prev => allowed.includes(prev) ? prev : allowed[0])
            }
          })
          .catch(() => {})
      }, 250)
      return () => { alive = false; clearTimeout(timer) }
    }, [relayUrl, signedIn])

    useEffect(() => {
      if (!signedIn) { setLinked([]); return }
      void kodeAccountFetch('/api/kode/account', { action: 'linked' })
        .then(res => setLinked(Array.isArray(res?.linked) ? res.linked : []))
        .catch(() => {})
    }, [signedIn, status?.account_email])

    // Poll QR login / bind flows sequentially while active (no overlapping polls).
    useEffect(() => {
      if (!qrFlow) return
      let alive = true
      let timer = null
      const pollAction = qrFlow.kind === 'palm' ? 'palm_poll' : 'palmx_poll'
      const tick = async () => {
        try {
          const res = await kodeAccountFetch('/api/kode/account', { action: pollAction })
          if (!alive) return
          if (res?.done) {
            setQrFlow(null)
            setMessage(qrFlow.kind === 'bind' ? '已绑定 PalmX 登录方式。' : '登录成功。')
            await refreshKodeAccount()
            void refreshAccountDevices()
            if (qrFlow.kind === 'bind') {
              void kodeAccountFetch('/api/kode/account', { action: 'linked' }).then(r => setLinked(Array.isArray(r?.linked) ? r.linked : [])).catch(() => {})
            }
            return
          }
          if (res?.state === 'denied') {
            setQrFlow(null)
            setError('已在手机端拒绝登录请求。')
            return
          }
          if (res?.state === 'expired' || res?.state === 'failed' || res?.state === 'cancelled') {
            setQrFlow(null)
            setError('二维码已过期或取消，请重新生成。')
            return
          }
          if (res?.state) {
            setQrFlow(prev => prev ? { ...prev, state: res.state } : null)
          }
        } catch (err) {
          if (alive) { setQrFlow(null); setError(err.message) }
          return
        }
        if (alive) timer = setTimeout(() => { void tick() }, 1500)
      }
      timer = setTimeout(() => { void tick() }, 1500)
      return () => { alive = false; if (timer) clearTimeout(timer) }
    }, [qrFlow?.kind, qrFlow?.qr_payload])

    const saveRelayUrl = url => {
      setRelayUrl(url)
      try { if (url.trim()) localStorage.setItem(KODE_RELAY_STORAGE_KEY, url.trim()) } catch {}
    }

    const sendCode = async () => {
      if (!relayUrl.trim() || !email.trim()) { setError('请先填写中继地址和邮箱。'); return }
      setBusy(true); setError(''); setMessage('')
      try {
        saveRelayUrl(relayUrl)
        await kodeAccountFetch('/api/kode/account', { action: 'code', server_url: relayUrl.trim(), email: email.trim() })
        setCodeSent(true)
        setMessage('验证码已发送到邮箱，请查收。')
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const verifyCode = async event => {
      event?.preventDefault()
      if (!code.trim()) return
      setBusy(true); setError(''); setMessage('')
      try {
        await kodeAccountFetch('/api/kode/account', { action: 'sign_in', code: code.trim() })
        setCode(''); setCodeSent(false); setMessage('已登录 Kode 账号。')
        await refreshKodeAccount()
        void refreshAccountDevices()
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const startQr = async kind => {
      if (kind !== 'bind' && !relayUrl.trim()) { setError('请先填写中继服务地址。'); return }
      setBusy(true); setError(''); setMessage('')
      try {
        if (relayUrl.trim()) saveRelayUrl(relayUrl)
        const payload = kind === 'palm'
          ? { action: 'palm_start', server_url: relayUrl.trim() }
          : kind === 'bind'
            ? { action: 'palmx_start', purpose: 'bind' }
            : { action: 'palmx_start', server_url: relayUrl.trim(), purpose: 'sign_in' }
        const res = await kodeAccountFetch('/api/kode/account', payload)
        setQrFlow({ kind, qr_data_url: res.qr_data_url, qr_payload: res.qr_payload, state: res.state || 'pending' })
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const cancelQr = async () => {
      const kind = qrFlow?.kind
      setQrFlow(null)
      if (!kind) return
      try { await kodeAccountFetch('/api/kode/account', { action: kind === 'palm' ? 'palm_cancel' : 'palmx_cancel' }) } catch {}
    }

    const saveName = async event => {
      event?.preventDefault()
      if (!nameDraft.trim()) return
      setBusy(true); setError('')
      try {
        await kodeAccountFetch('/api/kode/account', { action: 'name', name: nameDraft.trim() })
        setEditingName(false)
        await refreshKodeAccount()
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const signOut = async () => {
      if (!activeBackend) return
      setBusy(true); setError('')
      try {
        await kodeAccountFetch('/api/kode/account', { action: 'sign_out', backend_id: activeBackend.id })
        selectAccountDevice(null)
        await refreshKodeAccount()
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const unbindPalmx = async () => {
      setBusy(true); setError('')
      try {
        await kodeAccountFetch('/api/kode/account', { action: 'palmx_unbind' })
        setLinked(prev => prev.filter(m => m !== 'palmx'))
        setMessage('已解绑 PalmX。')
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const activateBackend = async () => {
      if (!activeBackend) return
      setBusy(true); setError(''); setMessage('')
      try {
        await kodeAccountFetch('/api/kode/account', { action: 'activate', backend_id: activeBackend.id })
        setMessage('已启用 Kode 账号同步。')
        await refreshKodeAccount()
        void refreshAccountDevices()
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const displayName = kodeAccountDisplayName(status)
    const syncInfo = kodeSyncStateLabel(status)
    const methodItems = [['email', '邮箱验证码'], ['palmx', 'PalmX 扫码'], ['palm', '手机掌纹接力']]
      .filter(([id]) => supportedMethods.includes(id))

    return h('div', { className: 'kode-account-settings' },
      h('div', { className: 'kode-settings-group' },
        h('h3', { className: 'kode-settings-group-title' }, 'Kode 主账号'),
        signedIn
          ? h('div', { className: 'kode-settings-card kode-settings-card-padded' },
              h('div', { className: 'kode-account-profile-head' },
                h('span', { className: 'kode-account-avatar kode-account-avatar-lg' },
                  status?.account_picture ? h('img', { src: status.account_picture, alt: '' }) : h('span', null, accountInitial(displayName)),
                  h('span', { className: `kode-account-dot kode-dot-${syncInfo.tone}` }),
                ),
                h('div', { className: 'kode-account-profile-meta' },
                  editingName
                    ? h('form', { className: 'kode-inline-edit', onSubmit: saveName },
                        h('input', { value: nameDraft, autoFocus: true, placeholder: '显示名称', onChange: e => setNameDraft(e.target.value) }),
                        h(Button, { type: 'submit', size: 'sm', variant: 'primary', disabled: busy || !nameDraft.trim() }, '保存'),
                        h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => setEditingName(false) }, '取消'),
                      )
                    : h('div', { className: 'kode-account-title-row' },
                        h('strong', null, displayName || 'Kode 用户'),
                        h('span', { className: `kode-pill kode-pill-${syncInfo.tone}` }, syncInfo.text),
                        h(Button, { size: 'sm', variant: 'outline', onClick: () => { setNameDraft(displayName); setEditingName(true) } }, '修改名称'),
                      ),
                  h('p', { className: 'kode-config-note' }, [status?.account_email, activeBackend?.server_url || status?.server_url].filter(Boolean).join(' · ')),
                ),
                h('div', { className: 'kode-account-profile-actions' },
                  activeBackend && activeBackend.active === false && h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => void activateBackend() }, '启用此账号同步'),
                  kodeEmbedded() && h(Button, { size: 'sm', variant: 'outline', onClick: () => window.kodeHost?.request('open-account', { tab: 'account' }) }, '在 Kode 窗口管理'),
                  h(Button, { size: 'sm', variant: 'outline', className: 'kode-delete', disabled: busy, onClick: () => void signOut() }, '退出登录'),
                ),
              ),
              h('div', { className: 'kode-account-linked-row' },
                h('span', { className: 'kode-config-note' }, `已绑定方式：${linked.length ? linked.join('、') : (status?.account_method || '默认')}`),
                linked.includes('palmx')
                  ? h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void unbindPalmx() }, '解绑 PalmX')
                  : h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void startQr('bind') }, '绑定 PalmX 扫码'),
              ),
              qrFlow?.kind === 'bind' && h('div', { className: 'kode-qr-box' },
                qrFlow.qr_data_url && h('img', { src: qrFlow.qr_data_url, alt: 'PalmX 绑定二维码', className: 'kode-qr-image' }),
                h('p', { className: 'kode-config-note' }, qrFlow.state === 'scanned' ? '已扫码，请在手机端确认绑定…' : '请使用 PalmX 扫码完成绑定…'),
                h(Button, { size: 'sm', variant: 'outline', onClick: () => void cancelQr() }, '取消'),
              ),
            )
          : h('div', { className: 'kode-settings-card kode-settings-card-padded' },
              h('p', { className: 'kode-config-note' }, '登录 Kode 账号后，可在多台桌面设备与手机 App 之间同步会话、伙伴、头像与背景，并在侧边栏直接切换查看其他设备。'),
              h('label', { className: 'kode-field' }, '账号中继地址',
                h('input', { type: 'url', value: relayUrl, placeholder: 'https://relay.example.com', onChange: e => setRelayUrl(e.target.value) })),
              h('div', { className: 'kode-method-tabs', role: 'tablist' },
                ...methodItems.map(([id, label]) =>
                  h('button', {
                    key: id, type: 'button', role: 'tab', 'aria-selected': method === id,
                    className: `kode-method-tab${method === id ? ' is-active' : ''}`,
                    onClick: () => { setMethod(id); setError(''); setMessage(''); if (qrFlow) void cancelQr() },
                  }, label),
                ),
              ),
              method === 'email' && h('form', { className: 'kode-account-form', onSubmit: verifyCode },
                h('div', { className: 'kode-field-row' },
                  h('input', { type: 'email', value: email, placeholder: 'name@example.com', disabled: busy, onChange: e => setEmail(e.target.value) }),
                  h(Button, { type: 'button', variant: 'outline', disabled: busy || !email.trim() || !relayUrl.trim(), onClick: () => void sendCode() }, codeSent ? '重新发送' : '发送验证码'),
                ),
                codeSent && h('div', { className: 'kode-field-row' },
                  h('input', { value: code, placeholder: '输入 6 位验证码', disabled: busy, onChange: e => setCode(e.target.value) }),
                  h(Button, { type: 'submit', variant: 'primary', disabled: busy || !code.trim() }, busy ? '登录中…' : '登录'),
                ),
              ),
              (method === 'palmx' || method === 'palm') && h('div', { className: 'kode-qr-panel' },
                qrFlow
                  ? h('div', { className: 'kode-qr-box' },
                      qrFlow.qr_data_url && h('img', { src: qrFlow.qr_data_url, alt: '登录二维码', className: 'kode-qr-image' }),
                      h('p', { className: 'kode-config-note' }, qrFlow.state === 'scanned'
                        ? '已扫码，请在手机端确认登录…'
                        : (method === 'palm' ? '请使用 Kode 手机 App 扫码并完成掌纹验证…' : '请使用 PalmX 扫码确认登录…')),
                      h(Button, { size: 'sm', variant: 'outline', onClick: () => void cancelQr() }, '取消'),
                    )
                  : h('div', { className: 'kode-secondary-actions' },
                      h(Button, { variant: 'primary', disabled: busy || !relayUrl.trim(), onClick: () => void startQr(method) }, method === 'palm' ? '生成掌纹接力二维码' : '生成 PalmX 登录二维码'),
                      kodeEmbedded() && h(Button, { variant: 'outline', onClick: () => window.kodeHost?.request('open-account', { tab: 'account' }) }, '在 Kode 窗口登录'),
                    ),
              ),
            ),
      ),

      signedIn && h('div', { className: 'kode-settings-group' },
        h('div', { className: 'kode-group-head-row' },
          h('h3', { className: 'kode-settings-group-title' }, '多设备切换'),
          h(Button, { size: 'sm', variant: 'outline', disabled: devicesSnap.loading, onClick: () => void refreshAccountDevices() }, devicesSnap.loading ? '刷新中…' : '刷新设备'),
        ),
        h('div', { className: 'kode-settings-card kode-settings-card-padded' },
          devicesSnap.devices.length === 0
            ? h('p', { className: 'kode-config-note' }, devicesSnap.loading ? '正在读取账号设备…' : '当前仅此设备登录了该账号。在另一台电脑登录同一 Kode 账号后即可在此切换。')
            : h('ul', { className: 'kode-device-list' },
                ...devicesSnap.devices.map(device => {
                  const isSelf = device.device_id === devicesSnap.selfDeviceId
                  const isSelected = isSelf ? !devicesSnap.activeDeviceId : devicesSnap.activeDeviceId === device.device_id
                  return h('li', { key: device.device_id, className: `kode-device-row${isSelected ? ' is-selected' : ''}` },
                    h('div', { className: 'kode-device-row-main' },
                      h('span', { className: `kode-account-dot kode-dot-${device.online || isSelf ? 'online' : 'off'}` }),
                      h('div', null,
                        h('strong', null, device.name || device.device_id, isSelf && h('span', { className: 'kode-agent-tag' }, '此设备')),
                        h('p', { className: 'kode-config-note' }, isSelf ? '当前本地工作台' : (device.online ? '在线 · 可查看并对话' : '离线')),
                      ),
                    ),
                    h(Button, {
                      size: 'sm',
                      variant: isSelected ? 'primary' : 'outline',
                      disabled: isSelected,
                      onClick: () => selectAccountDevice(isSelf ? null : device.device_id),
                    }, isSelected ? '当前查看' : (isSelf ? '切回此设备' : '切换查看')),
                  )
                }),
              ),
          devicesSnap.error && h(Failure, { text: devicesSnap.error }),
        ),
      ),

      h('div', { className: 'kode-settings-group' },
        h('h3', { className: 'kode-settings-group-title' }, 'DSH 账号（二级管理）'),
        h('div', { className: 'kode-settings-card kode-settings-card-padded' },
          h('div', { className: 'kode-secondary-row' },
            h('div', null,
              h('strong', null, 'DeepSeek Harness 原生账号'),
              h('p', { className: 'kode-config-note' }, dshSecondary.signedIn ? `已登录：${dshSecondary.label}` : '未登录（仅在使用 DeepSeek 内置模型/原生服务时需要）'),
            ),
            h('div', { className: 'kode-secondary-actions' },
              dshSecondary.openSettings && h(Button, { size: 'sm', variant: 'outline', onClick: () => dshSecondary.openSettings() }, 'DSH 原生设置'),
              !dshSecondary.signedIn && dshSecondary.signIn && h(Button, { size: 'sm', variant: 'outline', onClick: () => dshSecondary.signIn() }, '登录 DSH 账号'),
              dshSecondary.signedIn && dshSecondary.signOut && h(Button, { size: 'sm', variant: 'outline', className: 'kode-delete', onClick: () => void dshSecondary.signOut() }, '退出 DSH 账号'),
            ),
          ),
        ),
      ),

      message && h('p', { className: 'kode-config-note kode-success-note', role: 'status' }, message),
      h(Failure, { text: error || loadError }),
    )
  }

  // Compact multi-device switcher bar rendered at the top of the DSH sidebar.
  function DeviceSwitcherBar({ wide = true }) {
    const { status } = useKodeAccount()
    const signedIn = isKodeAccountSignedIn(status)
    const devicesSnap = useAccountDevices(signedIn)
    const [open, setOpen] = useState(false)

    if (!signedIn && !devicesSnap.activeDeviceId) return null

    const selfDevice = devicesSnap.devices.find(d => d.device_id === devicesSnap.selfDeviceId)
    const otherDevices = devicesSnap.devices.filter(d => d.device_id !== devicesSnap.selfDeviceId)
    const activeRemote = devicesSnap.activeDeviceId
      ? devicesSnap.devices.find(d => d.device_id === devicesSnap.activeDeviceId) ?? { device_id: devicesSnap.activeDeviceId, name: devicesSnap.activeDeviceId, online: false }
      : null

    if (otherDevices.length === 0 && !activeRemote) return null

    const label = activeRemote ? activeRemote.name : (selfDevice?.name ? `此设备 · ${selfDevice.name}` : '此设备')
    const menuItems = [
      { id: '__local__', label: selfDevice?.name ? `此设备 · ${selfDevice.name}` : '此设备', icon: h('span', { className: 'kode-account-dot kode-dot-online' }) },
      ...otherDevices.map(d => ({
        id: d.device_id,
        label: `${d.name || d.device_id}${d.online ? '' : '（离线）'}`,
        icon: h('span', { className: `kode-account-dot kode-dot-${d.online ? 'online' : 'off'}` }),
      })),
    ]

    return h('div', { className: 'kode-device-switcher', 'data-remote': Boolean(activeRemote), 'data-collapsed': !wide },
      h(Menu, {
        open,
        portal: true,
        selectedId: activeRemote ? activeRemote.device_id : '__local__',
        items: menuItems,
        footer: [
          { id: '__refresh__', label: '刷新设备列表' },
          { id: '__manage__', label: '账号与设备设置…' },
        ],
        onClose: () => setOpen(false),
        onSelect: id => {
          setOpen(false)
          if (id === '__refresh__') { void refreshAccountDevices(); return }
          if (id === '__manage__') { openKodeSettings?.('account'); return }
          selectAccountDevice(id === '__local__' ? null : id)
        },
        anchor: h('button', {
          type: 'button',
          className: 'kode-device-switcher-btn',
          title: activeRemote ? `正在查看远端设备：${activeRemote.name}` : '切换 Kode 账号下的其他设备',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen(v => !v),
        },
          h('span', { className: `kode-account-dot kode-dot-${activeRemote ? (activeRemote.online ? 'online' : 'off') : 'online'}` }),
          wide && h('span', { className: 'kode-device-switcher-label' }, label),
          wide && h(IconChevronDownOutlineRegular, { size: 12 }),
        ),
      }),
    )
  }

  function remoteSessionLeaf(cwd) {
    const raw = String(cwd ?? '').trim().replace(/\\/g, '/')
    if (!raw) return '工作区'
    const parts = raw.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : raw
  }

  function remoteSessionProfile(s) {
    return {
      type: s?.backend_key || 'custom',
      avatar: s?.avatar_id ? { id: s.avatar_id } : null,
    }
  }

  function remoteBannerInlineStyle(library, s) {
    const banner = botBannerStyle(library, { avatar: s?.avatar_id, banner: s?.banner })
    if (!banner) return undefined
    if (banner.kind === 'gradient') return { backgroundImage: banner.css }
    if (banner.kind === 'image') return { backgroundImage: `linear-gradient(90deg, rgba(14,16,22,.82), rgba(14,16,22,.66)), url("${banner.url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    return undefined
  }

  // Sidebar browser for a selected remote Kode account desktop.
  function RemoteDeviceSidebar({ device, wide = true }) {
    const [sessions, setSessions] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const activeTarget = useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot)
    const library = useAvatarLibrary(sessions.some(s => Boolean(s.avatar_id || s.banner)))

    const load = useCallback(async () => {
      try {
        const res = await kodeAccountFetch('/api/kode/devices', { action: 'sessions', device_id: device.device_id })
        setSessions(Array.isArray(res?.sessions) ? res.sessions : [])
        setError('')
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }, [device.device_id])

    useEffect(() => {
      setLoading(true)
      void load()
      const timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
      return () => clearInterval(timer)
    }, [load])

    const botGroups = useMemo(() => {
      const byBot = new Map()
      for (const s of sessions) {
        if (!s.bot_id) continue
        if (!byBot.has(s.bot_id)) byBot.set(s.bot_id, [])
        byBot.get(s.bot_id).push(s)
      }
      return [...byBot.entries()].map(([botId, list]) => {
        const primary = list.find(r => r.bot_kind === 'main') ?? list[0]
        return { botId, primary, sessions: list }
      })
    }, [sessions])

    const groupedWorkspaces = useMemo(() => {
      const botIds = new Set(botGroups.flatMap(g => g.sessions.map(s => s.id)))
      const map = new Map()
      for (const s of sessions) {
        if (botIds.has(s.id)) continue
        const key = String(s.cwd || '__unset__')
        if (!map.has(key)) map.set(key, { key, leaf: remoteSessionLeaf(s.cwd), items: [] })
        map.get(key).items.push(s)
      }
      return [...map.values()]
    }, [sessions, botGroups])

    const openRemoteSession = session => {
      closeKodePanel?.()
      showShared({ kind: 'remote-device', device, session, host: `device:${device.device_id}` })
    }

    if (!wide) {
      return h('div', { className: 'kode-remote-sidebar-compact' },
        h(Button, { size: 'sm', variant: 'outline', title: '返回此设备', onClick: () => selectAccountDevice(null) }, '←'),
        ...sessions.slice(0, 12).map(s => {
          const selected = activeTarget?.kind === 'remote-device' && activeTarget.device.device_id === device.device_id && activeTarget.session.id === s.id
          const label = s.bot_name || s.title || s.backend_key
          return h('button', {
            key: s.id,
            type: 'button',
            title: label,
            className: `kode-remote-compact-item${selected ? ' is-active' : ''}`,
            onClick: () => openRemoteSession(s),
          }, h(AgentAvatar, { profile: remoteSessionProfile(s), size: 22, status: s.status === 'busy' ? 'running' : 'idle' }))
        }),
      )
    }

    return h('div', { className: 'kode-remote-device-sidebar' },
      h('div', { className: 'kode-remote-device-banner' },
        h('div', { className: 'kode-remote-device-banner-title' },
          h('span', { className: `kode-account-dot kode-dot-${device.online ? 'online' : 'off'}` }),
          h('strong', null, device.name || device.device_id),
        ),
        h('div', { className: 'kode-remote-device-banner-actions' },
          h(Button, { size: 'sm', variant: 'outline', onClick: () => void load() }, '刷新'),
          h(Button, { size: 'sm', variant: 'outline', onClick: () => selectAccountDevice(null) }, '返回此设备'),
        ),
      ),
      error && h(Failure, { text: error }),
      loading && sessions.length === 0 && h('p', { className: 'kode-config-note kode-remote-empty' }, '正在读取远端设备会话…'),
      !loading && !error && sessions.length === 0 && h('p', { className: 'kode-config-note kode-remote-empty' }, device.online ? '该设备暂无活跃会话。' : '该设备当前离线。'),
      botGroups.length > 0 && h('div', { className: 'kode-remote-group' },
        h('div', { className: 'kode-remote-group-head' }, '伙伴', h('span', null, botGroups.length)),
        ...botGroups.map(({ primary: s, sessions: list }) => {
          const selected = activeTarget?.kind === 'remote-device' && activeTarget.device.device_id === device.device_id && list.some(r => r.id === activeTarget.session.id)
          const busy = list.some(r => r.status === 'busy')
          return h('button', {
            key: s.id, type: 'button',
            className: `kode-remote-session-row${selected ? ' is-active' : ''}`,
            style: remoteBannerInlineStyle(library, s),
            onClick: () => openRemoteSession(s),
          },
            h(AgentAvatar, { profile: remoteSessionProfile(s), size: 22, status: busy ? 'running' : 'idle' }),
            h('span', { className: 'kode-remote-session-copy' },
              h('strong', null, s.bot_name || s.title || s.backend_key),
              h('small', null, s.bot_tagline || s.model || s.backend_key),
            ),
            list.length > 1 && h('span', { className: 'kode-pill' }, String(list.length)),
          )
        }),
      ),
      ...groupedWorkspaces.map(group => h('div', { key: group.key, className: 'kode-remote-group' },
        h('div', { className: 'kode-remote-group-head' },
          h(IconFolderCloseRegular, { size: 13 }),
          h('span', { className: 'kode-remote-group-name' }, group.leaf),
          h('span', null, group.items.length),
        ),
        ...group.items.map(s => {
          const selected = activeTarget?.kind === 'remote-device' && activeTarget.device.device_id === device.device_id && activeTarget.session.id === s.id
          return h('button', {
            key: s.id, type: 'button',
            className: `kode-remote-session-row${selected ? ' is-active' : ''}`,
            style: remoteBannerInlineStyle(library, s),
            onClick: () => openRemoteSession(s),
          },
            h(AgentAvatar, { profile: remoteSessionProfile(s), size: 20, status: s.status === 'busy' ? 'running' : 'idle' }),
            h('span', { className: 'kode-remote-session-copy' },
              h('strong', null, s.title || s.backend_key),
              h('small', null, [s.bot_name, s.model || s.backend_key].filter(Boolean).join(' · ')),
            ),
          )
        }),
      )),
    )
  }

  function RemoteDeviceEmptyState({ device }) {
    return h('section', { className: 'kode-remote-empty-stage', 'aria-label': device.name || device.device_id },
      h('div', { className: 'kode-remote-empty-card' },
        h('div', { className: 'kode-remote-device-banner-title' },
          h('span', { className: `kode-account-dot kode-dot-${device.online ? 'online' : 'off'}` }),
          h('strong', null, `正在查看远端设备：${device.name || device.device_id}`),
        ),
        h('p', { className: 'kode-config-note' }, device.online
          ? '请从左侧边栏选择该设备上的伙伴或工作区会话，即可实时查看历史并继续对话。'
          : '该设备当前离线，上线后即可在左侧查看其活跃会话。'),
        h('div', { className: 'kode-secondary-actions' },
          h(Button, { size: 'sm', variant: 'outline', onClick: () => void refreshAccountDevices() }, '刷新设备状态'),
          h(Button, { size: 'sm', variant: 'primary', onClick: () => selectAccountDevice(null) }, '切回此设备'),
        ),
      ),
    )
  }

  // Main-pane live conversation viewer for a session on another Kode account desktop.
  function RemoteDeviceConversation({ target }) {
    const { device, session } = target
    const draftKey = `remote:${device.device_id}:${session.id}`
    const [events, setEvents] = useState([])
    const [draft, setDraft] = useState(() => sharedDrafts.get(draftKey) ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const scroll = React.useRef(null)
    const aliveRef = React.useRef(true)
    const pendingRef = React.useRef(false)
    const initialScrollDone = React.useRef(false)
    const library = useAvatarLibrary(Boolean(session.avatar_id || session.banner))

    const poll = useCallback(async () => {
      if (pendingRef.current) return
      pendingRef.current = true
      try {
        const res = await kodeAccountFetch('/api/kode/devices', {
          action: 'history',
          device_id: device.device_id,
          session_id: session.id,
          from: 0,
          limit: 1000,
        })
        if (aliveRef.current) {
          setEvents(Array.isArray(res?.events) ? res.events : (Array.isArray(res) ? res : []))
          setError('')
        }
      } catch (err) {
        if (aliveRef.current) setError(err.message)
      } finally {
        pendingRef.current = false
      }
    }, [device.device_id, session.id])

    useEffect(() => {
      aliveRef.current = true
      initialScrollDone.current = false
      void poll()
      const timer = setInterval(() => { if (!document.hidden) void poll() }, 2000)
      return () => { aliveRef.current = false; clearInterval(timer) }
    }, [poll])

    const resolved = useMemo(() => new Set(events.filter(e => e.type === 'interaction.resolved').map(e => e.payload?.request_id)), [events])
    const rows = useMemo(() => {
      const merged = new Map()
      for (const event of events) {
        if (!['message', 'tool_use', 'ask_user_question', 'plan_proposed'].includes(event.type)) continue
        const p = event.payload ?? {}
        const key = `${event.type}:${p.id ?? p.tool_use_id ?? p.question_id ?? p.plan_id ?? event.ts}`
        const prior = merged.get(key)
        merged.set(key, { ...event, payload: { ...prior?.payload, ...p } })
      }
      return [...merged.values()]
    }, [events])

    useEffect(() => {
      const el = scroll.current
      if (!el || !rows.length) return
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      if (!initialScrollDone.current || nearBottom) {
        el.scrollTop = el.scrollHeight
        initialScrollDone.current = true
      }
    }, [rows.length])

    const operate = async (op, body) => {
      const res = await kodeAccountFetch('/api/kode/devices', {
        action: 'command',
        device_id: device.device_id,
        session_id: session.id,
        op,
        body,
      })
      void poll()
      return res
    }

    const send = async event => {
      event?.preventDefault()
      if (busy || !draft.trim()) return
      setBusy(true); setError('')
      try {
        await operate('input', { text: draft })
        sharedDrafts.delete(draftKey)
        setDraft('')
      } catch (err) {
        setError(err.message)
      } finally {
        setBusy(false)
      }
    }

    const interrupt = async () => {
      setError('')
      try { await operate('interrupt', {}) } catch (err) { setError(err.message) }
    }

    const title = session.bot_name || session.title || session.backend_key
    const headerBanner = remoteBannerInlineStyle(library, session)
    return h('section', { className: 'kode-shared-conversation kode-remote-conversation', 'aria-label': title },
      h('header', { style: headerBanner },
        h('div', { className: 'kode-remote-conv-title' },
          h(AgentAvatar, { profile: remoteSessionProfile(session), size: 28, status: session.status === 'busy' ? 'running' : 'idle' }),
          h('div', null,
            h('strong', null, title),
            h('p', { className: 'kode-config-note' }, `远端设备：${device.name || device.device_id}${session.model ? ` · ${session.model}` : ''}${session.cwd ? ` · ${session.cwd}` : ''}`),
          ),
        ),
        h('div', { className: 'kode-secondary-actions' },
          h(Button, { size: 'sm', variant: 'outline', onClick: () => showShared(null) }, '返回设备会话列表'),
          h(Button, { size: 'sm', variant: 'outline', onClick: () => selectAccountDevice(null) }, '切回此设备'),
        ),
      ),
      h('div', { className: 'kode-shared-messages', ref: scroll, 'aria-live': 'polite' },
        !rows.length && h('p', { className: 'kode-config-note' }, '等待远端会话消息…'),
        ...rows.map((event, index) => {
          const p = event.payload ?? {}
          return h('div', { className: 'kode-relay', key: `${event.type}:${p.id ?? p.tool_use_id ?? p.question_id ?? index}` },
            h('strong', null, event.type === 'message' ? (p.role === 'user' ? '你' : (session.bot_name || 'Agent')) : event.type === 'tool_use' ? (p.name ?? '工具') : '需要回应'),
            h(MarkdownText, { text: p.text ?? p.question ?? p.plan ?? p.output ?? '', labels: markdownLabels }),
            ['ask_user_question', 'plan_proposed'].includes(event.type) && h(SharedInteraction, {
              event,
              resolved: p.resolved === true || resolved.has(p.request_id ?? p.question_id ?? p.plan_id),
              operate: (kind, payload) => operate(kind, payload),
            }),
            event.type === 'tool_use' && p.input && h('details', null,
              h('summary', null, '查看输入'),
              h('pre', null, typeof p.input === 'string' ? p.input : JSON.stringify(p.input, null, 2)),
            ),
          )
        }),
      ),
      h('form', { className: 'kode-shared-composer', onSubmit: send },
        h(Failure, { text: error }),
        h('label', { className: 'kode-field' }, `发送到 ${device.name || device.device_id}`,
          h('textarea', {
            value: draft,
            rows: 3,
            disabled: busy,
            placeholder: '输入消息发送到远端设备会话…',
            onChange: event => {
              const text = event.target.value
              setDraft(text)
              sharedDrafts.set(draftKey, text)
            },
          }),
        ),
        h('div', null,
          h(Button, { type: 'button', onClick: () => void interrupt() }, '中断'),
          h(Button, { type: 'submit', variant: 'primary', disabled: busy || !draft.trim() }, busy ? '正在发送…' : '发送'),
        ),
      ),
    )
  }
