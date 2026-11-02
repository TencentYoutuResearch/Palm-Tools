/** Launch parameters supplied by Kode's backend-owned extension catalog. */
export function withNativePlugins(profile, sources) {
  if (!['claude', 'codebuddy', 'cursor'].includes(profile.type)) return profile
  const paths = [...new Set(sources.filter(source => source.targets.includes(profile.type)).flatMap(source => source.plugins?.[profile.type] ?? []).map(plugin => plugin.path))]
  if (!paths.length) return profile
  return { ...profile, args: [...(profile.args ?? []), ...paths.flatMap(path => ['--plugin-dir', path])] }
}
