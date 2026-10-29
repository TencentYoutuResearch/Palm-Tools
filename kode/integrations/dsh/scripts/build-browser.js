import { fileURLToPath } from 'node:url'
/** Reuse the pinned MIT browser chrome; replace only its Web page-provider factory. */
import { createRequire } from 'node:module'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
const resolve = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json')).resolve
const upstream = resolve('@deepseek-ai/dsh-client-ui-sidebar-browser/client')
let source = await readFile(upstream, 'utf8')
const provider = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: [new URL('../packages/browser/page-source.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', write: false })
const marker = 'var module = { exports: {} };', factory = 'if (desktop === void 0) installFrames(ctx, () => createIframePage);'
if (source.split(marker).length !== 2 || source.split(factory).length !== 2) throw new Error('Pinned browser provider contract changed')
source = source.replaceAll('@deepseek-ai/dsh-client-ui-sidebar-browser', '@kode/dsh-browser')
source = source.replace(marker, `const kodeBrowserPage = (() => { const module = {exports:{}}; const exports = module.exports;\n${provider.outputFiles[0].text}\nreturn module.exports; })();\n${marker}`)
source = source.replace(factory, 'if (desktop === void 0) installFrames(ctx, () => kodeBrowserPage.createBrowserPage);')
await writeFile(new URL('../packages/browser/client.js', import.meta.url), '// Generated from @deepseek-ai/dsh-client-ui-sidebar-browser 0.2.1-rc.2 (MIT). Run npm run build:browser.\n' + source)
await copyFile(join(dirname(dirname(upstream)), 'LICENSE'), new URL('../packages/browser/LICENSE.upstream', import.meta.url))
