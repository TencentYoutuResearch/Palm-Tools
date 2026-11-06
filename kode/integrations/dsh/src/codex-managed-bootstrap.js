/** Pin a wrapper's engine and apply Host controls after wrapper-provided defaults. */
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeManagedBootstrap } from './managed-codex-profile.js'
import { wrapperEndpoint, wrapperProviderEndpoint } from './codex-wrapper-transport.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export async function prepareManagedBootstrap(directory, configuration, settings) {
  const bootstrap = normalizeManagedBootstrap(configuration)
  await access(bootstrap.executable, constants.X_OK)
  if (bootstrap.home && !(await stat(bootstrap.home)).isDirectory()) throw new Error('Managed wrapper home unavailable')
  const manifestPath = join(directory, 'engine-bootstrap.json')
  const launcher = join(directory, 'engine-bootstrap')
  const reportPath = join(directory, 'engine-bootstrap-report.json')
  await writeFile(manifestPath, JSON.stringify({ executable: bootstrap.executable, settings,
    provider: bootstrap.provider ?? null,
    environment: { HOME: directory, CODEX_HOME: join(directory, 'codex'), XDG_CONFIG_HOME: join(directory, 'config') },
    catalogPath: join(directory, 'engine-models.json'), reportPath }), { mode: 0o600 })
  const command = [process.execPath, fileURLToPath(import.meta.url), manifestPath].map(quote).join(' ')
  await writeFile(launcher, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700 })
  return { env: { [bootstrap.pathVariable]: launcher }, reportPath }
}

export async function readManagedBootstrapReport(path, provider) {
  const report = JSON.parse(await readFile(path, 'utf8'))
  const hashes = [report.source_hash, report.effective_hash]
  if (report.version !== 1 || !Number.isSafeInteger(report.model_count) || report.model_count < 0 || report.model_count > 1024
      || (report.model_count === 0 ? hashes.some(value => value !== null) : hashes.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
    throw new Error('Invalid managed CLI bootstrap report')
  }
  let endpoint = null, transport
  if (provider) {
    if (report.transport?.provider !== provider) throw new Error('Managed wrapper provider identity changed')
    endpoint = wrapperEndpoint(report.transport.endpoint)
    transport = Object.freeze({ provider, origin: endpoint.origin, endpoint_hash: hash(endpoint.href) })
  } else if (report.transport) throw new Error('Unexpected managed wrapper transport')
  return { configuration: Object.freeze({ version: 1, source_hash: report.source_hash,
    effective_hash: report.effective_hash, model_count: report.model_count, ...(transport ? { transport } : {}) }), endpoint }
}

export async function bootstrapArguments(manifest, args) {
  if (!args.includes('app-server')) return args
  const disabled = new Set(manifest.settings.filter(value => /^features\.[A-Za-z_]+=false$/.test(value))
    .map(value => value.slice('features.'.length, -'=false'.length)))
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    let feature = ''
    if (option === '--enable') feature = args[index + 1] ?? ''
    if (option.startsWith('--enable=')) feature = option.slice('--enable='.length)
    if (feature.split(',').some(name => disabled.has(name))) throw new Error('Native feature overrides Host controls')
  }
  const settings = [...manifest.settings]
  const catalogSetting = args.findLast(arg => arg.startsWith('model_catalog_json='))
  const report = { version: 1, source_hash: null, effective_hash: null, model_count: 0 }
  if (manifest.provider) report.transport = { provider: manifest.provider, endpoint: wrapperProviderEndpoint(args, manifest.provider) }
  if (catalogSetting) {
    // Only the public model-catalog argument is consumed. Login/config files and
    // provider/authentication arguments stay opaque to this bootstrap.
    const sourcePath = JSON.parse(catalogSetting.slice('model_catalog_json='.length))
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) throw new Error('Invalid native model catalog')
    const metadata = await stat(sourcePath)
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error('Invalid native model catalog')
    const chunks = []
    let length = 0
    for await (const chunk of createReadStream(sourcePath)) {
      length += chunk.length
      if (length > 8 * 1024 * 1024) throw new Error('Invalid native model catalog')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    const catalog = JSON.parse(bytes)
    if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length || catalog.models.length > 1024
        || catalog.models.some(model => !model || typeof model !== 'object' || Array.isArray(model)
          || typeof model.slug !== 'string' || !model.slug || model.slug.length > 256)) {
      throw new Error('Invalid native model catalog')
    }
    // Granted workspace edits run through the Host's tools.
    for (const model of catalog.models) model.apply_patch_tool_type = null
    const effective = JSON.stringify(catalog)
    await writeFile(manifest.catalogPath, effective, { mode: 0o600 })
    report.source_hash = hash(bytes)
    report.effective_hash = hash(effective)
    report.model_count = catalog.models.length
    settings.push(`model_catalog_json=${JSON.stringify(manifest.catalogPath)}`)
  }
  await writeFile(manifest.reportPath, JSON.stringify(report), { mode: 0o600 })
  return [...args, ...settings.flatMap(value => ['-c', value])]
}

async function main() {
  try {
    const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const args = await bootstrapArguments(manifest, process.argv.slice(3))
    const child = spawn(manifest.executable, args, { env: { ...process.env, ...manifest.environment }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.on('error', () => {})
    process.stdin.pipe(child.stdin)
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    return await new Promise(resolve => {
      child.once('exit', code => resolve(code ?? 1))
      child.once('error', () => resolve(1))
    })
  } catch {
    process.stderr.write('Managed CLI bootstrap failed\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main())
