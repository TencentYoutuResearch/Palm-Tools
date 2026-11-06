/** Extract routing metadata while leaving provider authentication fields opaque. */
function inlineBaseUrl(table) {
  const text = table.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('Invalid wrapper provider metadata')
  let depth = 1, quote = null, start = 1, value
  const field = end => {
    const equals = text.indexOf('=', start)
    if (equals < 0 || equals >= end) return
    const key = text.slice(start, equals).trim()
    if (['base_url', '"base_url"', "'base_url'"].includes(key)) value = text.slice(equals + 1, end).trim()
  }
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index]
    if (quote) {
      if (quote === '"' && char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
    else if (char === ',' && depth === 1) { field(index); start = index + 1 }
    if (depth < 1) throw new Error('Invalid wrapper provider metadata')
  }
  if (quote || depth !== 1) throw new Error('Invalid wrapper provider metadata')
  field(text.length - 1)
  return value
}

export function wrapperEndpoint(value) {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Wrapper provider must use its loopback transport')
  return endpoint
}

export function wrapperProviderEndpoint(args, provider) {
  const prefix = `model_providers.${provider}`
  let value
  for (const arg of args) {
    if (arg.startsWith(prefix + '=')) value = inlineBaseUrl(arg.slice(prefix.length + 1)) ?? value
    if (arg.startsWith(prefix + '.base_url=')) value = arg.slice((prefix + '.base_url=').length).trim()
  }
  if (!value || value.length > 4096) throw new Error('Wrapper provider route unavailable')
  let base
  if (/^'[^']*'$/.test(value)) base = value.slice(1, -1)
  else base = JSON.parse(value)
  const endpoint = wrapperEndpoint(base)
  endpoint.pathname = endpoint.pathname.replace(/\/?$/, '/') + 'responses'
  return endpoint.href
}
