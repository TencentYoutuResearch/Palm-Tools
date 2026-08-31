import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TerminalAnsiThemeAdapter,
  rewriteSgrBackgrounds,
  terminalSurfacePalette,
} from '../src/lib/terminal_ansi_theme.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function transform(input: string): string {
  return decoder.decode(new TerminalAnsiThemeAdapter().transform(encoder.encode(input)))
}

test('preserves CodeBuddy truecolor green foreground as one SGR atom', () => {
  const input = '\x1b[38;2;41;209;119mcodebuddy\x1b[0m'
  assert.equal(transform(input), input)
  assert.equal(rewriteSgrBackgrounds('38;2;41;209;119'), '38;2;41;209;119')
  assert.equal(rewriteSgrBackgrounds('38;2;48;209;119'), '38;2;48;209;119')
})

test('returns ordinary PTY chunks without copying them', () => {
  const adapter = new TerminalAnsiThemeAdapter()
  const chunk = encoder.encode('plain output without terminal control sequences')
  assert.equal(adapter.transform(chunk), chunk)
})

test('rewrites only the truecolor background in a combined SGR', () => {
  assert.equal(
    rewriteSgrBackgrounds('1;38;2;41;209;119;48;2;20;40;24;4'),
    '1;38;2;41;209;119;48;5;19;4',
  )
})

test('maps diff backgrounds to theme-specific surface slots', () => {
  assert.equal(transform('\x1b[48;2;84;28;35mremoved'), '\x1b[48;5;18mremoved')
  assert.equal(transform('\x1b[48;2;20;72;38madded'), '\x1b[48;5;19madded')
  assert.equal(transform('\x1b[48;5;196mremoved'), '\x1b[48;5;18mremoved')
  assert.equal(transform('\x1b[48;5;34madded'), '\x1b[48;5;19madded')
})

test('maps every standard and bright ANSI background to semantic surface slots', () => {
  assert.equal(
    transform('\x1b[40mblack\x1b[41mred\x1b[42mgreen\x1b[47mwhite\x1b[100mgray\x1b[107mbright white'),
    '\x1b[48;5;16mblack\x1b[48;5;18mred\x1b[48;5;19mgreen\x1b[48;5;17mwhite\x1b[48;5;17mgray\x1b[48;5;17mbright white',
  )
  assert.equal(
    rewriteSgrBackgrounds('1;38;2;41;209;119;101;4'),
    '1;38;2;41;209;119;48;5;18;4',
  )
})

test('maps every low indexed ANSI background to semantic surface slots', () => {
  assert.equal(transform('\x1b[48;5;0mblack'), '\x1b[48;5;16mblack')
  assert.equal(transform('\x1b[48;5;1mred'), '\x1b[48;5;18mred')
  assert.equal(transform('\x1b[48;5;2mgreen'), '\x1b[48;5;19mgreen')
  assert.equal(transform('\x1b[48;5;7mwhite'), '\x1b[48;5;17mwhite')
  assert.equal(transform('\x1b[48;5;8mgray'), '\x1b[48;5;17mgray')
  assert.equal(transform('\x1b[48;5;15mbright white'), '\x1b[48;5;17mbright white')
})

test('maps reverse-video input surfaces and their reset to theme-owned backgrounds', () => {
  assert.equal(
    transform('\x1b[7mreverse input\x1b[27mnormal'),
    '\x1b[27;48;5;17mreverse input\x1b[27;49mnormal',
  )
  assert.equal(
    rewriteSgrBackgrounds('1;38;2;41;209;119;7;4'),
    '1;38;2;41;209;119;27;48;5;17;4',
  )
  assert.equal(rewriteSgrBackgrounds('27'), '27')
})

test('only clears a background synthesized from reverse video', () => {
  const adapter = new TerminalAnsiThemeAdapter()
  const reverse = decoder.decode(adapter.transform(encoder.encode('\x1b[7mreverse')))
  const reverseReset = decoder.decode(adapter.transform(encoder.encode('\x1b[27mnormal')))
  assert.equal(reverse + reverseReset, '\x1b[27;48;5;17mreverse\x1b[27;49mnormal')

  const explicit = new TerminalAnsiThemeAdapter()
  assert.equal(
    decoder.decode(explicit.transform(encoder.encode('\x1b[48;5;1mred\x1b[27mstill red'))),
    '\x1b[48;5;18mred\x1b[27mstill red',
  )
})

test('supports colon-form colors without touching colon-form foregrounds', () => {
  assert.equal(transform('\x1b[38:2::41:209:119mgreen'), '\x1b[38:2::41:209:119mgreen')
  assert.equal(transform('\x1b[48:5:7mwhite'), '\x1b[48;5;17mwhite')
  assert.equal(transform('\x1b[48:2::20:40:24minput'), '\x1b[48;5;19minput')
  assert.equal(transform('\x1b[48:2:0:84:28:35mremoved'), '\x1b[48;5;18mremoved')
})

test('preserves malformed extended color groups instead of guessing', () => {
  const input = '\x1b[38;2;41;209mtruncated'
  assert.equal(transform(input), input)
  assert.equal(rewriteSgrBackgrounds('48;2;20;40'), '48;2;20;40')
})

test('keeps parser state across split CSI chunks', () => {
  const adapter = new TerminalAnsiThemeAdapter()
  const first = decoder.decode(adapter.transform(encoder.encode('\x1b[38;2;')))
  const second = decoder.decode(adapter.transform(encoder.encode('41;209;119mcodebuddy')))
  assert.equal(first + second, '\x1b[38;2;41;209;119mcodebuddy')

  const background = new TerminalAnsiThemeAdapter()
  const prefix = decoder.decode(background.transform(encoder.encode('\x1b[48;2;20;')))
  const suffix = decoder.decode(background.transform(encoder.encode('40;24minput')))
  assert.equal(prefix + suffix, '\x1b[48;5;19minput')
})

test('does not inspect CSI-looking bytes inside OSC payloads', () => {
  const input = '\x1b]0;title \x1b[48;2;20;40;24m\x07visible'
  assert.equal(transform(input), input)
})

test('dark and light palettes keep the same semantic slot ordering', () => {
  const dark = terminalSurfacePalette(true)
  const light = terminalSurfacePalette(false)
  assert.equal(dark.length, 8)
  assert.equal(light.length, 8)
  assert.notDeepEqual(dark, light)
  assert.equal(dark[0], '#1A1D1B')
  assert.equal(dark[1], '#2B302D')
  assert.equal(dark[2], '#3A2024')
  assert.equal(dark[3], '#173A27')
  assert.equal(light[0], '#ECEDE8')
  assert.equal(light[1], '#D9DDD6')
  assert.equal(light[2], '#FF6B6B')
  assert.equal(light[3], '#71D47D')
})
