export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export type LocaleMode = Locale | 'system'

export type MessageValue =
  | string
  | {
      message: string
      description?: string
      placeholders?: Record<string, string>
    }

export type Catalog = Record<string, MessageValue>
export type Catalogs = Record<Locale, Catalog>
export type Params = Record<string, string | number | boolean | null | undefined>

export function normalizeLocale(input: string | null | undefined): Locale {
  const raw = (input || '').trim()
  if (raw === 'zh-CN' || raw === 'zh-Hans' || raw === 'zh') return 'zh-CN'
  if (raw.toLowerCase().startsWith('zh-')) return 'zh-CN'
  return 'en'
}

export function normalizeLocaleMode(input: string | null | undefined): LocaleMode {
  if (input === 'system' || input === 'en' || input === 'zh-CN') return input
  return 'system'
}

export function resolveLocale(mode: LocaleMode, systemLocale: string | null | undefined): Locale {
  return mode === 'system' ? normalizeLocale(systemLocale) : mode
}

export function createI18n(catalogs: Catalogs, initialLocale: Locale = 'en') {
  let current = initialLocale
  const listeners = new Set<(locale: Locale) => void>()

  function setLocale(locale: Locale) {
    current = locale
    for (const listener of listeners) listener(current)
  }

  function getLocale() {
    return current
  }

  function subscribe(listener: (locale: Locale) => void) {
    listeners.add(listener)
    listener(current)
    return () => listeners.delete(listener)
  }

  function t(key: string, params?: Params): string {
    const entry = catalogs[current]?.[key] ?? catalogs.en[key]
    if (entry === undefined) return key
    const message = typeof entry === 'string' ? entry : entry.message
    return formatMessage(message, params)
  }

  return { getLocale, setLocale, subscribe, t }
}

export function formatMessage(message: string, params: Params = {}): string {
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}
