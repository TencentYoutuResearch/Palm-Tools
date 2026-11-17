/** One cache and owner route per webServer/connection lifetime.
 * No discovery: production stays disabled until an existing plugin authority
 * supplies versioned, explicitly approved read transports to this adapter. */
import {ExternalInbox} from './inbox.js'
import {ExternalResources} from './service.js'
import {privateCachePath} from './cache-storage.js'
import {registerExternalResources} from './route.js'
import {id} from './identity.js'

export function mountExternalResources(ctx, {backendClient, homeId, stateFile, connections} = {}) {
  const registry = connections ?? new Map()
  if (!(registry instanceof Map)) throw Error('Expected trusted provider registry')
  let service
  let reason = connections == null ? 'authorized_connection_registry_unavailable' : 'no_authorized_connections'
  let disposed = false
  let initializationFailed = false
  const resolveService = () => {
    if (disposed || service || initializationFailed || !registry.size) return service

    try {
      // Cache partitioning and metadata both bind the exact existing Host/Hub.
      const identity = {home_hub: id(homeId), backend_url: backendClient.url}
      if (typeof identity.backend_url !== 'string' || !identity.backend_url) throw Error('Host backend identity required')
      const inbox = new ExternalInbox(privateCachePath(stateFile, identity), {cacheIdentity: identity})
      service = new ExternalResources({inbox, backendClient, connections: registry})
    } catch {
      // Failure must not bring down ordinary conversations or create false
      // connected status. Never expose filesystem paths or provider errors.
      initializationFailed = true
      reason = 'cache_unavailable'
    }
    return service
  }
  const status = () => service ? service.status() : {state: 'disabled', reason, authorized_connections: 0, provider_health: 'not_checked', dispatch: 'disabled'}
  let unregister
  try { unregister = registerExternalResources(ctx, {service, status, resolveService}) }
  catch (error) { service?.close(); throw error }
  return () => {
    if (disposed) return
    disposed = true
    try { unregister?.() } finally { service?.close() }
  }
}
