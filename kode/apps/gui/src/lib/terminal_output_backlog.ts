/**
 * Preserve the exact PTY byte stream while an xterm tab is hidden.  Small
 * updates wait until the tab is shown; sustained output is fed in bounded
 * batches so a long-running hidden session cannot retain unlimited bytes.
 */
export class TerminalOutputBacklog {
  private chunks: Uint8Array[] = []
  private byteLength = 0
  private readonly maxBytes: number

  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes
  }

  push(bytes: Uint8Array): Uint8Array | null {
    if (bytes.length === 0) return null
    // IPC owns the incoming buffer; keep an independent snapshot until flush.
    this.chunks.push(bytes.slice())
    this.byteLength += bytes.length
    return this.byteLength >= this.maxBytes ? this.take() : null
  }

  take(): Uint8Array | null {
    if (this.byteLength === 0) return null
    const joined = new Uint8Array(this.byteLength)
    let offset = 0
    for (const chunk of this.chunks) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.byteLength = 0
    return joined
  }

  clear(): void {
    this.chunks = []
    this.byteLength = 0
  }
}
