// shims for Tauri / Svelte
/// <reference types="vite/client" />

declare module '*.svelte' {
  import { ComponentType } from 'svelte'
  const component: ComponentType
  export default component
}

declare module '@xterm/xterm/css/xterm.css'

declare module '@tauri-apps/plugin-global-shortcut' {
  export type ShortcutEvent = { state?: 'Pressed' | 'Released' | string }
  export function register(
    accelerator: string,
    handler: (event: ShortcutEvent) => void,
  ): Promise<void>
  export function unregister(accelerator: string): Promise<void>
}
