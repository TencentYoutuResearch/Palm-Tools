/** Validate upstream window ownership before installing the shared native bridge. */
export const marker = '// Kode owned Desktop integration'
export function patchDesktopSources(main, preload, bridgeSpecifier) {
  if (!main.includes(marker)) {
    const anchor = 'window.webContents.setWindowOpenHandler(({ url }) => {'
    if (main.split(anchor).length !== 2) throw new Error('Desktop window-open contract changed')
    main = main.replace(anchor, `window.webContents.on("did-create-window", (child, details) => kodeDesktopShell.childCreated(window, child, details));
    window.webContents.setWindowOpenHandler((details) => {
      const native = kodeDesktopShell.windowOpen(window, details);
      if (native) return native;
      const { url } = details;`)
    main = main.replaceAll('app.relaunch();', 'app.relaunch(process.env.KODE_DESKTOP_EXECUTABLE ? { execPath: process.env.KODE_DESKTOP_EXECUTABLE } : undefined);')
    main = `${marker}
  import * as kodeElectron from 'electron';
  import { installDesktopShell } from ${JSON.stringify(bridgeSpecifier)};
  const kodeDesktopShell = installDesktopShell(kodeElectron);
  ` + main
  }
  if (!preload.includes(marker)) {
    if (!preload.includes('contextBridge.exposeInMainWorld') || !preload.includes('ipcRenderer')) throw new Error('Desktop preload contract changed')
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
  return { main, preload }
}
