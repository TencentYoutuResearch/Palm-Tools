/** Protocol selection is explicit and independent of executable/profile names. */
import { CodexSession } from './codex-session.js'
export const SUPPORTED_AGENT_TYPES = ['dsh', 'codex', 'claude', 'codebuddy', 'cursor', 'custom']
const usesCodex = profile => profile.type === 'codex' || profile.protocol === 'codex'
export function nativeUsageCapability(profile) {
  return usesCodex(profile)
    ? { supported: true, source: 'codex_thread_token_usage', attribution: 'requested_model' }
    : { supported: false, reason: 'usage_collector_unsupported' }
}
export async function createNativeSession(profile, cwd, handlers = {}) {
  if (usesCodex(profile)) return new CodexSession(profile, cwd, handlers)
  const { AcpSession } = await import('./acp-session.js')
  return new AcpSession(profile, cwd, handlers)
}
