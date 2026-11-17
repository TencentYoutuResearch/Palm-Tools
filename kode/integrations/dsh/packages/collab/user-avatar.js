/** Local-only override. No account updates, media API, credentials or remote upload.
 * Signed in: per account. Signed out: one device slot, which never shows under an account. */
export function createUserAvatarStore({ storage, host = '', decode = decodeAvatar } = {}) {
  let state = { accountId: null, source: null, overridden: false }, revision = 0
  const listeners = new Set()
  const key = id => 'kode.collab.user-avatar.v1:' + JSON.stringify([host, id])
  const DEVICE = { device: true }, slot = () => state.accountId ?? DEVICE
  const slotKey = id => id === DEVICE ? 'kode.collab.user-avatar.v1:device:' + JSON.stringify(host) : key(id)
  const publish = value => { state = value; for (const notify of listeners) notify() }
  let accountUrl = null
  const restore = () => {
    let local
    try { local = storage?.getItem(slotKey(slot())) } catch {}
    const valid = typeof local === 'string' && local.length <= 400000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(local)
    publish({ ...state, source: valid ? local : accountUrl, overridden: !!valid })
  }
  restore()
  return {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot: () => state,
    reset() { revision++; accountUrl = null; publish({ accountId: null, source: null, overridden: false }); restore(); return revision },
    setProfile(profile, expected = revision) {
      if (expected !== revision) return
      const id = typeof profile?.id === 'string' && profile.id ? profile.id : null
      accountUrl = typeof profile?.avatarUrl === 'string' && /^https:\/\//i.test(profile.avatarUrl) ? profile.avatarUrl : null
      publish({ accountId: id, source: accountUrl, overridden: false })
      restore()
    },
    async upload(file) {
      const id = slot(), started = revision
      const url = await decode(file)
      if (started !== revision || id !== slot()) throw Error('账户已切换，请重新选择图片。')
      try { if (!storage) throw Error(); storage.setItem(slotKey(id), url) } catch { throw Error('无法保存本地头像，请检查浏览器存储权限或空间。') }
      publish({ ...state, source: url, overridden: true })
    },
    clear() {
      try { storage?.removeItem(slotKey(slot())) } catch { throw Error('无法清除本地头像，请检查浏览器存储权限。') }
      publish({ ...state, source: accountUrl, overridden: false })
    },
    onStorage(event) { if (event.key === null || event.key === slotKey(slot())) restore() },
  }
}
export async function decodeAvatar(file) {
  if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw Error('请选择 PNG、JPEG 或 WebP 图片。')
  if (!file.size || file.size > 2 * 1024 * 1024) throw Error('图片大小应在 2 MB 以内。')
  let bitmap
  try { bitmap = await createImageBitmap(file) } catch { throw Error('图片无法解码，请换一张有效图片。') }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 16000000) throw Error('图片尺寸过大，最长边请勿超过 4096 像素。')
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192
    const context = canvas.getContext('2d'), edge = Math.min(bitmap.width, bitmap.height)
    context.drawImage(bitmap, (bitmap.width-edge)/2, (bitmap.height-edge)/2, edge, edge, 0, 0, 192, 192)
    const value = canvas.toDataURL('image/png')
    if (value.length > 400000) throw Error('图片处理失败，请换一张图片。')
    return value
  } finally { bitmap.close() }
}
export function connectUserAvatar(ctx, store) {
  const remote = ctx.remote
  let stream
  let disposed = false
  const refresh = async signedIn => {
    const revision = store.reset()
    if (!signedIn || disposed) return
    try {
      const result = await remote.account.getProfile({ version: '0.2.1-rc.5', locale: ctx.locale?.getSnapshot?.().active || 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset()*60 })
      if (!disposed && result.ok && result.value?.status === 'ready') store.setProfile(result.value.value, revision)
    } catch { /* Fail closed; never display another account's cached avatar. */ }
  }
  if (remote?.account && remote?.$stream) {
    stream = remote.$stream({name:'account',open:signal=>remote.account.watch(signal),ended:()=>Error('account stream ended')})
    void (async () => {
      try {
        for await (const frame of stream) {
          if (disposed) break
          void refresh(frame.value.status === 'credential-stored'); frame.accept()
        }
      } catch { if (!disposed) store.reset() }
    })()
  } else if (remote?.account) {
    void remote.account.getState().then(result => refresh(result.ok && result.value?.status === 'credential-stored')).catch(()=>store.reset())
  }
  const changed = event => store.onStorage(event)
  window.addEventListener('storage', changed)
  return () => { disposed = true; void stream?.dispose(); store.reset(); window.removeEventListener('storage', changed) }
}
