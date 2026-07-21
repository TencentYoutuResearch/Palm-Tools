import { writable, get } from 'svelte/store'
import {
  createI18n,
  normalizeLocale,
  normalizeLocaleMode,
  resolveLocale,
  type Locale,
  type LocaleMode,
  type Params,
} from '../../../../packages/kode-i18n/src/runtime'
import en from '../../../../packages/kode-i18n/locales/en.json'
import zhCN from '../../../../packages/kode-i18n/locales/zh-CN.json'

const runtime = createI18n({ en, 'zh-CN': zhCN }, normalizeLocale(navigator.language))

export const localeMode = writable<LocaleMode>('system')
export const currentLocale = writable<Locale>(runtime.getLocale())

runtime.subscribe((locale) => currentLocale.set(locale))

export function setLocaleMode(mode: LocaleMode) {
  localeMode.set(mode)
  runtime.setLocale(resolveLocale(mode, navigator.language))
  document.documentElement.lang = runtime.getLocale()
}

export function setLocaleModeFromString(value: string | null | undefined) {
  setLocaleMode(normalizeLocaleMode(value))
}

export function systemLanguageLabel(): string {
  return normalizeLocale(navigator.language) === 'zh-CN' ? '中文' : 'English'
}

export function effectiveLocale(): Locale {
  return runtime.getLocale()
}

export function localeModeValue(): LocaleMode {
  return get(localeMode)
}

export function t(key: string, params?: Params): string {
  return runtime.t(key, params)
}

export { normalizeLocaleMode }
export type { Params }
