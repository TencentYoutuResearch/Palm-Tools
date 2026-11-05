/** Thin adapter to Kode's authoritative backend; no filesystem or installer ownership. */
import { withNativePlugins } from './native-extensions.js'
export const HUB_PATH = '/api/v1/messaging/workbench/agent-hub'
export class ExtensionHub {
  constructor(backend) { this.backend = backend }
  read() { return this.backend.call(HUB_PATH) }
  change(input) { return this.backend.call(HUB_PATH, input) }
  logo(source, index) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source ?? '') || !/^\d+$/.test(index ?? '')) throw new Error('Invalid plugin logo request')
    return this.backend.asset(`${HUB_PATH}?logo=${encodeURIComponent(source)}&package=${index}`)
  }
  async nativeProfile(profile) { return withNativePlugins(profile, (await this.read()).sources) }
}
