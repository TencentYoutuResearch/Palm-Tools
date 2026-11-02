/** Thin adapter to Kode's authoritative backend; no filesystem or installer ownership. */
import { withNativePlugins } from './native-extensions.js'
export const HUB_PATH = '/api/v1/messaging/workbench/agent-hub'
export class ExtensionHub {
  constructor(backend) { this.backend = backend }
  read() { return this.backend.call(HUB_PATH) }
  change(input) { return this.backend.call(HUB_PATH, input) }
  async nativeProfile(profile) { return withNativePlugins(profile, (await this.read()).sources) }
}
