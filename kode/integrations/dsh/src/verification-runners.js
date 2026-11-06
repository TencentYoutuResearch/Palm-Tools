import { loadVerificationDefinitions, persistVerificationDefinition } from './verification-definitions.js'
/** Trusted command definitions and durable at-most-once launch ledger. Not an execution grant. */
import { createHash } from 'node:crypto'
import { isAbsolute, join, dirname } from 'node:path'
import { mkdir, open, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { writePrivateJson } from './agent-profiles.js'
import { runVerificationProcess } from './verification-process.js'
import { resourceNames } from './exclusive-resources.js'
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',')
export async function verificationExecutableHash(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Verification executable is not a file')
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    for (;;) { const { bytesRead } = await file.read(buffer,0,buffer.length,null); if (!bytesRead) break; hash.update(buffer.subarray(0,bytesRead)) }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Verification executable changed while hashing')
    return hash.digest('hex')
  } finally { await file.close() }
}
export class VerificationRunners {
  constructor(root) {
    if (!isAbsolute(root)) throw new Error('Absolute trusted verification storage required')
    this.root = root; this.definitions = new Map(); this.pending = new Map(); this.unconfirmed = new Map(); this.stop = new AbortController()
  }
  normalizeDefinition(input) {
    const checked = new VerificationRunners(this.root)
    checked.register(input)
    return [...checked.definitions.values()][0]
  }
  open() {
    this.loading ??= loadVerificationDefinitions(this.root, input => this.normalizeDefinition(input)).then(rows => {
      for (const row of rows) this.register(row.definition)
      return this
    })
    return this.loading
  }
  async registerPersistent(input) {
    await this.open()
    if (this.stop.signal.aborted) throw new Error('Verification runner closed')
    const row = this.normalizeDefinition(input)
    const key = JSON.stringify([input.runner_id,input.command_id,input.revision])
    const prior = this.definitions.get(key)
    if (prior && !isDeepStrictEqual(prior,row)) throw new Error('Verification definition revision is immutable')
    await persistVerificationDefinition(this.root,row,value => this.normalizeDefinition(value))
    if (this.stop.signal.aborted) throw new Error('Verification runner closed; registration may be persisted')
    return this.register(row.definition)
  }
  register(input) {
    if (!exact(input, ['runner_id', 'command_id', 'revision', 'executable', 'executable_hash', 'args', 'env', 'timeout_ms', 'max_output_bytes', 'scenario_ids', 'capabilities', 'network', 'tool_id',...(Object.hasOwn(input??{},'exclusive_resources')?['exclusive_resources']:[])])
        || !Array.isArray(input.capabilities) || input.capabilities.some(c => !['read','workspace_write'].includes(c)) || typeof input.network !== 'boolean'
        || !id(input.tool_id) || !hash(input.executable_hash) || ![input.runner_id, input.command_id, input.revision].every(id) || !isAbsolute(input.executable) || input.executable.includes('\0')
        || !Array.isArray(input.args) || input.args.length > 128 || input.args.some(v => typeof v !== 'string' || v.length > 16384 || v.includes('\0'))
        || !input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.keys(input.env).length > 64
        || Object.entries(input.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > 16384 || v.includes('\0'))
        || !Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 3600000
        || !Number.isSafeInteger(input.max_output_bytes) || input.max_output_bytes < 1 || input.max_output_bytes > 1048576
        || !Array.isArray(input.scenario_ids) || !input.scenario_ids.length || input.scenario_ids.length > 128 || !input.scenario_ids.every(id)
        || new Set(input.scenario_ids).size !== input.scenario_ids.length) throw new Error('Invalid trusted verification definition')
    const exclusive=resourceNames(Object.hasOwn(input,'exclusive_resources')?input.exclusive_resources:[])
    const definition = { ...(exclusive.length?{exclusive_resources:exclusive}:{}),runner_id: input.runner_id, command_id: input.command_id, revision: input.revision, tool_id: input.tool_id,
      executable: input.executable, executable_hash: input.executable_hash, args: [...input.args], env: Object.fromEntries(Object.entries(input.env).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)),
      timeout_ms: input.timeout_ms, max_output_bytes: input.max_output_bytes, scenario_ids: [...input.scenario_ids].sort(), capabilities: [...new Set(input.capabilities)].sort(), network: input.network }
    const reference = { ...(exclusive.length?{exclusive_resources:exclusive}:{}),runner_id: definition.runner_id, id: definition.command_id, revision: definition.revision,
      definition_hash: digest(definition), tool_id: definition.tool_id, scenario_ids: definition.scenario_ids, capabilities: definition.capabilities, network: definition.network,
      environment_hash: digest({ adapter: 'local_process_v1', platform: process.platform, arch: process.arch, env: definition.env }) }
    const key = JSON.stringify([input.runner_id,input.command_id,input.revision]), prior = this.definitions.get(key)
    if (prior && !isDeepStrictEqual(prior.definition, definition)) throw new Error('Verification definition revision is immutable')
    this.definitions.set(key, { definition, reference })
    return structuredClone(reference)
  }
  reference(runner, command, revision) {
    const row = this.definitions.get(JSON.stringify([runner,command,revision]))
    if (!row) throw new Error('Trusted verification command is not registered')
    return structuredClone(row.reference)
  }
  execute(request, { signal, authorize } = {}) {
    if (!exact(request, ['request_id', 'command', 'cwd', 'operation', 'source_sequence', 'snapshot_hash']) || !id(request.request_id)
        || !(exact(request.operation, ['id','attempt','epoch']) || (exact(request.operation, ['id','attempt','epoch','home_node']) && typeof request.operation.home_node === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(request.operation.home_node))) || !id(request.operation.id)
        || ![request.operation.attempt, request.operation.epoch, request.source_sequence].every(n => Number.isSafeInteger(n) && n > 0)
        || !hash(request.snapshot_hash) || !isAbsolute(request.cwd) || typeof authorize !== 'function') return Promise.reject(new Error('Invalid verification execution request'))
    const fixed = structuredClone(request), key = digest(['kode.verification.execution.v1', ...(fixed.operation.home_node ? [fixed.operation.home_node] : []), fixed.operation.id, fixed.request_id])
    const pending = this.pending.get(key)
    if (pending) return isDeepStrictEqual(pending.request, fixed) ? pending.task : Promise.reject(new Error('Verification execution identity conflict'))
    if (this.stop.signal.aborted) return Promise.reject(new Error('Verification runner closed'))
    const combined = signal ? AbortSignal.any([signal,this.stop.signal]) : this.stop.signal
    const task = this.run(key, fixed, combined, authorize)
    this.pending.set(key,{ request: fixed, task }); task.finally(() => this.pending.delete(key)).catch(() => {})
    return task
  }
  assertStopped(operation) {
    const same = other => other.id === operation.id && (other.home_node ?? null) === (operation.home_node ?? null)
    if ([...this.unconfirmed.values()].some(same) || [...this.pending.values()].some(row => same(row.request.operation))) throw new Error('Verification process stop unconfirmed')
  }
  async run(key, request, signal, authorize) {
    const registered = this.definitions.get(JSON.stringify([request.command?.runner_id,request.command?.id,request.command?.revision]))
    if (!registered || !isDeepStrictEqual(registered.reference, request.command)) throw new Error('Verification command binding mismatch')
    signal.throwIfAborted()
    if (await realpath(request.cwd) !== request.cwd) throw new Error('Verification workspace must be canonical')
    await realpath(dirname(this.root))
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const parent = await open(dirname(this.root), 'r'); try { await parent.sync() } finally { await parent.close() }
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Verification storage is not a directory')
    const directory = join(await realpath(this.root),key), stateFile = join(directory,'state.json')
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!(await lstat(directory)).isDirectory()) throw new Error('Verification execution identity changed')
      const file = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      let saved
      try { if ((await file.stat()).size > 4*1048576) throw new Error('Verification receipt bounds'); saved = JSON.parse(await file.readFile('utf8')) } finally { await file.close() }
      if (!isDeepStrictEqual(saved.request,request)) throw new Error('Verification execution identity conflict')
      this.unconfirmed.set(key, structuredClone(request.operation))
      if (saved.version !== 1 || !exact(saved, ['version','request','state','result','result_hash'])) throw new Error('Verification execution requires recovery; invalid receipt')
      if (saved.state !== 'finished') throw new Error('Verification execution requires recovery; command will not be rerun')
      if (saved.result?.completion_authorized !== false || saved.result.request_id !== request.request_id
          || !isDeepStrictEqual(saved.result.operation, request.operation) || !isDeepStrictEqual(saved.result.command, request.command)
          || saved.result.source_sequence !== request.source_sequence || saved.result.snapshot_hash !== request.snapshot_hash
          || saved.result.log_hash !== digest(saved.result.observed?.output) || saved.result_hash !== digest(saved.result)) throw new Error('Verification receipt integrity mismatch')
      if (saved.result.observed?.process_group_empty === true) this.unconfirmed.delete(key)
      return saved.result
    }
    const intent = { version: 1, request, state: 'launching' }
    await writePrivateJson(stateFile,intent)
    const storage = await open(this.root, 'r'); try { await storage.sync() } finally { await storage.close() }
    signal.throwIfAborted()
    if (await authorize(structuredClone(request)) !== true) throw new Error('Verification execution not authorized')
    signal.throwIfAborted()
    if (await realpath(registered.definition.executable) !== registered.definition.executable
        || await verificationExecutableHash(registered.definition.executable) !== registered.definition.executable_hash) throw new Error('Verification executable identity mismatch')
    signal.throwIfAborted()
    this.unconfirmed.set(key, structuredClone(request.operation))
    const observed = await runVerificationProcess(registered.definition, request.cwd, signal)
    if (observed.process_group_empty === true) this.unconfirmed.delete(key)
    const result = { request_id: request.request_id, operation: request.operation, command: request.command,
      source_sequence: request.source_sequence, snapshot_hash: request.snapshot_hash, observed,
      log_hash: digest(observed.output), log_ref: `verification-${key}`, completion_authorized: false }
    await writePrivateJson(stateFile,{ ...intent, state: 'finished', result, result_hash: digest(result) })
    return result
  }
  async close() { this.stop.abort(new Error('Verification runner closed')); await Promise.allSettled([...this.pending.values()].map(p => p.task)) }
}
