/** Persistent request identity; the database contains user messages, never credentials. */
export function createOutboxStorage(indexedDB = globalThis.indexedDB) {
  let opened, closed = false
  const open = () => {
    if (closed || !indexedDB) return Promise.reject(Error('消息发送存储不可用，请检查浏览器存储权限。'))
    return opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('kode.collab.outbox.v1', 1)
      let failed = false
      const fail = message => { failed = true; reject(Error(message)) }
      request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'key' })
      request.onerror = () => fail('无法打开消息发送存储。')
      request.onblocked = () => fail('消息发送存储正在被其他页面占用，请关闭旧页面后重试。')
      request.onsuccess = () => { const db = request.result; if (closed || failed) { db.close(); reject(Error('消息发送存储已关闭。')); return } db.onversionchange = () => db.close(); resolve(db) }
    }).catch(error => { opened = undefined; throw error })
  }
  const transaction = async (key, mode, change) => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', mode), store = tx.objectStore('messages'), get = store.get(key)
      let result
      get.onsuccess = () => {
        const current = get.result?.value ?? null
        try {
          result = change(current)
          if (mode === 'readwrite' && result !== current) store.put({ key, value: result })
        } catch { tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = tx.onabort = () => reject(Error('消息发送记录未能保存，请重试。'))
    })
  }
  return {
    read: key => transaction(key, 'readonly', current => current),
    update: (key, change) => transaction(key, 'readwrite', change),
    reserve: (key, value, canReplaceCompleted) => transaction(key, 'readwrite', current => current && current.state !== 'accepted' && !canReplaceCompleted?.(current) ? current : value),
    save: (key, value) => transaction(key, 'readwrite', current => { if (current?.request_id !== value.request_id) throw Error('Request changed'); return value }),
    close() { closed = true; opened?.then(db => db.close(), () => {}) },
  }
}
