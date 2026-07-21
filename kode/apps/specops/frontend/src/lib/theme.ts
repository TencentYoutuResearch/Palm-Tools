import { writable } from 'svelte/store';
import { initialTheme } from './token';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'specops.theme';

function normalize(value: string | null | undefined): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function initial(): ThemeMode {
  if (initialTheme) return normalize(initialTheme);
  return normalize(localStorage.getItem(STORAGE_KEY));
}

function applyToDom(mode: ThemeMode): void {
  if (mode === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

export const theme = writable<ThemeMode>(initial());

theme.subscribe((mode) => {
  applyToDom(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore quota / private-mode errors */
  }
});

// The GUI can push theme updates via postMessage (parity with legacy app.js).
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'specops.theme') {
    theme.set(normalize(event.data.theme));
  }
});

export function cycleTheme(current: ThemeMode): ThemeMode {
  return current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
}
