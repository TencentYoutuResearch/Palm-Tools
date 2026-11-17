import React from 'react'
import { IconButton } from './icons.js'
import { TeamRoleTargets, validRoleTargets } from './team-role-targets.js'
const h = React.createElement

/** The DM itself. Worker rows use the team's own worker ids. */
export const SUPERAGENT_ROLE = 'superagent'
const preferenceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)

export function teamRoleRows(team) {
  const workers = Array.isArray(team?.spec?.workers) ? team.spec.workers : []
  return [{ id: SUPERAGENT_ROLE, label: team?.spec?.name || 'Superagent', note: '在这个私信里回复你的 Agent' },
    ...workers.filter(row => preferenceId(row?.id) && row.id !== SUPERAGENT_ROLE)
      .map(row => ({ id: row.id, label: row.role || row.id, note: Array.isArray(row.responsibilities) ? row.responsibilities.join('、') : '',
        capabilities: Array.isArray(row.required_capabilities) ? row.required_capabilities.filter(value => typeof value === 'string' && value) : [] }))]
}

/** What the team revision may actually run on. Local defaults never change it. */
export function authorizedTargets(team, roleId) {
  const spec = team?.spec ?? {}, targets = Array.isArray(spec.execution_targets) ? spec.execution_targets : []
  const ids = roleId === SUPERAGENT_ROLE ? spec.coordinator_targets : spec.workers?.find?.(row => row.id === roleId)?.allowed_target_ids
  return (Array.isArray(ids) ? ids : []).map(id => targets.find(row => row?.id === id)).filter(Boolean)
}

/** The owner Hub's current configuration revision; directory rows and browser receipts are not authority. */
export async function readTeamConfiguration(request, team, signal) {
  const value = await request(`/api/kode/collab/teams?team_id=${encodeURIComponent(team.id)}`, { signal })
  const row = value?.team
  if (value?.projection !== 'configuration_revision' || row?.id !== team.id || row.home_hub !== team.home_hub
    || row.superagent_id !== team.superagent_id || row.conversation_id !== team.conversation_id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw Error('Wrong team configuration')
  return row
}

/** Per-Agent model catalogs from the adapter (never typed in); one read per Agent, failures retried on next ask. */
export function useAgentCatalogs(controls, host) {
  const [catalogs, setCatalogs] = React.useState({}), pending = React.useRef(new Map())
  const catalog = React.useCallback(profileId => {
    if (!pending.current.has(profileId)) {
      const task = controls.readAgentConfiguration({ host, profileId }).then(value => ({ value }), failure => ({ failure: failure.message || '无法读取此 Agent 的模型。' }))
        .then(row => { setCatalogs(current => ({ ...current, [profileId]: row })); if (row.failure) pending.current.delete(profileId); return row })
      pending.current.set(profileId, task)
    }
    return pending.current.get(profileId)
  }, [controls, host])
  return [catalogs, catalog]
}

const validPreferences = (value, teamId) => !!value && value.teamId === teamId && value.scope === 'local_host'
  && value.eligibleForExecution === false && Number.isSafeInteger(value.preferenceRevision) && value.preferenceRevision >= 0
  && !!value.assignments && typeof value.assignments === 'object' && !Array.isArray(value.assignments)

/** Local execution preferences use the existing versioned Agent configuration API.
 * They do not alter the authorized execution_targets used to dispatch an existing Team. */
export function TeamAgentDefaults({ controls, team, host = 'local' }) {
  const [config, setConfig] = React.useState(null), [error, setError] = React.useState(''), [generation, reload] = React.useReducer(value => value + 1, 0)
  const [catalogs, catalog] = useAgentCatalogs(controls, host)
  React.useEffect(() => {
    if (!controls?.readAgentConfiguration || !preferenceId(team?.id)) return
    let alive = true; setError('')
    controls.readAgentConfiguration({ host, teamId: team.id }).then(value => {
      if (!alive) return
      const targets = !!controls.saveTeamRoleTargets && validRoleTargets(value.teamRoleTargets, team.id)
      if (!targets && !validPreferences(value.teamRolePreferences, team.id)) { setConfig(null); setError('无法识别本机保存的团队偏好，没有显示或修改。'); return }
      if (!targets) delete value.teamRoleTargets
      setConfig(value)
    }).catch(failure => { if (alive) setError(failure.message || '无法读取 Agent 配置。') })
    return () => { alive = false }
  }, [controls, host, team?.id, generation])
  const profiles = (config?.profiles ?? []).filter(row => !config?.supportedTypes || config.supportedTypes.includes(row.type))
  if (!controls?.AgentPicker || !controls?.ModelPicker || !controls?.readAgentConfiguration || (!controls?.saveTeamRoles && !controls?.saveTeamRoleTargets)) return h('p', { className: 'kode-config-note', role: 'status' }, '原生 Agent 控件不可用，请更新 Kode 插件。')
  return h('div', { className: 'kode-settings-group kode-team-agent-defaults', 'aria-label': '执行配置' },
    h('h3', { className: 'kode-settings-group-title' }, '执行配置'),
    error ? h('p', { className: 'kode-config-note', role: 'status' }, error, ' ', h(IconButton, { icon: 'refresh', label: '重新读取', onClick: reload }))
      : !config ? h('p', { className: 'kode-config-note', role: 'status' }, '正在读取执行配置…')
        : h(TeamRoleTargets, { controls, team, host, config, profiles, catalogs, catalog, onConflict: reload,
          onSaved: result => setConfig(current => ({ ...current, ...(current.teamRoleTargets ? { teamRoleTargets: result } : { teamRolePreferences: result }) })) }))
}

/** Same component for entries that only know the directory row (Builder, Settings). */
export function HubTeamAgentDefaults({ controls, request, team }) {
  const [configuration, setConfiguration] = React.useState(null), [error, setError] = React.useState(''), [generation, reload] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    const controller = new AbortController(); setConfiguration(null); setError('')
    readTeamConfiguration(request, team, controller.signal).then(row => { if (!controller.signal.aborted) setConfiguration(row) },
      () => { if (!controller.signal.aborted) setError('无法读取团队配置，没有显示或修改任何内容。') })
    return () => controller.abort()
  }, [request, team.id, team.home_hub, generation])
  if (error || !configuration) return h('div', { className: 'kode-settings-group', 'aria-label': '执行配置' },
    h('h3', { className: 'kode-settings-group-title' }, '执行配置'),
    h('p', { className: 'kode-config-note', role: 'status' }, error || '正在读取团队配置…', error && ' ', error && h(IconButton, { icon: 'refresh', label: '重新读取', onClick: reload })))
  return h(TeamAgentDefaults, { controls, team: configuration })
}
