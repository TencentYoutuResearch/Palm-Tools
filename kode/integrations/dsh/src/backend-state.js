/** Shared Kode backend documents. Browser storage and frontend lifetimes own no configuration. */
import { AgentProfiles } from './agent-profiles.js'
export class BackendDocument {
  constructor(client, key) { this.client = client; this.key = key; this.revision = 0 }
  async read() { const row = await this.client.call(`/api/v1/messaging/workbench/documents/${this.key}`); this.revision = row.revision; return row.value }
  async write(value) { const row = await this.client.call(`/api/v1/messaging/workbench/documents/${this.key}`, { expected_revision: this.revision, value }); this.revision = row.revision; return row.value }
}
export class BackendAgentProfiles extends AgentProfiles {
  constructor(client, path) { super(path); this.document = new BackendDocument(client, 'agents'); this.usesSharedRegistry = true }
  adopt(state) {
    if (state?.version !== 1 || !Array.isArray(state.profiles) || !state.bindings || typeof state.bindings !== 'object') throw new Error('Invalid Kode Agent document')
    this.sharedState = structuredClone(state)
    this.profiles = state.profiles; this.bindings = Object.assign(Object.create(null), state.bindings)
  }
  async open(initial = []) {
    let state = await this.document.read()
    if (!state?.dsh_migrated) {
      // Import the former Host-owned file once. It remains available for rollback.
      await super.open(initial)
      const migrated = this.list(), names = new Set(migrated.map(profile => `${profile.type}:${profile.name.toLocaleLowerCase()}`))
      const existing = state?.profiles ?? []
      state = await this.document.write({ ...state, version: 1,
        profiles: [...existing.filter(profile => !migrated.some(row => row.id === profile.id) && !names.has(`${profile.type}:${profile.name.toLocaleLowerCase()}`)), ...migrated],
        bindings: { ...structuredClone(this.bindings), ...state?.bindings }, dsh_migrated: true })
    }
    this.adopt(state); return this
  }
  async reload() { const state = await this.document.read(); if (state) this.adopt(state) }
  update(operation) {
    const task = this.chain.then(async () => {
      await this.reload()
      const state = { ...structuredClone(this.sharedState), version: 1, profiles: this.list(), bindings: structuredClone(this.bindings) }
      const result = operation(state)
      this.adopt(await this.document.write(state))
      return structuredClone(result)
    })
    this.chain = task.catch(() => {}); return task
  }
}
