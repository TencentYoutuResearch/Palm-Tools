/** Spill completed text to private disk, preserving every message without an aggregate RAM cap. */
import { mkdtemp, open, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
export class DecisionOutput {
  constructor(stateRoot, memoryBytes = 1024 * 1024) {
    this.root = stateRoot; this.limit = memoryBytes; this.bytes = 0; this.texts = []
    this.hash = createHash('sha256')
  }
  async append(text) {
    if (this.closing) throw new Error('Managed output is closed')
    try {
      const bytes = Buffer.byteLength(text)
      if (!this.file && this.bytes + bytes > this.limit) {
        const directory = await mkdtemp(join(this.root, 'codex-output-'))
        const path = join(directory, 'messages.jsonl')
        this.file = await open(path, 'wx', 0o600)
        this.artifact = { path, format: 'text-messages-jsonl', bytes: 0, messages: 0, complete: false, sha256: null }
        for (const prior of this.texts) await this.write(prior)
        this.texts = []
      }
      if (this.file) await this.write(text)
      else this.texts.push(text)
      this.bytes += bytes
    } catch (error) { this.failed = true; throw error }
  }
  async write(text) {
    const line = JSON.stringify(text) + '\n'
    const space = await statfs(this.root, { bigint: true })
    if (space.bavail * space.bsize < BigInt(Buffer.byteLength(line)) + 64n * 1024n * 1024n) {
      throw Object.assign(new Error('Insufficient free storage to preserve managed CLI output'), { code: 'managed_cli_output_storage_full' })
    }
    await this.file.writeFile(line)
    this.hash.update(line)
    this.artifact.bytes += Buffer.byteLength(text)
    this.artifact.messages++
  }
  close() {
    return this.closing ??= (async () => {
      if (!this.file) { this.closed = true; return }
      try {
        await this.file.sync()
        this.artifact.sha256 = this.hash.digest('hex')
      } catch (error) { this.failed = true; throw error }
      finally { try { await this.file.close() } catch (error) { this.failed = true; throw error } }
      this.closed = true
    })()
  }
  // Only the actor can call this after transport, usage and process-stop checks.
  seal() {
    if (!this.closed || this.failed) throw new Error('Managed output cannot be marked complete')
    if (this.artifact) this.artifact.complete = true
  }
}
export async function* decisionTexts(result) {
  if (!result.output_artifact) { yield* result.texts; return }
  const artifact = result.output_artifact
  if (artifact.complete !== true || artifact.format !== 'text-messages-jsonl' || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
    throw new Error('Managed output artifact is incomplete')
  }
  const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Invalid managed output artifact')
    const hash = createHash('sha256')
    for await (const bytes of file.createReadStream({ autoClose: false, start: 0 })) hash.update(bytes)
    if (hash.digest('hex') !== artifact.sha256) throw new Error('Managed output artifact integrity check failed')
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Managed output artifact changed during validation')
    const stream = file.createReadStream({ autoClose: false, start: 0, encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const text = JSON.parse(line)
        if (typeof text !== 'string') throw new Error('Invalid managed output artifact')
        yield text
      }
    } finally { lines.close(); stream.destroy() }
  } finally { await file.close() }
}
