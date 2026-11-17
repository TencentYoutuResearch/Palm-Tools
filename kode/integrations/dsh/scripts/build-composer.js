/** Reproducible, fail-closed native composer extraction. Never edits node_modules. */
import { createRequire } from 'node:module'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json'))
const out = new URL('../packages/composer/', import.meta.url)
const lock = JSON.parse(await readFile(new URL('upstream-lock.json', out), 'utf8'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = await readFile(join(root, 'lib/client.js'), 'utf8')
const extension = await readFile(new URL('../patches/dsh-conversation-0.2.1-rc.5/extension.js', import.meta.url), 'utf8')
const sha = value => createHash('sha256').update(value).digest('hex')
if (manifest.name !== lock.name || manifest.version !== lock.version || sha(source) !== lock.clientSha256 || sha(extension) !== lock.extensionSha256) {
  throw Error('Composer upstream/extension lock mismatch; review and rebase explicitly before building')
}
// Keep the actual native editor, keymap and CSS. Remove the module wrapper and
// all official plugin exports, then tree-shake the resulting private module.
// No native plugin apply() is called or exported by this independent client.
const start = '\t\t//#region \\0rolldown/runtime.js'
const end = '\t\texports.Config = Config;'
if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Composer extraction seam changed')
let body = source.slice(source.indexOf(start), source.indexOf(end))
body = body.replace(/let ([\w$]+) = require\("([^"\n]+)"\);/g, 'import * as $1 from "$2";')
// Upstream normalizes React's CJS namespace; ESM namespace imports already do it.
body = body.replace('\t\treact = __toESM(react, 1);', '')
// The pinned extraction can coexist with another official build whose CSS module
// class hashes differ. Never claim the official plugin's CSS de-duplication IDs.
let isolatedCss = 0
body = body.replace(/((?:const|let|var) tagId[\w$]* = )"@deepseek-ai\/dsh-client-ui-conversation\/([^"\n]+\.css)"/g, (_, declaration, file) => {
  isolatedCss++
  return declaration + JSON.stringify('@kode/dsh-composer/' + lock.clientSha256.slice(0, 12) + '/' + file)
})
body = body.replaceAll('tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-conversation";', 'tag.dataset.plugin = "@kode/dsh-composer";')
if (!isolatedCss || /(?:const|let|var) tagId[\w$]* = "@deepseek-ai\//.test(body)) throw Error('Composer CSS isolation seam changed')
const adapter = extension.replace('exports.PortableTextComposer = PortableTextComposer;', '')
  .replace('exports.portableComposerCapabilities =', 'const portableComposerCapabilities =')
  .replace('exports.apply = applyPortableComposer;', '')
const result = await build({
  stdin: { contents: body + '\n' + adapter + '\nexport { PortableTextComposer, portableComposerCapabilities, applyPortableComposer as apply };', resolveDir: root, sourcefile: 'native-composer.js' },
  bundle: true, format: 'cjs', platform: 'browser', treeShaking: true,
  packages: 'external', write: false,
})
const output = `// Generated from pinned dsh ${lock.version} (MIT). npm run build:composer\nwindow.__ModuleLoader__.load({id:'@kode/dsh-composer',factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`
await writeFile(new URL('client.js', out), output)
await copyFile(join(root, 'LICENSE'), new URL('LICENSE.upstream', out))
await copyFile(new URL('../patches/dsh-conversation-0.2.1-rc.5/portable-composer.d.ts', import.meta.url), new URL('client.d.ts', out))
