import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const locales = ['en', 'zh-CN']

function placeholders(message) {
  return [...message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort()
}

function text(entry) {
  return typeof entry === 'string' ? entry : entry?.message
}

const catalogs = Object.fromEntries(
  await Promise.all(
    locales.map(async (locale) => [
      locale,
      JSON.parse(await readFile(path.join(root, 'locales', `${locale}.json`), 'utf8')),
    ]),
  ),
)

const base = catalogs.en
let failed = false
for (const locale of locales.slice(1)) {
  const catalog = catalogs[locale]
  for (const key of Object.keys(base)) {
    if (!(key in catalog)) {
      console.error(`[i18n] ${locale} missing key: ${key}`)
      failed = true
      continue
    }
    const baseMessage = text(base[key])
    const message = text(catalog[key])
    if (!message) {
      console.error(`[i18n] ${locale} empty message: ${key}`)
      failed = true
      continue
    }
    const a = placeholders(baseMessage).join(',')
    const b = placeholders(message).join(',')
    if (a !== b) {
      console.error(`[i18n] ${locale} placeholder mismatch ${key}: expected {${a}}, got {${b}}`)
      failed = true
    }
  }
  for (const key of Object.keys(catalog)) {
    if (!(key in base)) {
      console.error(`[i18n] ${locale} extra key: ${key}`)
      failed = true
    }
  }
}

if (failed) process.exit(1)
console.log('[i18n] catalogs ok')
