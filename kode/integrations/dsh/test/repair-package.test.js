/** Verify the shipped package can run both documented history repair entry points. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('npm package includes the Python entry points and their JavaScript workers', async () => {
  // The integration test loader redirects bare imports; npm must use its own dependencies.
  const { NODE_OPTIONS, ...env } = process.env
  const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    maxBuffer: 4 * 1024 * 1024,
    env,
  })
  const paths = new Set(JSON.parse(stdout)[0].files.map(file => file.path))
  for (const entry of ['repair-inbox-history', 'repair-plugin-records']) {
    for (const extension of ['py', 'js']) {
      const path = `scripts/${entry}.${extension}`
      assert.ok(paths.has(path), `Published package is missing ${path}`)
    }
  }
})
