import { relayPattern } from '../src/relay-pattern.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = new URL('../src/agent-client.js', import.meta.url)
const parts = new URL('../src/agent-client/', import.meta.url)
const defaultOutputDir = fileURLToPath(new URL('../lib/', import.meta.url))
const includes = /^[ \t]*\/\/ @include ([a-z][a-z0-9-]*\.js)\r?\n/gm

// DSH serves this export in a classic script combo. Expand the sections in
// place to preserve the factory's shared bindings and per-activation state.
export async function readAgentClientSource() {
  const source = await readFile(entry, 'utf8')
  const sections = [...source.matchAll(includes)]
  const bodies = await Promise.all(sections.map(([, file]) => readFile(new URL(file, parts), 'utf8')))
  let index = 0
  return source.replace(includes, () => bodies[index++]).replace('/* @relayPattern */ null', () => relayPattern.toString())
}

export async function buildAgentClient(outputDir = defaultOutputDir) {
  const source = await readAgentClientSource()
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'agent-client.js'), source)
}

if (import.meta.main) await buildAgentClient()
