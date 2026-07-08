type TauriWindow = {
  startDragging?: () => Promise<void>;
  toggleMaximize?: () => Promise<void>;
};

type TauriGlobal = {
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriWindow;
  };
  window?: {
    getCurrentWindow?: () => TauriWindow;
  };
};

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

function currentWindow(): TauriWindow | null {
  const tauri = window.__TAURI__;
  return (
    tauri?.webviewWindow?.getCurrentWebviewWindow?.() ??
    tauri?.window?.getCurrentWindow?.() ??
    null
  );
}

export function onWindowDragMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, a, [role="button"], select, textarea, .no-drag')) return;

  const appWindow = currentWindow();
  const action = event.detail === 2 ? appWindow?.toggleMaximize?.() : appWindow?.startDragging?.();
  if (!action) return;

  event.preventDefault();
  action.catch((err: unknown) => console.error('SpecOps window drag failed:', err));
}
