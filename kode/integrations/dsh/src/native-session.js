/** Protocol selection is explicit and independent of executable/profile names. */
import { CodexSession } from './codex-session.js'
export const SUPPORTED_AGENT_TYPES = ['dsh', 'codex', 'claude', 'codebuddy', 'cursor', 'custom']
export async function createNativeSession(profile, cwd, handlers = {}) {
  if (profile.type === 'codex' || profile.protocol === 'codex') return new CodexSession(profile, cwd, handlers)
  const { AcpSession } = await import('./acp-session.js')
  return new AcpSession(profile, cwd, handlers)
}
