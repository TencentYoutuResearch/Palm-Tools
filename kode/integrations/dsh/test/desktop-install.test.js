/** Check a real ASAR round trip, including binaries Electron must load outside it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as asar from '@electron/asar'
import { patchDesktopArchive } from '../src/desktop-archive.js'
import { marker, patchDesktopSources } from '../src/desktop-patch.js'

const main = 'import { app } from "electron";\nwindow.webContents.setWindowOpenHandler(({ url }) => { return {action:"deny"}; });\napp.relaunch();'
const preload = 'const electron = require("electron"); const { ipcRenderer } = electron; electron.contextBridge.exposeInMainWorld("desktop", {});'
test('packaged patch keeps runtime, executable native files and symlinks intact, and supports reinstall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-desktop-archive-'))
  try {
    const source = join(root, 'source'), first = join(root, 'first.asar'), second = join(root, 'second.asar'), third = join(root, 'third.asar')
    await mkdir(join(source, 'lib'), { recursive: true }); await mkdir(join(source, 'native'))
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.3', main: 'lib/main.js' }))
    await writeFile(join(source, 'lib/main.js'), main); await writeFile(join(source, 'lib/preload-app.cjs'), preload)
    const bytes = Buffer.from([0, 1, 128, 255])
    await writeFile(join(source, 'native/helper'), bytes); await chmod(join(source, 'native/helper'), 0o755)
    await symlink('helper', join(source, 'native/current'))
    await writeFile(join(source, 'lib/untouched.js'), 'export const upstream = true')
    await asar.createPackageWithOptions(source, first, { unpackDir: 'native' })
    const result = await patchDesktopArchive(first, second)
    assert.equal(result.version, '0.2.2-rc.3'); assert.match(result.hash, /^[a-f0-9]{64}$/)
    assert.deepEqual(asar.extractFile(second, 'native/helper'), bytes)
    assert.deepEqual(await readFile(second + '.unpacked/native/helper'), bytes)
    assert.ok((await stat(second + '.unpacked/native/helper')).mode & 0o111)
    assert.equal(asar.statFile(second, 'native/helper').unpacked, true)
    assert.equal(asar.statFile(second, 'native/current', false).link, 'native/helper')
    assert.equal(asar.extractFile(second, 'lib/untouched.js').toString(), 'export const upstream = true')
    const patched = asar.extractFile(second, 'lib/main.js').toString()
    assert.match(patched, /\.\.\/\.\.\/kode-desktop\/src\/desktop-shell.js/)
    assert.equal(patched.split(marker).length, 2)
    await patchDesktopArchive(second, third)
    assert.equal(asar.extractFile(third, 'lib/main.js').toString(), patched)
    assert.equal(asar.extractFile(third, 'lib/preload-app.cjs').toString().split(marker).length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('unknown upstream window contracts fail before touching an archive', () => {
  assert.throws(() => patchDesktopSources('window.webContents.setWindowOpenHandler(() => {})', preload, './bridge.js'), /contract changed/)
})

test('unknown preload contracts fail rather than exposing a partial bridge', () => {
  assert.throws(() => patchDesktopSources(main, 'module.exports = {}', './bridge.js'), /preload contract changed/)
})
