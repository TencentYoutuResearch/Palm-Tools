/** Repack Desktop without changing upstream native-file placement or symlinks. */
import * as asar from '@electron/asar'
import { Readable } from 'node:stream'
import { posix, join } from 'node:path'
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { patchDesktopSources } from './desktop-patch.js'

export async function patchDesktopArchive(source, destination) {
  const manifest = JSON.parse(asar.extractFile(source, 'package.json'))
  if (manifest.name !== '@deepseek-ai/dsh-desktop' || manifest.main !== 'lib/main.js') throw new Error('Expected a supported DSH Desktop application')
  const patched = patchDesktopSources(asar.extractFile(source, 'lib/main.js').toString(), asar.extractFile(source, 'lib/preload-app.cjs').toString(), '../../kode-desktop/src/desktop-shell.js')
  const replacements = new Map([['lib/main.js', Buffer.from(patched.main)], ['lib/preload-app.cjs', Buffer.from(patched.preload)]])
  const streams = []
  function visit(files, parent = '', inheritedUnpacked = false) {
    for (const [name, node] of Object.entries(files)) {
      const path = posix.join(parent, name), unpacked = !!node.unpacked || inheritedUnpacked
      const stat = { size: replacements.get(path)?.length ?? node.size ?? 0, mode: unpacked && !node.files && !node.link ? statSync(join(source + '.unpacked', path)).mode : node.executable ? 0o100755 : 0o100644 }
      if (node.files) {
        streams.push({ path, type: 'directory', unpacked, stat })
        visit(node.files, path, unpacked)
      } else if (node.link) {
        streams.push({ path, type: 'link', unpacked, stat, symlink: posix.relative(posix.dirname(path), node.link) })
      } else {
        streams.push({ path, type: 'file', unpacked, stat, streamGenerator: () => Readable.from(replacements.get(path) ?? asar.extractFile(source, path)) })
      }
    }
  }
  visit(asar.getRawHeader(source).header.files)
  await asar.createPackageFromStreams(destination, streams)
  asar.uncache(destination)
  return { version: manifest.version, hash: createHash('sha256').update(asar.getRawHeader(destination).headerString).digest('hex') }
}
