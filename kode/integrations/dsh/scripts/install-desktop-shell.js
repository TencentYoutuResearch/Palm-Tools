/** Patch only an unpacked development shell, preserving backups and checking upstream anchors. */
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
const marker = '// Kode owned Desktop integration'
if (!main.includes(marker)) {
  const anchor = 'window.webContents.setWindowOpenHandler(({ url }) => {'
  if (!main.includes(anchor)) throw new Error('Desktop window-open contract changed')
  main = main.replace(anchor, `window.webContents.on("did-create-window", (child, details) => kodeDesktopShell.childCreated(window, child, details));
  window.webContents.setWindowOpenHandler((details) => {
    const native = kodeDesktopShell.windowOpen(window, details);
    if (native) return native;
    const { url } = details;`)
  main = main.replaceAll('app.relaunch();', 'app.relaunch(process.env.KODE_DESKTOP_EXECUTABLE ? { execPath: process.env.KODE_DESKTOP_EXECUTABLE } : undefined);')
  main = `${marker}
import * as kodeElectron from 'electron';
import { installDesktopShell } from ${JSON.stringify(pathToFileURL(join(root, 'src/desktop-shell.js')).href)};
const kodeDesktopShell = installDesktopShell(kodeElectron);
` + main
}
if (!preload.includes(marker)) {
  preload += `
${marker}
{
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('kodeDesktop', {
    island: process.platform === 'darwin',
    resizeIsland: size => ipcRenderer.send('kode-desktop:island-size', size),
    notify: data => ipcRenderer.invoke('kode-desktop:notification', data),
    openNotificationSettings: () => ipcRenderer.invoke('kode-desktop:notification-settings'),
    onNotificationClick: callback => {
      const handler = (_event, key) => callback(key);
      ipcRenderer.on('kode-desktop:notification-click', handler);
      return () => ipcRenderer.removeListener('kode-desktop:notification-click', handler);
    },
  });
}
`
}
for (const [path, content] of [[mainPath, main], [preloadPath, preload]]) {
  if (!(await readFile(path, 'utf8')).includes(marker)) await copyFile(path, path + '.before-kode-shell')
  await writeFile(path, content)
}
console.log('Installed Kode Desktop bridge')
