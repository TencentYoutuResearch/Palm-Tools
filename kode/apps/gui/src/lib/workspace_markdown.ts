import { marked, Renderer } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import { tick } from 'svelte'

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
}

/** Workspace files are untrusted: raw HTML stays text, and diagrams use a separate renderer. */
export function renderWorkspaceMarkdown(source: string): string {
  const renderer = new Renderer()
  renderer.html = ({ text }) => escapeHtml(text)
  renderer.code = ({ text, lang }) => {
    const language = lang?.split(/\s+/)[0]?.toLowerCase()
    if (language === 'mermaid') {
      // DOMPurify removes attribute values containing XML comment terminators (`-->`).
      // Encode diagram syntax so arrows survive sanitization; text fallback stays escaped.
      return `<div class="mermaid-block" data-mermaid="${encodeURIComponent(text)}"><pre><code>${escapeHtml(text)}</code></pre></div>`
    }
    let html = escapeHtml(text)
    try {
      if (language && hljs.getLanguage(language)) html = hljs.highlight(text, { language }).value
    } catch { /* Escaped source is the fallback. */ }
    return `<pre><code class="hljs">${html}</code></pre>`
  }
  const html = marked.parse(source, { renderer, async: false })
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'srcset'],
  }).replace(/<img\b[^>]*>/gi, (tag) => /\bsrc="data:image\/(?:png|jpeg|gif|webp);base64,/i.test(tag) ? tag : '')
}

function isFragmentURL(value: string): boolean {
  return value.trim().replace(/^['"]|['"]$/g, '').startsWith('#')
}

function sanitizeDiagramStyles(css: string): string {
  return css.replace(/@import[^;]+;/gi, '').replace(/url\(([^)]*)\)/gi, (value, url: string) => isFragmentURL(url) ? value : 'none')
}

let diagramId = 0
let renderQueue: Promise<unknown> = Promise.resolve()

async function renderDiagram(source: string, dark: boolean): Promise<{ svg: string; styles: string[] }> {
  const mermaid = (await import('mermaid')).default
  // Mermaid has global configuration. Serialize initialize + render so two previews cannot race.
  const task = renderQueue.catch(() => {}).then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default',
      fontFamily: 'system-ui, sans-serif',
      maxTextSize: 50_000,
      maxEdges: 500,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'htmlLabels', 'flowchart', 'dompurifyConfig'],
    })
    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
    document.body.append(container)
    // Tauri adds a nonce to style-src, which makes unsafe-inline ineffective.
    // Authorize Mermaid's generated stylesheet during measurement as well as display.
    const nonce = document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce ?? ''
    const copiedStyles = new WeakSet<Element>()
    const authorizeStyles = () => {
      if (!nonce) return
      for (const svgStyle of container.querySelectorAll('svg style')) {
        if (copiedStyles.has(svgStyle)) continue
        copiedStyles.add(svgStyle)
        const style = document.createElement('style')
        style.nonce = nonce
        style.textContent = sanitizeDiagramStyles(svgStyle.textContent ?? '')
        container.prepend(style)
      }
    }
    const styleObserver = new MutationObserver(authorizeStyles)
    styleObserver.observe(container, { childList: true, subtree: true })
    try {
      const { svg } = await mermaid.render(`workspace-diagram-${++diagramId}`, source, container)
      const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'image', 'a', 'animate', 'set'],
      })
      const template = document.createElement('template')
      template.innerHTML = clean
      // Retain only fragment references. File diagrams never load external resources.
      for (const element of template.content.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if ((attribute.localName === 'href' && !attribute.value.startsWith('#'))
            || [...attribute.value.matchAll(/url\(([^)]*)\)/gi)].some((match) => !isFragmentURL(match[1]))) {
            element.removeAttribute(attribute.name)
          }
        }
      }
      const styles: string[] = []
      for (const svgStyle of template.content.querySelectorAll('style')) {
        styles.push(sanitizeDiagramStyles(svgStyle.textContent ?? ''))
        svgStyle.remove()
      }
      return { svg: template.innerHTML, styles }
    } finally {
      styleObserver.disconnect()
      container.remove()
    }
  })
  renderQueue = task
  return task
}

type DiagramOptions = { html: string; loading: string; error: string; onRendered: () => void }

/** Svelte action: lazy load Mermaid, retire stale renders, and follow both explicit/system themes. */
export function workspaceDiagrams(node: HTMLElement, initial: DiagramOptions) {
  let options = initial
  let generation = 0
  let destroyed = false
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const isDark = () => document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme !== 'light' && !media.matches)

  async function refresh() {
    const current = ++generation
    await tick()
    if (destroyed || current !== generation) return
    const blocks = [...node.querySelectorAll<HTMLElement>('[data-mermaid]')]
    for (const block of blocks) {
      if (destroyed || current !== generation) return
      const source = decodeURIComponent(block.dataset.mermaid ?? '')
      block.setAttribute('aria-busy', 'true')
      block.setAttribute('aria-label', options.loading)
      try {
        const diagram = await renderDiagram(source, isDark())
        if (destroyed || current !== generation || !block.isConnected) return
        block.innerHTML = diagram.svg
        // Nonces are hidden during HTML serialization. Create live HTML style nodes instead.
        const nonce = document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce ?? ''
        for (const css of diagram.styles) {
          const style = document.createElement('style')
          if (nonce) style.nonce = nonce
          style.textContent = css
          block.prepend(style)
        }
        block.removeAttribute('aria-label')
      } catch {
        if (destroyed || current !== generation || !block.isConnected) return
        block.innerHTML = `<p class="mermaid-error">${escapeHtml(options.error)}</p><pre><code>${escapeHtml(source)}</code></pre>`
        block.removeAttribute('aria-label')
      } finally {
        block.removeAttribute('aria-busy')
      }
      options.onRendered()
    }
  }
  const observer = new MutationObserver(() => void refresh())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  media.addEventListener('change', refresh)
  void refresh()
  return {
    update(next: DiagramOptions) { options = next; void refresh() },
    destroy() { destroyed = true; generation++; observer.disconnect(); media.removeEventListener('change', refresh) },
  }
}
