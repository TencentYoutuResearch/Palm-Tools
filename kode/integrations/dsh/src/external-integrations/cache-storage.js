/** Private Host cache only. Paths and identity never come from browser input. */
import {constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {hash} from './identity.js'

function owned(info) { return typeof process.getuid !== 'function' || info.uid === process.getuid() }
function privateDirectory(path) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || (info.mode & 0o077)) throw Error('Private Host cache directory required')
}
export function privateCachePath(stateFile, identity) {
  if (!isAbsolute(stateFile)) throw Error('Absolute Host state path required')
  const parent = realpathSync(dirname(stateFile))
  const root = join(parent, 'external-resources')
  try { mkdirSync(root, {mode: 0o700}) } catch (error) { if (error.code !== 'EEXIST') throw error }
  privateDirectory(root)
  const partition = join(root, hash(identity))
  try { mkdirSync(partition, {mode: 0o700}) } catch (error) { if (error.code !== 'EEXIST') throw error }
  privateDirectory(partition)
  return join(partition, 'cache.sqlite')
}
export function openPrivateDatabase(path) {
  if (!isAbsolute(path)) throw Error('Absolute cache path required')
  privateDirectory(dirname(path))
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    closeSync(fd)
  } catch (error) { if (error.code !== 'EEXIST') throw error }
  // The protected parent prevents untrusted replacement between this check and
  // SQLite open; reject symlinks, hardlinks, foreign ownership and exposed files.
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info) || (info.mode & 0o077)) throw Error('Private cache file required')
  return new DatabaseSync(path)
}
