import {id, scope, sourceKey} from './identity.js'
import {pageObservation} from './coverage.js'

/** Read-only resource facade. The existing plugin authority supplies approved connections;
 * this service owns only snapshots, never grants, credentials, owner input or tasks. */
export class ExternalResources {
  constructor({inbox, backendClient, connections = new Map()}) {
    this.inbox = inbox
    this.backend = backendClient
    this.connections = connections
    this.stop = new AbortController()
  }
  active() { this.stop.signal.throwIfAborted() }
  close() {
    if (this.stop.signal.aborted) return
    this.stop.abort(new Error('External resource service disposed'))
    this.inbox.close()
  }
  status() {
    this.active()
    return {state: this.connections.size ? 'ready' : 'disabled', reason: this.connections.size ? null : 'no_authorized_connections',
      authorized_connections: this.connections.size, provider_health: 'not_checked', dispatch: 'disabled', cache_capacity: this.inbox.capacity.status()}
  }
  connection(binding) {
    this.active()
    const provider = this.connections.get(binding.connection_id)
    if (!provider || sourceKey(provider.source) !== sourceKey(binding.source)
      || (binding.connection_revision != null && provider.authorizationRevision !== binding.connection_revision)) {
      throw Error('Connection missing or changed')
    }
    if (provider.allowedScopes && !provider.allowedScopes.some(s => JSON.stringify(scope(s)) === JSON.stringify(scope(binding.scope)))) throw Error('Connection scope not authorized')
    return provider
  }
  current(binding) {
    this.active()
    const latest = this.inbox.get(binding.id)
    if (latest.revision !== binding.revision) throw Error('Binding disabled or changed')
    return latest
  }
  async authorize(binding) {
    const provider = this.connection(binding)
    const result = await this.backend.call('/api/v1/messaging/collaboration/surfaces?' + new URLSearchParams(scope(binding.scope)), undefined, this.stop.signal)
    this.active()
    if (this.connection(binding) !== provider) throw Error('Read capability changed during authorization')
    const surface = result.items?.find(s => s.id === binding.surface_id)
    if (!surface || surface.kind !== 'channel' || surface.enabled !== true || surface.audience_revision !== binding.audience_revision
      || JSON.stringify(scope(surface.scope)) !== JSON.stringify(scope(binding.scope))) throw Error('Channel binding no longer authorized')
    return provider
  }
 async available(s,surfaceId){
  this.active(); s=scope(s)
  const result=await this.backend.call('/api/v1/messaging/collaboration/surfaces?'+new URLSearchParams(s), undefined, this.stop.signal)
  this.active()
  const surface=result.items?.find(x=>x.id===surfaceId&&x.kind==='channel'&&x.enabled&&JSON.stringify(scope(x.scope))===JSON.stringify(s))
  if(!surface)throw Error('Channel not authorized')
  return [...this.connections].filter(([,p])=>!p.allowedScopes||p.allowedScopes.some(x=>JSON.stringify(scope(x))===JSON.stringify(s))).map(([connection_id,p])=>({connection_id,source:p.source,capabilities:[...p.capabilities],compatibility:p.instanceValidated?'instance-validated':'unverified-instance'}))
 }
  async project(s, surfaceId) {
    this.active()
    const project = scope(s)
    id(surfaceId, 'surface_id')
    const canonical = JSON.stringify(project)
    const result = await this.backend.call('/api/v1/messaging/collaboration/surfaces?' + new URLSearchParams(project), undefined, this.stop.signal)
    this.active()
    const channels = new Map((result.items ?? []).filter(x => x.kind === 'channel' && x.enabled === true
      && JSON.stringify(scope(x.scope)) === canonical).map(x => [x.id, x]))
    const channel = channels.get(surfaceId)
    if (!channel) throw Error('Project channel not authorized')
    // Both the viewing channel and original binding anchors are checked against
    // the same Hub read. No asynchronous gap follows the authority checks.
    const bindings = this.inbox.list(project).flatMap(b => {
      if (channels.get(b.surface_id)?.audience_revision !== b.audience_revision) return []
      try {
        this.connection(b)
        const {last_sync, ...current} = this.current(b)
        return [current]
      } catch { return [] }
    })
    // Only offer explicitly project-scoped connections for new selections.
    const connections = [...this.connections]
      .filter(([, p]) => p.allowedScopes?.some(x => JSON.stringify(scope(x)) === canonical))
      .map(([connection_id, p]) => ({connection_id, source: p.source, capabilities: [...p.capabilities],
        compatibility: p.instanceValidated ? 'instance-validated' : 'unverified-instance'}))
    return {scope: project, surface_id: surfaceId, audience_revision: channel.audience_revision, bindings, connections}
  }
  async bind(input) {
    const provider = await this.authorize(input)
    const stamped = {...input, connection_revision: provider.authorizationRevision}
    let prior
    try { prior = this.inbox.get(input.id) } catch {}
    if (prior && prior.revision === input.expected_revision + 1
      && ['scope', 'surface_id', 'audience_revision', 'connection_id', 'connection_revision', 'source', 'enabled'].every(k => JSON.stringify(prior[k]) === JSON.stringify(stamped[k]))) return prior
    return this.inbox.bind(stamped)
  }
  async list(s) {
    this.active()
    const out = []
    for (const binding of this.inbox.list(s)) {
      try {
        await this.authorize(binding)
        // Read evidence belongs to the capability-checked cards response only.
        const {last_sync, ...current} = this.current(binding)
        out.push(current)
      } catch { this.active() /* Hide inaccessible metadata. */ }
    }
    return out
  }
  async cards(binding, options) {
    this.active()
    const b = this.inbox.get(binding)
    const provider = await this.authorize(b)
    const current = this.current(b)
    const items = this.inbox.cards(binding, options)
    // A removed capability cannot expose old snapshots even if a misconfigured
    // registry reuses its authorization revision.
    if (items.some(item => !provider.capabilities.has(item.kind))
      || (current.last_sync && !provider.capabilities.has(current.last_sync.kind))) throw Error('Read capability changed')
    return {items, source: b.source, binding_revision: b.revision, connection_revision: b.connection_revision,
      last_sync: current.last_sync ?? null,
      compatibility: provider.instanceValidated ? 'instance-validated' : 'unverified-instance', dispatch: 'disabled'}
  }
  async sync({binding_id, expected_revision, request_id, kind, page = 1, parent}) {
    this.active()
    id(request_id)
    const b = this.inbox.get(binding_id)
    const provider = await this.authorize(b)
    this.current(b)
    if (!b.enabled || b.revision !== expected_revision) throw Error('Binding disabled or changed')
    if (!provider.capabilities.has(kind)) throw Error('Read capability changed')
    const command = {binding_id, expected_revision, kind, page, parent: parent ?? null}
    const {token,receipt} = this.inbox.start(binding_id, expected_revision, request_id, command)
    if (receipt) return receipt
    try {
      const result = await provider.page(kind, {page, parent, signal: this.stop.signal})
      const observation = pageObservation(result, command, request_id, this.inbox.clock())
      // Check access again after I/O. No provider text ever enters a Hub intake.
      this.active()
      await this.authorize(b)
      if (this.connection(b) !== provider || !provider.capabilities.has(kind)) throw Error('Read capability changed during synchronization')
      return this.inbox.finish(binding_id, expected_revision, token, request_id, result.objects, command, observation)
    } finally {
      if (!this.stop.signal.aborted) this.inbox.release(binding_id, token)
    }
  }
}
