/** Owner-configured workflow routing stays separate from ordinary native Session routing. */
import { isAbsolute } from 'node:path'

export function normalizeManagedBootstrap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['executable', 'pathVariable', 'provider', 'home'].includes(key))
      || typeof value.executable !== 'string' || !isAbsolute(value.executable) || /[\0\r\n]/.test(value.executable)
      || typeof value.pathVariable !== 'string' || !/^[A-Z][A-Z0-9_]*_PATH$/.test(value.pathVariable)) {
    throw new Error('Invalid managed CLI bootstrap configuration')
  }
  if (value.provider != null && (typeof value.provider !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.provider))) throw new Error('Invalid managed wrapper provider')
  if (value.home != null && (!value.provider || typeof value.home !== 'string' || !isAbsolute(value.home) || /[\0\r\n]/.test(value.home))) throw new Error('Invalid managed wrapper home')
  return { executable: value.executable, pathVariable: value.pathVariable,
    ...(value.provider == null ? {} : { provider: value.provider }), ...(value.home == null ? {} : { home: value.home }) }
}
export const managedCodexRoute = id => `kode-workflow-${id}`
export const managedCodexEnabled = profile => Boolean(profile?.managedInference)
  && (profile.type === 'codex' || profile.protocol === 'codex')
export function controlledBinding(binding) {
  if (binding?.profile.type === 'dsh') return true
  if (!managedCodexEnabled(binding?.profile)) return false
  const roles = [
    binding.managedAssignment && 'worker',
    binding.managedBuilder && 'builder',
    binding.managedCoordinator && 'coordinator',
  ].filter(Boolean)
  return roles.length === 1 && (binding.profile.managedInference.roles ?? ['worker']).includes(roles[0])
}

export function normalizeManagedInference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['endpoint', 'apiKeyVariable', 'reasoningEfforts', 'timeoutMs', 'bootstrap', 'roles'].includes(key))) {
    throw new Error('Invalid managed CLI inference configuration')
  }
  const bootstrap = value.bootstrap == null ? null : normalizeManagedBootstrap(value.bootstrap)
  if (value.roles != null && (!Array.isArray(value.roles) || !value.roles.length || value.roles.length > 3
      || value.roles.some(role => !['worker', 'builder', 'coordinator'].includes(role))
      || new Set(value.roles).size !== value.roles.length)) throw new Error('Invalid managed CLI roles')
  let endpoint
  if (value.endpoint != null) {
    try { endpoint = new URL(value.endpoint) } catch { throw new Error('Invalid managed CLI inference endpoint') }
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)))
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Managed CLI endpoint requires HTTPS or loopback without embedded authentication')
  } else if (!bootstrap?.provider) throw new Error('Managed CLI inference endpoint required')
  if (bootstrap?.provider && (endpoint || value.apiKeyVariable != null)) throw new Error('Managed wrapper transport requires its own provider authentication')
  if (value.apiKeyVariable != null && (typeof value.apiKeyVariable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyVariable))) throw new Error('Invalid managed CLI authentication variable name')
  if (value.apiKeyVariable && value.bootstrap?.pathVariable === value.apiKeyVariable) throw new Error('Managed CLI engine hook conflicts with authentication variable')
  const efforts = value.reasoningEfforts ?? []
  if (!Array.isArray(efforts) || efforts.length > 32 || efforts.some(effort => typeof effort !== 'string' || !effort || effort.length > 64)
      || new Set(efforts).size !== efforts.length) throw new Error('Invalid managed CLI reasoning efforts')
  if (value.timeoutMs != null && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 1800000)) throw new Error('Invalid managed CLI inference timeout')
  return { ...(endpoint ? { endpoint: endpoint.href } : {}), ...(value.apiKeyVariable == null ? {} : { apiKeyVariable: value.apiKeyVariable }),
    ...(value.roles == null ? {} : { roles: [...value.roles] }),
    ...(bootstrap ? { bootstrap } : {}),
    reasoningEfforts: [...efforts], ...(value.timeoutMs == null ? {} : { timeoutMs: value.timeoutMs }) }
}
