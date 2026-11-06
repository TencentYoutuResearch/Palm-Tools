/** Shared production routing for local and home-authorized remote telemetry. */
import { prepareRemoteQuotaCollector } from './remote-quota-collector.js'
import { prepareQuotaCollector } from './quota-collector.js'

export function runtimeQuotaCollector(config, profiles, remoteQuotaInvalidations) {
  return async (binding, session) => {
    const operation = binding.managedOperation
    if (operation?.home_node) {
      const fence = () => remoteQuotaInvalidations.fence(operation.home_node, binding.profile.id)
      const collector = await prepareRemoteQuotaCollector(config.backendClient, config.quotaHost, binding.profile.id, session, operation, fence(), fence)
      if (collector.bindingRevision) collector.recordAccountChange = () => remoteQuotaInvalidations.record(session, binding.profile.id, operation.home_node, operation, collector.bindingRevision)
      return collector
    }
    const fence = () => Math.max(0, ...Object.values(profiles.bindings).filter(row => row.profile.id === binding.profile.id).map(row => row.quotaFenceRevision ?? 0))
    return prepareQuotaCollector(config.backendClient, config.quotaHost, binding.profile.id, fence(), fence)
  }
}
