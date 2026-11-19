export type MessageTextToken =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi
const TRAILING_PUNCTUATION = /[.,;:!?]$/

function trimUrlPunctuation(raw: string): string {
  let url = raw
  while (TRAILING_PUNCTUATION.test(url)) url = url.slice(0, -1)
  while (url.endsWith(')')) {
    const opens = [...url].filter((char) => char === '(').length
    const closes = [...url].filter((char) => char === ')').length
    if (closes <= opens) break
    url = url.slice(0, -1)
  }
  return url
}

export function tokenizeMessageText(text: string): MessageTextToken[] {
  const tokens: MessageTextToken[] = []
  let offset = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0
    const url = trimUrlPunctuation(match[0])
    if (index > offset) tokens.push({ type: 'text', value: text.slice(offset, index) })
    tokens.push({ type: 'url', value: url })
    offset = index + url.length
  }
  if (offset < text.length) tokens.push({ type: 'text', value: text.slice(offset) })
  return tokens
}
