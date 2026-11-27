/** Shared Kode backend documents. Browser storage and frontend lifetimes own no configuration. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentProfiles, normalizeModelDefaults } from './agent-profiles.js'

export function isDocumentUnsupportedError(error) {
  const message = String(error?.message ?? '')
  return error?.status === 404 || /unknown workbench document/i.test(message)
}

export function isDocumentConflictError(error) {
  const message = String(error?.message ?? '')
  return error?.status === 409 || /configuration changed|\(409\)/i.test(message)
}

export class BackendDocument {
  constructor(client, key, { fallbackFile = null, migrateFallback = false } = {}) {
    this.client = client
    this.key = key
    this.revision = 0
    this.fallbackFile = fallbackFile
    this.migrateFallback = Boolean(fallbackFile && migrateFallback)
    this.usingFallback = false
  }
  async readFallback() {
    if (!this.fallbackFile) return null
    try { return JSON.parse(await readFile(this.fallbackFile, 'utf8')) }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  }
  async writeFallback(value) {
    if (!this.fallbackFile) throw new Error(`Workbench document ${this.key} is unsupported by this Kode backend`)
    await mkdir(dirname(this.fallbackFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.fallbackFile}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temporary, this.fallbackFile)
    return value
  }
  async read() {
    if (!this.client?.call) return this.readFallback()
    try {
      const row = await this.client.call(`/api/v1/messaging/workbench/documents/${this.key}`)
      this.revision = row.revision ?? 0
      this.usingFallback = false
      if (row.value == null && this.revision === 0 && this.migrateFallback) {
        const local = await this.readFallback().catch(() => null)
        if (local != null) return local
      }
      return row.value
    } catch (error) {
      if (this.fallbackFile && isDocumentUnsupportedError(error)) {
        this.usingFallback = true
        return this.readFallback()
      }
      throw error
    }
  }
  async write(value) {
    if (!this.client?.call || this.usingFallback) return this.writeFallback(value)
    try {
      const row = await this.client.call(`/api/v1/messaging/workbench/documents/${this.key}`, { expected_revision: this.revision, value })
      this.revision = row.revision ?? (this.revision + 1)
      return row.value
    } catch (error) {
      if (this.fallbackFile && isDocumentUnsupportedError(error)) {
        this.usingFallback = true
        return this.writeFallback(value)
      }
      throw error
    }
  }
}
export class BackendAgentProfiles extends AgentProfiles {
  constructor(client, path) { super(path); this.document = new BackendDocument(client, 'agents'); this.usesSharedRegistry = true }
  adopt(state) {
    if (state?.version !== 1 || !Array.isArray(state.profiles) || !state.bindings || typeof state.bindings !== 'object') throw new Error('Invalid Kode Agent document')
    this.defaultProfileId = state.defaultProfileId ?? null
    this.modelDefaults = normalizeModelDefaults(state.modelDefaults)
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
        bindings: { ...structuredClone(this.bindings), ...state?.bindings }, modelDefaults: { ...this.modelDefaults, ...normalizeModelDefaults(state?.modelDefaults) }, dsh_migrated: true })
    }
    this.adopt(state); return this
  }
  async reload() { const state = await this.document.read(); if (state) this.adopt(state) }
  update(operation) {
    const task = this.chain.then(async () => {
      await this.reload()
      const state = { ...structuredClone(this.sharedState), version: 1, modelDefaults: structuredClone(this.modelDefaults), profiles: this.list(), bindings: structuredClone(this.bindings) }
      const result = operation(state)
      this.adopt(await this.document.write(state))
      return structuredClone(result)
    })
    this.chain = task.catch(() => {}); return task
  }
}
