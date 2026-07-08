// Token + theme are injected by the GUI via the URL hash fragment
// (see the legacy app.js:1-5 behaviour we are replacing). We read the token
// once, persist it in sessionStorage, then scrub the hash from the URL.

const fragment = new URLSearchParams(location.hash.slice(1));

const injected = fragment.get('token');
if (injected) {
  sessionStorage.setItem('specops-token', injected);
}

export const token = injected || sessionStorage.getItem('specops-token') || '';

/** Theme hint carried on the initial URL (system | light | dark). */
export const initialTheme = fragment.get('theme') || '';

const injectedLocale = fragment.get('locale');
if (injectedLocale) {
  sessionStorage.setItem('specops-locale', injectedLocale);
}

/** Locale hint carried on the initial URL (system | en | zh-CN). */
export const initialLocale = injectedLocale || sessionStorage.getItem('specops-locale') || 'system';

// Scrub the hash so the token does not linger in the address bar / history.
if (location.hash) {
  history.replaceState(null, '', location.pathname + location.search);
}
