/** Explicit local Host startup hook. Uses the existing in-process admin client.
 * No environment-variable auto-enable, credential reads or management API.
 */
import { mkdir, lstat, realpath, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { seedTeamDemoScope } from './team-demo-fixture.js'

export async function seedTeamDemoAtStartup(client, config) {
  if (config?.enabled !== true) return null
  if (Object.keys(config).some(k => !['enabled','expectedNodeId','workspacePath','seedKey'].includes(k))
    || !/^[A-Za-z0-9_.:-]{1,100}$/.test(config.seedKey ?? '')
    || !/^[A-Za-z0-9_.:-]{1,160}$/.test(config.expectedNodeId ?? '')
    || typeof config.workspacePath !== 'string' || !config.workspacePath.startsWith('/')
    || config.workspacePath !== resolve(config.workspacePath)
    || !/^kode-team-demo-[A-Za-z0-9_-]{1,80}$/.test(basename(config.workspacePath))) {
    throw Error('Explicit demo node, temporary workspace and stable seed key required')
  }
  const origin = new URL(client.url)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw Error('Demo startup requires the existing local Hub client')
  const parent = await realpath(dirname(config.workspacePath))
  if (parent !== await realpath(tmpdir())) throw Error('Demo workspace must be a dedicated direct child of the system temporary directory')
  const node = await client.call('/api/v1/messaging/node')
  if (node.node_id !== config.expectedNodeId) throw Error('Demo startup Hub identity mismatch; no directory or records created')
  const markerPath = join(config.workspacePath, '.kode-team-demo.json')
  const expected = JSON.stringify({ format: 'kode.team-demo.v1', expectedNodeId: config.expectedNodeId, seedKey: config.seedKey, workspacePath: config.workspacePath })
  let created = false
  try { await mkdir(config.workspacePath, { mode: 0o700 }); created = true } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = await lstat(config.workspacePath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Demo workspace must be a real dedicated directory')
  if (created) await writeFile(markerPath, expected, { flag: 'wx', mode: 0o600 })
  else {
    const marker = await lstat(markerPath)
    if (!marker.isFile() || marker.isSymbolicLink() || await readFile(markerPath, 'utf8') !== expected) throw Error('Existing directory is not this demo scope; no records seeded')
  }
  return seedTeamDemoScope(client, config)
}

/** Host admission stays available when demo setup fails. Never log error objects,
 * backend responses, credentials or request payloads from this optional path.
 */
export async function runTeamDemoStartup(client, config) {
  try {
    const result = await seedTeamDemoAtStartup(client, config)
    return result ? { status: 'ready', namespace: result.namespace } : { status: 'disabled' }
  } catch {
    return { status: 'blocked', code: 'DEMO_STARTUP_FAILED' }
  }
}
