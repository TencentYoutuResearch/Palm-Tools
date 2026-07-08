import { mount } from 'svelte'
import App from './App.svelte'

// 全局兜底:任何未捕获错误都直接渲染到屏幕,避免一片空白看不到原因
function showFatal(msg: string) {
  const root = document.getElementById('app')
  if (!root) return
  root.innerHTML = ''
  const pre = document.createElement('pre')
  pre.style.cssText =
    'color:#f14c4c;background:#1e1e1e;padding:16px;font:12px ui-monospace,Menlo,monospace;white-space:pre-wrap;height:100vh;margin:0;overflow:auto;'
  pre.textContent = '[kode-gui boot fatal]\n' + msg
  root.appendChild(pre)
}

window.addEventListener('error', (e) => {
  showFatal(`window.error: ${e.message}\n${e.error?.stack ?? ''}`)
})
window.addEventListener('unhandledrejection', (e) => {
  showFatal(`unhandledrejection: ${String(e.reason)}\n${e.reason?.stack ?? ''}`)
})

let app: any = null
try {
  app = mount(App, {
    target: document.getElementById('app')!,
  })
} catch (e: any) {
  showFatal(`mount(App) threw:\n${e?.stack ?? String(e)}`)
}

export default app
