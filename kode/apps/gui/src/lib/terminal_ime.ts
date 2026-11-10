/**
 * Hold terminal redraws while an IME composition popup is open. Moving the
 * xterm cursor or scroll area during composition makes some Windows IMEs chase
 * the new anchor and visibly jitter. Bytes are replayed in order on composition
 * end; the bounded backlog flushes only if a composition produces exceptional
 * output volume.
 */
export class TerminalImeOutputGate {
  private composing = false
  private chunks: Uint8Array[] = []
  private byteLength = 0
  private readonly maxBytes: number

  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes
  }

  get deferring(): boolean {
    return this.composing
  }

  begin(): void {
    this.composing = true
  }

  push(bytes: Uint8Array): Uint8Array | null {
    if (!this.composing) return bytes
    if (bytes.length === 0) return null
    this.chunks.push(bytes.slice())
    this.byteLength += bytes.length
    return this.byteLength >= this.maxBytes ? this.takeDeferred() : null
  }

  end(): Uint8Array | null {
    this.composing = false
    return this.takeDeferred()
  }

  clear(): void {
    this.composing = false
    this.chunks = []
    this.byteLength = 0
  }

  private takeDeferred(): Uint8Array | null {
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
}
