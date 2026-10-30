/** Storage facet for Kode's canonical workspace document. No filesystem medium or fallback. */
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { BackendDocument } from './backend-state.js'
export const name = 'kode-workspace-backend'
export const inject = ['kodeBackend', 'storage']
const same = (left,right) => JSON.stringify(left) === JSON.stringify(right)
export function mergeWorkspaceEdit(before, after, current) {
  if (same(before,after)) return structuredClone(current)
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    const removed=new Set(before.filter(id=>!after.includes(id))), added=after.filter(id=>!before.includes(id))
    const reordered=!same(before.filter(id=>after.includes(id)),after.filter(id=>before.includes(id)))
    return reordered ? [...after.filter(id=>current.includes(id)||added.includes(id)),...current.filter(id=>!before.includes(id)&&!after.includes(id))]
      : [...current.filter(id=>!removed.has(id)),...added.filter(id=>!current.includes(id))]
  }
  if (after && typeof after==='object' && !Array.isArray(after)) {
    const result=structuredClone(current ?? {})
    for (const key of new Set([...Object.keys(before ?? {}),...Object.keys(after)])) {
      if (same(before?.[key],after[key])) continue
      if (!(key in after)) delete result[key]
      else result[key]=mergeWorkspaceEdit(before?.[key],after[key],current?.[key])
    }
    return result
  }
  return structuredClone(after)
}
export class KodeWorkspaceBackend {
  constructor(client) { this.client = client; this.units = new Set(); this.stopped = false }
  kv = { open: async descriptor => {
    if (this.stopped) throw new Error('Kode workspace storage is closed')
    if (descriptor.name !== 'workspace' || descriptor.version !== 2 || descriptor.tables.length !== 1 || descriptor.tables[0] !== 'workspaces') throw new Error('Kode workspace storage accepts only the workspace registry')
    if (this.units.size) throw new Error('Kode workspace catalog is already open')
    const document = new BackendDocument(this.client, 'workspaces')
    const state = await document.read()
    if (state?.version !== 2) throw new Error('Unsupported Kode workspace catalog; upgrade the backend')
    let snapshot = state, closed = false, chain=Promise.resolve()
    const check = () => { if (closed || this.stopped) throw new Error('Kode workspace storage is closed') }
    const write = mutate => {
      const task=chain.then(async()=>{
        check();const before=snapshot,next=structuredClone(before);mutate(next)
        for(let attempt=0;attempt<6;attempt++) {
          const latest=await document.read()
          if(latest?.version!==2)throw new Error('Unsupported Kode workspace catalog')
          for(const id of Object.keys(before.tables.workspaces)) {
            if(next.tables.workspaces[id] && !same(before.tables.workspaces[id],next.tables.workspaces[id]) && !latest.tables.workspaces[id])throw new Error('Workspace was deleted; refresh before editing it')
          }
          try {await document.write(mergeWorkspaceEdit(before,next,latest));snapshot=next;return}
          catch(error){if(attempt===5 || !/configuration changed/.test(error.message))throw error}
        }
      })
      chain=task.catch(()=>{});return task
    }
    const unit = {
      loadAll: async () => { check(); return structuredClone({ tables: snapshot.tables, global: snapshot.global }) },
      putRecord: async (table, key, value) => { if (table !== 'workspaces') throw new Error('Unknown workspace table'); await write(next => { next.tables.workspaces[key] = value }) },
      deleteRecord: async (table, key) => { if (table !== 'workspaces') throw new Error('Unknown workspace table'); await write(next => { delete next.tables.workspaces[key] }) },
      setGlobal: async value => write(next => { if (!value.initialized || value.defaultWorkspaceId) throw new Error('Automatic default workspaces are disabled'); next.global = value }),
      close: async () => { await chain; closed = true; this.units.delete(unit) },
    }
    this.units.add(unit); return unit
  } }
  async close() { this.stopped = true; await Promise.all([...this.units].map(unit => unit.close())) }
}
export function apply(ctx) {
  const backend = new KodeWorkspaceBackend(ctx.kodeBackend)
  ctx.effect(() => { const unregister = ctx.storage.backend.register('kode-workspaces', backend); return async () => { unregister(); await backend.close() } }, 'kode.workspace-storage')
  ctx.provide(storageBackendServiceKey('kode-workspaces'), backend)
}
