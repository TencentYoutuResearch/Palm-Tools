import { writable, type Writable } from 'svelte/store';

export type ModuleId = 'iwiki' | 'chat';

function persisted<T>(key: string, initial: T, parse: (raw: string) => T): Writable<T> {
  let start = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) start = parse(raw);
  } catch {
    /* ignore */
  }
  const store = writable<T>(start);
  store.subscribe((value) => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* ignore */
    }
  });
  return store;
}

export const activeModule = persisted<ModuleId>(
  'specops.layout.module',
  'iwiki',
  (raw) => (raw === 'chat' ? 'chat' : 'iwiki'),
);

const clampWidth = (n: number, min = 200, max = 420) => Math.min(max, Math.max(min, n));

export const iwikiLeftWidth = persisted<number>(
  'specops.layout.iwiki.left',
  260,
  (raw) => clampWidth(Number(raw) || 260),
);
export const iwikiRightWidth = persisted<number>(
  'specops.layout.iwiki.right',
  360,
  (raw) => clampWidth(Number(raw) || 360, 240, 520),
);
export const iwikiRightOpen = persisted<boolean>(
  'specops.layout.iwiki.rightOpen',
  false,
  (raw) => raw === 'true',
);

export const chatLeftWidth = persisted<number>(
  'specops.layout.chat.left',
  260,
  (raw) => clampWidth(Number(raw) || 260),
);
export const chatRightWidth = persisted<number>(
  'specops.layout.chat.right',
  320,
  (raw) => clampWidth(Number(raw) || 320, 240, 480),
);
export const chatRightOpen = persisted<boolean>(
  'specops.layout.chat.rightOpen',
  true,
  (raw) => raw !== 'false',
);
