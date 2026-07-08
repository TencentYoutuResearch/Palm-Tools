import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import appScript from '../src/server/public/app.js'
import indexHtml from '../src/server/public/index.html'

// styles.css is read directly from disk because Vite's CSS pipeline intercepts
// the `load` hook and re-exports an empty module for .css, defeating the
// text-import plugin that works for .js / .html.
const publicDir = fileURLToPath(new URL('../src/server/public/', import.meta.url))
const styles = readFileSync(`${publicDir}/styles.css`, 'utf8')

describe('SpecOps console assets (Vite build output)', () => {
  test('produces exactly the three whitelisted static files', () => {
    const files = ['index.html', 'app.js', 'styles.css']
    for (const f of files) {
      const p = `${publicDir}/${f}`
      expect(existsSync(p), `${f} should exist`).toBe(true)
    }
    // Legacy files must be gone.
    for (const legacy of ['marked.umd.js', 'tool-preview.js', 'i18n.js']) {
      expect(existsSync(`${publicDir}/${legacy}`), `${legacy} should be removed`).toBe(false)
    }
  })

  test('index.html has no inline scripts (CSP script-src self)', () => {
    // Vite is configured with modulePreload:false to avoid inline preload.
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(indexHtml).not.toContain('unsafe-inline')
  })

  test('index.html references only external app.js and styles.css', () => {
    expect(indexHtml).toMatch(/<script[^>]+src="\/app\.js"/)
    expect(indexHtml).toMatch(/<link[^>]+href="\/styles\.css"/)
    expect(indexHtml).not.toMatch(/src="\/(marked|tool-preview|i18n)\./)
  })

  test('app.js is a valid Svelte bundle (not the legacy IIFE)', () => {
    // The legacy app.js started with "const fragment = new URLSearchParams".
    // The Svelte bundle starts with minified runtime helpers.
    expect(appScript.length).toBeGreaterThan(1000)
    expect(appScript.startsWith('const fragment')).toBe(false)
    // It must contain the Svelte hydration entry.
    expect(appScript).toMatch(/document\.getElementById\(["']app["']\)/)
  })

  test('styles.css contains the kode design tokens', () => {
    expect(styles).toContain('--bg-base:')
    expect(styles).toContain('--acc:')
    expect(styles).toContain('--sp-1:')
    expect(styles).toContain('--rad-lg:')
    expect(styles).toContain('--fs-md:')
  })

  test('styles.css covers both dark (default) and light themes', () => {
    // CSS minifier strips the quotes around attribute values.
    expect(styles).toMatch(/:root\[data-theme=["']?light["']?\]/)
    expect(styles).toMatch(/prefers-color-scheme:\s*light/)
  })

  test('asset sizes are reasonable', () => {
    const stats = {
      'index.html': statSync(`${publicDir}/index.html`).size,
      'app.js': statSync(`${publicDir}/app.js`).size,
      'styles.css': statSync(`${publicDir}/styles.css`).size,
    }
    // Sanity bounds (the legacy hand-written files were far larger).
    expect(stats['index.html']).toBeLessThan(2 * 1024)
    expect(stats['app.js']).toBeGreaterThan(10 * 1024)
    expect(stats['app.js']).toBeLessThan(500 * 1024)
    expect(stats['styles.css']).toBeGreaterThan(5 * 1024)
    expect(stats['styles.css']).toBeLessThan(100 * 1024)
  })

  test('no stray chunks leaked (single-bundle config holds)', () => {
    // Vite is configured with manualChunks:undefined + cssCodeSplit:false.
    // Only the three fixed-name files should exist in public/.
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const files = readdirSync(publicDir).sort()
    expect(files).toEqual(['app.js', 'index.html', 'styles.css'])
  })
})
