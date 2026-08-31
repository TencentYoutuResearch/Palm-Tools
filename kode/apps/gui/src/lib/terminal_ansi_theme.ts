/**
 * Keep CLI foreground colours intact while making painted terminal surfaces
 * follow Kode's light/dark theme.
 *
 * xterm can recolour indexed cells when `theme.extendedAnsi` changes, but a
 * truecolor background is stored as a literal RGB value in the buffer.  This
 * adapter maps painted backgrounds to semantic indexed slots (16–23), with
 * red/green diff surfaces using distinct dark/light values.
 * Foreground groups are parsed and skipped as one unit so an
 * RGB component such as the `41` in `38;2;41;209;119` can never be mistaken
 * for an SGR background opcode.
 */

const ESC = 0x1b
const CSI_8BIT = 0x9b
const OSC_8BIT = 0x9d
const DCS_8BIT = 0x90
const SOS_8BIT = 0x98
const PM_8BIT = 0x9e
const APC_8BIT = 0x9f
const ST_8BIT = 0x9c
const BEL = 0x07
const MAX_CSI_BYTES = 256

const SURFACE_SLOT = {
  neutralSubtle: 16,
  neutralStrong: 17,
  red: 18,
  green: 19,
  yellow: 20,
  blue: 21,
  magenta: 22,
  cyan: 23,
} as const

const ANSI_BACKGROUND_SLOTS = [
  SURFACE_SLOT.neutralSubtle, // black
  SURFACE_SLOT.red,
  SURFACE_SLOT.green,
  SURFACE_SLOT.yellow,
  SURFACE_SLOT.blue,
  SURFACE_SLOT.magenta,
  SURFACE_SLOT.cyan,
  SURFACE_SLOT.neutralStrong, // white
  SURFACE_SLOT.neutralStrong, // bright black / gray
  SURFACE_SLOT.red,
  SURFACE_SLOT.green,
  SURFACE_SLOT.yellow,
  SURFACE_SLOT.blue,
  SURFACE_SLOT.magenta,
  SURFACE_SLOT.cyan,
  SURFACE_SLOT.neutralStrong, // bright white
] as const

const DARK_SURFACES = [
  '#1A1D1B', // 16 neutral subtle
  '#2B302D', // 17 neutral strong
  '#3A2024', // 18 red / removed diff
  '#173A27', // 19 green / added diff / input accent
  '#3B321A', // 20 yellow
  '#183449', // 21 blue
  '#332541', // 22 magenta
  '#173A37', // 23 cyan
]

const LIGHT_SURFACES = [
  '#ECEDE8', // 16 neutral subtle
  '#D9DDD6', // 17 neutral strong
  '#FF6B6B', // 18 red / removed diff
  '#71D47D', // 19 green / added diff / input accent
  '#F4EBCF', // 20 yellow
  '#DDECF4', // 21 blue
  '#EDE2F5', // 22 magenta
  '#DDF0ED', // 23 cyan
]

export function terminalSurfacePalette(dark: boolean): string[] {
  return [...(dark ? DARK_SURFACES : LIGHT_SURFACES)]
}

function parseByte(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= 0 && parsed <= 255 ? parsed : null
}

function standardBackgroundSlot(code: number): number | null {
  if (code >= 40 && code <= 47) return ANSI_BACKGROUND_SLOTS[code - 40]
  if (code >= 100 && code <= 107) return ANSI_BACKGROUND_SLOTS[code - 100 + 8]
  return null
}

function indexedBackgroundSlot(index: number): number | null {
  return index < ANSI_BACKGROUND_SLOTS.length ? ANSI_BACKGROUND_SLOTS[index] : null
}

function indexedColorRgb(index: number): [number, number, number] | null {
  if (index < 16 || index > 255) return null
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10
    return [gray, gray, gray]
  }
  const cube = index - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return [
    levels[Math.floor(cube / 36)],
    levels[Math.floor(cube / 6) % 6],
    levels[cube % 6],
  ]
}

function surfaceSlotForRgb(red: number, green: number, blue: number): number {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  // Achromatic extremes are normal input/panel surfaces; middle grays are
  // stronger selections.  Both remain semantic across theme changes.
  if (delta <= 0.045) {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return luminance > 0.25 && luminance < 0.78
      ? SURFACE_SLOT.neutralStrong
      : SURFACE_SLOT.neutralSubtle
  }

  let hue: number
  if (max === r) hue = 60 * (((g - b) / delta) % 6)
  else if (max === g) hue = 60 * ((b - r) / delta + 2)
  else hue = 60 * ((r - g) / delta + 4)
  if (hue < 0) hue += 360

  if (hue < 15 || hue >= 345) return SURFACE_SLOT.red
  if (hue < 75) return SURFACE_SLOT.yellow
  if (hue < 165) return SURFACE_SLOT.green
  if (hue < 205) return SURFACE_SLOT.cyan
  if (hue < 265) return SURFACE_SLOT.blue
  return SURFACE_SLOT.magenta
}

type ExtendedColor = {
  end: number
  rgb: [number, number, number] | null
}

function parseExtendedColor(fields: string[], start: number): ExtendedColor | null {
  const selector = fields[start + 1]
  if (selector === '5') {
    const index = parseByte(fields[start + 2] ?? '')
    if (index == null) return null
    return { end: start + 3, rgb: indexedColorRgb(index) }
  }
  if (selector === '2') {
    const hasEmptyColorSpace = fields[start + 2] === ''
    const rgbStart = start + (hasEmptyColorSpace ? 3 : 2)
    const red = parseByte(fields[rgbStart] ?? '')
    const green = parseByte(fields[rgbStart + 1] ?? '')
    const blue = parseByte(fields[rgbStart + 2] ?? '')
    if (red == null || green == null || blue == null) return null
    return { end: rgbStart + 3, rgb: [red, green, blue] }
  }
  return null
}

function rewriteColonBackground(field: string): string | null {
  const parts = field.split(':')
  if (parts[0] !== '48') return field
  if (parts[1] === '5' && parts.length === 3) {
    const index = parseByte(parts[2])
    if (index == null) return null
    const indexedSlot = indexedBackgroundSlot(index)
    if (indexedSlot != null) return `48;5;${indexedSlot}`
    const rgb = indexedColorRgb(index)
    return rgb == null ? field : `48;5;${surfaceSlotForRgb(...rgb)}`
  }
  if (parts[1] === '2') {
    const rgbStart = parts.length === 6 && (parts[2] === '' || parts[2] === '0') ? 3 : 2
    if (parts.length !== rgbStart + 3) return null
    const red = parseByte(parts[rgbStart])
    const green = parseByte(parts[rgbStart + 1])
    const blue = parseByte(parts[rgbStart + 2])
    if (red == null || green == null || blue == null) return null
    return `48;5;${surfaceSlotForRgb(red, green, blue)}`
  }
  return null
}

type SgrRewriteResult = {
  parameters: string
  reverseSurfaceActive: boolean
}

function rewriteSgrBackgroundsWithState(
  parameters: string,
  initialReverseSurfaceActive: boolean,
): SgrRewriteResult {
  // An empty parameter list is SGR 0 and also ends a synthesized surface.
  if (!parameters) return { parameters, reverseSurfaceActive: false }
  const fields = parameters.split(';')
  const rewritten: string[] = []
  let reverseSurfaceActive = initialReverseSurfaceActive

  for (let index = 0; index < fields.length;) {
    const field = fields[index]
    if (field.includes(':')) {
      // A colon-form foreground is deliberately opaque to this adapter.
      if (field.startsWith('48:')) {
        const next = rewriteColonBackground(field)
        if (next == null) {
          return { parameters, reverseSurfaceActive: initialReverseSurfaceActive }
        }
        rewritten.push(next)
        reverseSurfaceActive = false
      } else {
        rewritten.push(field)
      }
      index += 1
      continue
    }

    const code = /^\d+$/.test(field) ? Number(field) : null
    const standardSlot = code == null ? null : standardBackgroundSlot(code)
    if (standardSlot != null) {
      rewritten.push('48', '5', String(standardSlot))
      reverseSurfaceActive = false
      index += 1
      continue
    }
    // TUIs commonly paint their input row with reverse video.  Literal reverse
    // swaps xterm's default foreground into a white background in dark mode and
    // a black background in light mode.  Use the theme-owned neutral surface
    // instead; SGR 27 also clears that synthesized background.
    if (code === 7) {
      rewritten.push('27', '48', '5', String(SURFACE_SLOT.neutralStrong))
      reverseSurfaceActive = true
      index += 1
      continue
    }
    if (code === 27) {
      rewritten.push('27')
      if (reverseSurfaceActive) rewritten.push('49')
      reverseSurfaceActive = false
      index += 1
      continue
    }
    if (code === 0 || code === 49) {
      rewritten.push(field)
      reverseSurfaceActive = false
      index += 1
      continue
    }
    if (code !== 38 && code !== 48) {
      rewritten.push(field)
      index += 1
      continue
    }

    // Parse both foreground and background groups.  Foregrounds are copied as
    // one atom; backgrounds are mapped only when they use extended colours.
    const color = parseExtendedColor(fields, index)
    if (color == null) {
      return { parameters, reverseSurfaceActive: initialReverseSurfaceActive }
    }
    if (code === 48 && fields[index + 1] === '5') {
      const paletteIndex = parseByte(fields[index + 2] ?? '')
      const indexedSlot = paletteIndex == null
        ? null
        : indexedBackgroundSlot(paletteIndex)
      if (indexedSlot != null) {
        rewritten.push('48', '5', String(indexedSlot))
        reverseSurfaceActive = false
        index = color.end
        continue
      }
    }
    if (code === 38 || color.rgb == null) {
      rewritten.push(...fields.slice(index, color.end))
    } else {
      rewritten.push('48', '5', String(surfaceSlotForRgb(...color.rgb)))
      reverseSurfaceActive = false
    }
    index = color.end
  }

  return { parameters: rewritten.join(';'), reverseSurfaceActive }
}

export function rewriteSgrBackgrounds(parameters: string): string {
  return rewriteSgrBackgroundsWithState(parameters, false).parameters
}

function ascii(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return value
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index)
  return bytes
}

type Replacement = { start: number; end: number; bytes: Uint8Array }
type StringControl = 'osc' | 'st'

export class TerminalAnsiThemeAdapter {
  private pending = new Uint8Array(0)
  private stringControl: StringControl | null = null
  private stringEsc = false
  private reverseSurfaceActive = false

  reset(): void {
    this.pending = new Uint8Array(0)
    this.stringControl = null
    this.stringEsc = false
    this.reverseSurfaceActive = false
  }

  flush(): Uint8Array {
    const pending = this.pending
    this.pending = new Uint8Array(0)
    return pending
  }

  transform(chunk: Uint8Array): Uint8Array {
    let data = chunk
    if (this.pending.length > 0) {
      data = new Uint8Array(this.pending.length + chunk.length)
      data.set(this.pending)
      data.set(chunk, this.pending.length)
      this.pending = new Uint8Array(0)
    }

    const replacements: Replacement[] = []
    let outputEnd = data.length
    let index = 0

    while (index < data.length) {
      const byte = data[index]

      if (this.stringControl != null) {
        if (this.stringEsc) {
          if (byte === 0x5c) this.stringControl = null
          this.stringEsc = byte === ESC
        } else if (byte === ST_8BIT || (this.stringControl === 'osc' && byte === BEL)) {
          this.stringControl = null
        } else if (byte === ESC) {
          this.stringEsc = true
        }
        index += 1
        continue
      }

      if (byte === OSC_8BIT) {
        this.stringControl = 'osc'
        index += 1
        continue
      }
      if (byte === DCS_8BIT || byte === SOS_8BIT || byte === PM_8BIT || byte === APC_8BIT) {
        this.stringControl = 'st'
        index += 1
        continue
      }

      let csiStart = -1
      let paramsStart = -1
      if (byte === CSI_8BIT) {
        csiStart = index
        paramsStart = index + 1
      } else if (byte === ESC) {
        if (index + 1 >= data.length) {
          this.pending = data.slice(index)
          outputEnd = index
          break
        }
        const next = data[index + 1]
        if (next === 0x5d) {
          this.stringControl = 'osc'
          index += 2
          continue
        }
        if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
          this.stringControl = 'st'
          index += 2
          continue
        }
        if (next !== 0x5b) {
          index += 2
          continue
        }
        csiStart = index
        paramsStart = index + 2
      }

      if (csiStart < 0) {
        index += 1
        continue
      }

      let finalIndex = paramsStart
      let invalid = false
      for (; finalIndex < data.length; finalIndex++) {
        const candidate = data[finalIndex]
        if (candidate >= 0x40 && candidate <= 0x7e) break
        if (candidate < 0x20 || candidate > 0x3f) {
          invalid = true
          break
        }
        if (finalIndex - csiStart >= MAX_CSI_BYTES) {
          invalid = true
          break
        }
      }

      if (invalid) {
        index = finalIndex > csiStart ? finalIndex : csiStart + 1
        continue
      }
      if (finalIndex >= data.length) {
        this.pending = data.slice(csiStart)
        outputEnd = csiStart
        break
      }

      if (data[finalIndex] === 0x6d) {
        const original = ascii(data.subarray(paramsStart, finalIndex))
        const rewritten = rewriteSgrBackgroundsWithState(original, this.reverseSurfaceActive)
        const next = rewritten.parameters
        this.reverseSurfaceActive = rewritten.reverseSurfaceActive
        if (next !== original) {
          const prefix = data[csiStart] === ESC ? '\x1b[' : '\x9b'
          replacements.push({
            start: csiStart,
            end: finalIndex + 1,
            bytes: asciiBytes(`${prefix}${next}m`),
          })
        }
      }
      index = finalIndex + 1
    }

    if (replacements.length === 0) {
      if (outputEnd === data.length) return data
      return data.slice(0, outputEnd)
    }

    let size = outputEnd
    for (const replacement of replacements) size += replacement.bytes.length - (replacement.end - replacement.start)
    const output = new Uint8Array(size)
    let readOffset = 0
    let writeOffset = 0
    for (const replacement of replacements) {
      if (replacement.start >= outputEnd) break
      const unchanged = data.subarray(readOffset, replacement.start)
      output.set(unchanged, writeOffset)
      writeOffset += unchanged.length
      output.set(replacement.bytes, writeOffset)
      writeOffset += replacement.bytes.length
      readOffset = replacement.end
    }
    const tail = data.subarray(readOffset, outputEnd)
    output.set(tail, writeOffset)
    return output
  }
}
