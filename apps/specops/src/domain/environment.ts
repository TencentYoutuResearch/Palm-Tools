import { createHash, randomBytes } from 'node:crypto'

import { exists, pathInside, readText } from '../store/workspace.js'

export interface ReproducibleEnvironment {
  platform: string
  arch: string
  runtime: string
  network: 'restricted'
  secrets: 'isolated'
  base_commit: string
  lock_hash: string | null
  toolchains: Record<string, string>
  browser: string | null
  feature_flags: string[]
  locale: string
  timezone: string
  random_seed: string
}

export async function captureEnvironment(workspace: string, baseCommit: string): Promise<ReproducibleEnvironment> {
  const lockNames = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'pubspec.lock']
  const hash = createHash('sha256'); let found = false
  for (const name of lockNames) {
    const file = pathInside(workspace, name)
    if (!await exists(file)) continue
    hash.update(name).update(await readText(file)); found = true
  }
  const featureFlags = Object.keys(process.env).filter((key) => /^(?:KODE|SPECOPS)_FEATURE_/.test(key)).sort()
  return {
    platform: process.platform, arch: process.arch, runtime: process.version,
    network: 'restricted', secrets: 'isolated', base_commit: baseCommit,
    lock_hash: found ? hash.digest('hex') : null,
    toolchains: { node: process.version, v8: process.versions.v8 ?? 'unknown', bun: process.versions.bun ?? 'not-running-under-bun' },
    browser: process.env.SPECOPS_BROWSER_VERSION ?? null,
    feature_flags: featureFlags, locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    random_seed: randomBytes(16).toString('hex'),
  }
}
