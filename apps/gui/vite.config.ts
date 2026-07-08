import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Tauri devUrl 是 http://localhost:1437,跟 vite 端口一致
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1437,
    strictPort: true,
    host: '127.0.0.1',
  },
  // 强制使用 browser 入口解析 svelte —— 否则 vite 在 SSR 兼容路径上
  // 会把 svelte 的 server 入口拉进 client bundle,导致 mount() 等 API
  // 变成 lifecycle_function_unavailable 的 stub,运行时一片空白。
  resolve: {
    conditions: ['browser', 'module', 'import', 'default'],
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: false,
    // xterm 的 worker 走 dynamic import,vite 自己会处理
  },
  // 让 vite 预编译 xterm —— 它是 UMD bundle,直接走原始路径在 ESM 解构 import 时拿到
  // undefined(release build 没问题,因为 build 阶段会处理)。
  // 之前曾在 exclude 里"为了首屏 < 200ms",但首屏指标只在 release 衡量;dev 模式
  // 预编译反而消除了首次访问时的二次加载延迟。
  optimizeDeps: {
    include: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', '@xterm/addon-search'],
  },
})
