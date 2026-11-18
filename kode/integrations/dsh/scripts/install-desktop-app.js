/** Install the native bridge in a staged copy of the official macOS application.
 * Keep the public app identity/runtime/update feed; replace only after signature verification.
 * Upstream updates replace this integration. Rerun against the updated app to reinstall it. */
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rename, rm, realpath, access } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchDesktopArchive } from '../src/desktop-archive.js'

if (process.platform !== 'darwin') throw new Error('Packaged Desktop integration requires macOS')
if (!process.argv[2]) throw new Error('Usage: node scripts/install-desktop-app.js "/Applications/DeepSeek Harness.app"')
const target = await realpath(resolve(process.argv[2]))
if (!target.endsWith('.app')) throw new Error('Expected a macOS .app bundle')
const plist = join(target, 'Contents/Info.plist')
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])
if (identifier !== 'com.deepseek.dsh') throw new Error('Expected the official DSH Desktop bundle identifier')
const binary = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist])
if (run('/bin/ps', ['-axo', 'comm=']).split('\n').some(line => line.trim() === join(target, 'Contents/MacOS', binary))) throw new Error('Quit the official Desktop app before installing its native bridge')
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
const root = fileURLToPath(new URL('..', import.meta.url))
for (const file of ['src/desktop-shell.js', 'src/desktop-runtime.js', 'assets/desktop/screen-layout']) await access(join(root, file))
const staging = await mkdtemp(join(dirname(target), '.kode-desktop-install-'))
const next = join(staging, basename(target)), old = join(staging, 'previous.app')
let swapped = false
try {
  await cp(target, next, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  const resources = join(next, 'Contents/Resources')
  const archive = join(resources, 'app.asar'), patchedArchive = join(resources, 'kode-patched.asar')
  const result = await patchDesktopArchive(archive, patchedArchive)
  await rename(patchedArchive, archive)
  // Preserve the original unpacked tree. Its files were not modified.
  await rm(patchedArchive + '.unpacked', { recursive: true, force: true })
  for (const file of ['src/desktop-shell.js', 'src/desktop-runtime.js', 'assets/desktop/screen-layout']) await cp(join(root, file), join(resources, 'kode-desktop', file), { recursive: true })
  const nextPlist = join(next, 'Contents/Info.plist')
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :ElectronAsarIntegrity:Resources/app.asar:hash ' + result.hash, nextPlist])
  // Local modifications invalidate the publisher signature. Seal this installation
  // while retaining its entitlements and the signed nested binaries.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--preserve-metadata=entitlements', next])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', next])
  await rename(target, old)
  try { await rename(next, target); swapped = true } catch (error) { await rename(old, target); throw error }
  run('/usr/bin/defaults', ['write', identifier, 'AppleMenuBarVisibleInFullscreen', '-bool', 'true'])
  run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', target])
  console.log('Installed Kode system menu-bar bridge in DSH Desktop ' + result.version + ' (local ad-hoc signature)')
} finally {
  // Only this invocation's allocated staging directory is removed. If rollback
  // itself failed, retain the original there rather than deleting it.
  if (swapped || !(await access(old).then(() => true, () => false))) await rm(staging, { recursive: true, force: true })
}
