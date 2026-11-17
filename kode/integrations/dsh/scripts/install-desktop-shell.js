/** Patch only an unpacked development shell, preserving backups and checking upstream anchors. */
import { marker, patchDesktopSources } from '../src/desktop-patch.js'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
if (!process.argv[2]) throw new Error('Usage: node scripts/install-desktop-shell.js /path/to/unpacked-desktop')
const directory = resolve(process.argv[2]), root = fileURLToPath(new URL('..', import.meta.url))
if (directory.includes('.app/Contents')) throw new Error('Only an unpacked development shell can be patched')
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
if (manifest.name !== '@deepseek-ai/dsh-desktop') throw new Error('Expected the DSH Desktop development shell')
const mainPath = join(directory, 'lib/main.js'), preloadPath = join(directory, 'lib/preload-app.cjs')
let main = await readFile(mainPath, 'utf8'), preload = await readFile(preloadPath, 'utf8')
const { main: patchedMain, preload: patchedPreload } = patchDesktopSources(main, preload, pathToFileURL(join(root, 'src/desktop-shell.js')).href)
main = patchedMain; preload = patchedPreload
for (const [path, content] of [[mainPath, main], [preloadPath, preload]]) {
  if (!(await readFile(path, 'utf8')).includes(marker)) await copyFile(path, path + '.before-kode-shell')
  await writeFile(path, content)
}
// App-scoped: preserve the system app menu and status items in full screen.
if (process.platform === 'darwin') execFileSync('/usr/bin/defaults', ['write', 'com.deepseek.dsh.development', 'AppleMenuBarVisibleInFullscreen', '-bool', 'true'])
console.log('Installed Kode Desktop bridge')
