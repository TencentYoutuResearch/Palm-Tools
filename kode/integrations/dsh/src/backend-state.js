/** Shared Kode backend documents. Browser storage and frontend lifetimes own no configuration. */
import { AgentProfiles, normalizeModelDefaults } from './agent-profiles.js'
import { isDeepStrictEqual } from 'node:util'
function startPlans(state){
  const plans=state?.coordinatorStartPlans
  if(plans!==undefined&&(!plans||typeof plans!=='object'||Array.isArray(plans)))throw Error('Invalid Kode Coordinator start plans')
  return plans??{}
}
export class BackendDocument {
  constructor(client, key) { this.client = client; this.key = key; this.revision = 0 }
  async read() { const row = await this.client.call(`/api/v1/messaging/workbench/documents/${this.key}`); this.revision = row.revision; return row.value }
  async write(value) { const row = await this.client.call(`/api/v1/messaging/workbench/documents/${this.key}`, { expected_revision: this.revision, value }); this.revision = row.revision; return row.value }
}
export class BackendAgentProfiles extends AgentProfiles {
  constructor(client, path) { super(path); this.document = new BackendDocument(client, 'agents'); this.usesSharedRegistry = true }
  adopt(state) {
    if (state?.version !== 1 || !Array.isArray(state.profiles) || !state.bindings || typeof state.bindings !== 'object') throw new Error('Invalid Kode Agent document')
    this.defaultProfileId = state.defaultProfileId ?? null
    this.modelDefaults = normalizeModelDefaults(state.modelDefaults)
    const plans=startPlans(state)
    this.sharedState = structuredClone({...state,coordinatorStartPlans:plans})
    this.coordinatorStartPlans=Object.assign(Object.create(null),structuredClone(plans))
    this.profiles = state.profiles; this.bindings = Object.assign(Object.create(null), state.bindings)
  }
  async open(initial = []) {
    let state = await this.document.read()
    const sharedPlans=startPlans(state)
    if (!state?.dsh_migrated) {
      // Import the former Host-owned file once. It remains available for rollback.
      await super.open(initial)
      for(const [key,plan] of Object.entries(this.coordinatorStartPlans)){
        if(Object.hasOwn(sharedPlans,key)&&!isDeepStrictEqual(sharedPlans[key],plan))throw Error('Conflicting migrated Coordinator start plan')
      }
      const migrated = this.list(), names = new Set(migrated.map(profile => `${profile.type}:${profile.name.toLocaleLowerCase()}`))
      const existing = state?.profiles ?? []
      state = await this.document.write({ ...state, version: 1,
        profiles: [...existing.filter(profile => !migrated.some(row => row.id === profile.id) && !names.has(`${profile.type}:${profile.name.toLocaleLowerCase()}`)), ...migrated],
        bindings: { ...structuredClone(this.bindings), ...state?.bindings }, modelDefaults: { ...this.modelDefaults, ...normalizeModelDefaults(state?.modelDefaults) }, coordinatorStartPlans:{...structuredClone(this.coordinatorStartPlans),...sharedPlans}, dsh_migrated: true })
    }
    this.adopt(state); return this
  }
  async reload() { const state = await this.document.read(); if (state) this.adopt(state) }
  update(operation) {
    const task = this.chain.then(async () => {
      await this.reload()
      const state = { ...structuredClone(this.sharedState), version: 1, modelDefaults: structuredClone(this.modelDefaults), profiles: this.list(), bindings: structuredClone(this.bindings) }
      const result = await operation(state)
      this.adopt(await this.document.write(state))
      return structuredClone(result)
    })
    this.chain = task.catch(() => {}); return task
  }
}
