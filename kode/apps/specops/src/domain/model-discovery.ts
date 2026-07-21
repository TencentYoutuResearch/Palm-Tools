import { execFile, spawn } from 'node:child_process'

export interface DiscoveredModel {
  id: string
  label: string
  description?: string
  is_default?: boolean
}

export type ModelDiscoverySource = 'codex-app-server' | 'codebuddy-control' | 'claude-cli-aliases'

export interface ModelDiscoveryResult {
  backend: string
  source: ModelDiscoverySource
  version?: string
  custom_allowed: boolean
  models: DiscoveredModel[]
  warning?: string
}

export type ModelDiscoverer = () => Promise<ModelDiscoveryResult>

export type CommandProbe = (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
export type CodeBuddyProbe = (command: string) => Promise<{ stdout: string; stderr: string; version?: string }>

const CLAUDE_ALIASES: DiscoveredModel[] = [
  { id: 'default', label: 'Default' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
]

export async function discoverCodeBuddyModels(
  command: string,
  probe: CodeBuddyProbe = runCodeBuddyControlProbe,
  backend = 'codebuddy',
): Promise<ModelDiscoveryResult> {
  const output = await probe(command)
  const lines = output.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  const models: DiscoveredModel[] = []
  for (const line of lines) {
    let frame: unknown
    try { frame = JSON.parse(line) } catch { continue }
    if (!isRecord(frame) || frame.type !== 'control_response' || !isRecord(frame.response)) continue
    const response = frame.response
    if (response.subtype !== 'success' || !isRecord(response.response) || !Array.isArray(response.response.availableModels)) continue
    for (const candidate of response.response.availableModels) {
      if (!isRecord(candidate) || typeof candidate.modelId !== 'string' || candidate.modelId === '') continue
      models.push({
        id: candidate.modelId,
        label: typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : candidate.modelId,
        ...(typeof candidate.description === 'string' && candidate.description !== '' ? { description: candidate.description } : {}),
      })
    }
  }
  if (models.length === 0) throw new Error(`CodeBuddy model discovery returned no models${output.stderr ? `: ${output.stderr.trim()}` : ''}`)
  return {
    backend,
    source: 'codebuddy-control',
    ...(output.version === undefined ? {} : { version: output.version }),
    custom_allowed: true,
    models: uniqueModels(models),
  }
}

export async function discoverClaudeModels(
  command: string,
  probe: CommandProbe = runCommand,
  configuredModel?: string,
  backend = command,
): Promise<ModelDiscoveryResult> {
  const [versionOutput, helpOutput] = await Promise.all([
    probe(command, ['--version']),
    probe(command, ['--help']),
  ])
  const version = firstVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`)
  const supportsModel = /(?:^|\s)--model(?:\s|[=,<[])/m.test(`${helpOutput.stdout}\n${helpOutput.stderr}`)
  if (!supportsModel) {
    return {
      backend,
      source: 'claude-cli-aliases',
      ...(version === undefined ? {} : { version }),
      custom_allowed: false,
      models: [],
      warning: `${command} does not advertise --model`,
    }
  }
  const models = [...CLAUDE_ALIASES]
  if (configuredModel && !models.some((model) => model.id === configuredModel)) {
    models.push({ id: configuredModel, label: configuredModel })
  }
  return {
    backend,
    source: 'claude-cli-aliases',
    ...(version === undefined ? {} : { version }),
    custom_allowed: true,
    models,
  }
}

interface CacheEntry {
  expiresAt: number
  value?: ModelDiscoveryResult
  pending?: Promise<ModelDiscoveryResult>
}

export class ModelDiscoveryService {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly discoverers: Readonly<Record<string, ModelDiscoverer>>,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  discover(backend: string, refresh = false): Promise<ModelDiscoveryResult> {
    const now = Date.now()
    const cached = this.cache.get(backend)
    if (!refresh && cached?.pending) return cached.pending
    if (!refresh && cached?.value && cached.expiresAt > now) return Promise.resolve(cached.value)
    const discoverer = this.discoverers[backend]
    if (!discoverer) return Promise.reject(new Error(`Model discovery is not supported for backend: ${backend}`))
    const pending = discoverer().then((value) => {
      this.cache.set(backend, { value, expiresAt: Date.now() + this.ttlMs })
      return value
    }).catch((error: unknown) => {
      this.cache.delete(backend)
      throw error
    })
    this.cache.set(backend, { pending, expiresAt: now + this.ttlMs })
    return pending
  }
}

function firstVersion(value: string): string | undefined {
  return value.match(/\d+\.\d+(?:\.\d+)?/)?.[0]
}

function runCommand(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

async function runCodeBuddyControlProbe(command: string): Promise<{ stdout: string; stderr: string; version?: string }> {
  const versionPromise = runCommand(command, ['--version']).then((result) => firstVersion(`${result.stdout}\n${result.stderr}`))
  const protocol = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already exited */ }
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (hasSuccessfulControlResponse(stdout)) finish()
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (!settled) finish(code === 0 ? undefined : new Error(`CodeBuddy model probe exited ${code}: ${stderr.trim()}`))
    })
    const timer = setTimeout(() => finish(new Error('CodeBuddy model discovery timed out')), 15_000)
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models-1', request: { subtype: 'get_available_models' } })}\n`)
  })
  const version = await versionPromise
  return { ...protocol, ...(version === undefined ? {} : { version }) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function uniqueModels(models: readonly DiscoveredModel[]): DiscoveredModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()]
}

function hasSuccessfulControlResponse(output: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    if (line.trim() === '') return false
    try {
      const frame = JSON.parse(line) as unknown
      return isRecord(frame) && frame.type === 'control_response' && isRecord(frame.response) && frame.response.subtype === 'success'
    } catch {
      return false
    }
  })
}
