/** Lives above Host generations so the connection indicator survives client-plugin replacement. */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
export function showConnectionProgress(label, document = globalThis.document) {
  const style = document.createElement('style')
  style.textContent = `.kode-host-connection-status{position:fixed;z-index:10000;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:12px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px var(--ds-font-family-ui,sans-serif);box-shadow:0 4px 16px rgb(0 0 0 / .12);pointer-events:none;animation:kode-host-feedback 150ms ease-out}.kode-host-connection-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:16px}.kode-host-connection-icon>svg{flex:none;display:block}@keyframes kode-host-feedback{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.kode-host-connection-status,.kode-host-connection-icon *{animation:none}}`
  const indicator = document.createElement('div'), spinner = document.createElement('span'), text = document.createElement('span')
  indicator.className = 'kode-host-connection-status'; indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite')
  spinner.className = 'kode-host-connection-icon'; spinner.setAttribute('aria-hidden', 'true'); text.textContent = label
  indicator.append(spinner, text); document.head.append(style); document.body.append(indicator)
  const root = createRoot(spinner); root.render(createElement(StateDot, { state: 'ongoing', size: 16 }))
  const visibility = () => { indicator.style.display = document.hidden ? 'none' : '' }
  visibility(); document.addEventListener('visibilitychange', visibility)
  return () => { document.removeEventListener('visibilitychange', visibility); root.unmount(); indicator.remove(); style.remove() }
}
