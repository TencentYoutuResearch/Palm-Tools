/** Launch parameters supplied by Kode's backend-owned extension catalog. */
import { isAbsolute, join, normalize } from 'node:path'

export function withNativePlugins(profile, sources, profileTargets, targets) {
  const nativeEnv = { claude: 'CLAUDE_CONFIG_DIR', codebuddy: 'CODEBUDDY_CONFIG_DIR', cursor: '' }
  if (!Object.hasOwn(nativeEnv, profile.type)) return profile
  const target = profileTargets ? profileTargets[profile.id] : profile.type
  if (!target) return profile
  const explicit = profile.env?.KODE_SKILLS_DIR, config = profile.env?.[nativeEnv[profile.type]]
  const directory = explicit && isAbsolute(explicit) ? explicit : config && isAbsolute(config) ? join(config, 'skills') : undefined
  if (profileTargets && (target.startsWith('directory-') || directory) &&
      (!directory || !targets?.[target] || normalize(directory) !== normalize(targets[target]))) return profile
  const paths = [...new Set(sources.filter(source => (source.syncedTargets ?? source.targets).includes(target))
    .flatMap(source => source.plugins?.[profile.type] ?? []).map(plugin => plugin.path))]
  if (!paths.length) return profile
  return { ...profile, args: [...(profile.args ?? []), ...paths.flatMap(path => ['--plugin-dir', path])] }
}
