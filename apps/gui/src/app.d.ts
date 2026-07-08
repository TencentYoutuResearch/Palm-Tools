// shims for Tauri / Svelte
/// <reference types="vite/client" />

declare module '*.svelte' {
  import { ComponentType } from 'svelte'
  const component: ComponentType
  export default component
}

declare module '@xterm/xterm/css/xterm.css'
