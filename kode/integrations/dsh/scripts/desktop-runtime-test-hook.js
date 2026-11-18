/** Test against an extracted official Desktop runtime, leaving pinned UI build inputs intact.
 * KODE_DSH_COMPAT_RUNTIME must point at its dsh/ directory (with node_modules/).
 * Fail closed when an upstream package is absent; never silently test a local fallback. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { readFileSync } from 'node:fs'
const runtime = resolve(process.env.KODE_DSH_COMPAT_RUNTIME)
const anchor = pathToFileURL(join(runtime, 'package.json')).href
const manifest = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh-session/package.json')))
if (!manifest.version) throw new Error('A prepared official DSH runtime is required')
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, specifier.startsWith('@deepseek-ai/') ? { ...context, parentURL: anchor } : context)
} })
