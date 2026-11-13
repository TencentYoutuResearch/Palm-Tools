const ESC = 0x1b
const CSI = 0x5b
const ENABLE_PRIVATE_MODE = 0x68
const MOUSE_TRACKING_MODES = new Set(['9', '1000', '1002', '1003', '1005', '1006', '1015'])

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * Prevent a Windows TCodex session from enabling xterm mouse reporting.
 * The carry buffer keeps split DECSET sequences intact across PTY chunks.
 */
export class TerminalMouseTrackingGate {
  private carry: number[] = []

  transform(bytes: Uint8Array): Uint8Array {
    const input = this.carry.length > 0
      ? [...this.carry, ...bytes]
      : Array.from(bytes)
    this.carry = []

    const output: number[] = []
    let index = 0
    while (index < input.length) {
      if (input[index] !== ESC) {
        output.push(input[index++])
        continue
      }
      if (index + 1 >= input.length) {
        this.carry.push(ESC)
        break
      }
      if (input[index + 1] !== CSI) {
        output.push(input[index], input[index + 1])
        index += 2
        continue
      }

      let end = index + 2
      while (end < input.length && !(input[end] >= 0x40 && input[end] <= 0x7e)) end++
      if (end >= input.length) {
        this.carry.push(...input.slice(index))
        break
      }
      if (input[end] !== ENABLE_PRIVATE_MODE) {
        output.push(...input.slice(index, end + 1))
        index = end + 1
        continue
      }

      const body = String.fromCharCode(...input.slice(index + 2, end))
      if (!body.startsWith('?')) {
        output.push(...input.slice(index, end + 1))
        index = end + 1
        continue
      }

      const remaining = body.slice(1).split(';').filter((mode) => !MOUSE_TRACKING_MODES.has(mode))
      if (remaining.length > 0) {
        output.push(...encoder.encode(`\x1b[?${remaining.join(';')}h`))
      }
      index = end + 1
    }

    return Uint8Array.from(output)
  }

  clear() {
    this.carry = []
  }
}
