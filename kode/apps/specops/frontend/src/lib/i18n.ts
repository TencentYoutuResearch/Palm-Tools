// Thin adapter over the shared window.__kodeI18n surface (kode i18n convention:
// shared message resources + a thin per-runtime adapter). We keep the exact
// same global interface the legacy console exposed so nothing else breaks.

import en from '../../../../../packages/kode-i18n/locales/en.json';
import zhCN from '../../../../../packages/kode-i18n/locales/zh-CN.json';
import { initialLocale } from './token.ts';

interface KodeI18n {
  t?: (key: string, params?: Record<string, unknown>) => string;
}

declare global {
  interface Window {
    __kodeI18n?: KodeI18n;
  }
}

type CatalogEntry = { message: string };
type Catalog = Record<string, CatalogEntry>;

const catalogs: Record<'en' | 'zh-CN', Catalog> = {
  en: en as Catalog,
  'zh-CN': zhCN as Catalog,
};

function resolveLocale(locale: string): 'en' | 'zh-CN' {
  const requested = locale === 'system' ? navigator.language : locale;
  return requested.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function format(message: string, params?: Record<string, unknown>): string {
  if (!params) return message;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

const activeLocale = resolveLocale(initialLocale);

window.__kodeI18n = {
  ...window.__kodeI18n,
  t(key: string, params?: Record<string, unknown>): string {
    const entry = catalogs[activeLocale][key] ?? catalogs.en[key];
    return entry ? format(entry.message, params) : key;
  },
};

document.documentElement.lang = activeLocale;

export function t(key: string, params?: Record<string, unknown>): string {
  return window.__kodeI18n?.t?.(key, params) ?? key;
}
