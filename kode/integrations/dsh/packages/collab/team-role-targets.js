import React from 'react'
const h = React.createElement

/** Server contract: local only, never eligible for execution, versioned for CAS. */
export const validRoleTargets = (value, teamId) => !!value && value.version === 1 && value.teamId === teamId && value.scope === 'local_host'
  && value.eligibleForExecution === false && Number.isSafeInteger(value.preferenceRevision) && value.preferenceRevision >= 0
  && !!value.assignments && typeof value.assignments === 'object' && !Array.isArray(value.assignments)
  && Object.values(value.assignments).every(Array.isArray)

const EXECUTION_ROLE = 'superagent'
const LITE_ROLE = 'superagent_lite'
const clean = row => ({ profileId: row.profileId, model: row.model, ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}), ...(typeof row.fast === 'boolean' ? { fast: row.fast } : {}) })
const defaultCandidate = (profileId, configuration) => {
  const models = configuration?.models ?? [], defaults = configuration?.defaultModelSelection
  const model = models.find(row => row.id === defaults?.model) ?? models[0]
  if (!model) return null
  const effort = model.id === defaults?.model && model.reasoningEfforts?.some(row => row.id === defaults.reasoningEffort) ? defaults.reasoningEffort : undefined
  return { profileId, model: model.id, ...(effort ? { reasoningEffort: effort } : {}) }
}
export const teamRoleFallbackProfile = (team, config, profiles) => [
  team?.spec?.execution_targets?.[0]?.executor_profile_id,
  config.configuredDefaultProfileId,
  config.selectedProfileId,
].map(id => profiles.find(row => row.id === id && row.type !== 'dsh')).find(Boolean)
  ?? profiles.find(row => row.type !== 'dsh')

/** One execution Agent with two local model preferences. Other saved roles and authorized
 * team execution_targets are preserved verbatim; this editor never grants or rebinds them. */
export function TeamRoleTargets({ controls, team, host, config, profiles, catalogs, catalog, onSaved, onConflict }) {
  const targets = config.teamRoleTargets, legacy = config.teamRolePreferences
  const assignments = targets?.assignments ?? legacy?.assignments ?? {}
  const saved = targets ? assignments[EXECUTION_ROLE] ?? [] : null
  const reasonable = targets ? saved[0] : assignments[EXECUTION_ROLE]
  const lite = targets ? saved[1] : assignments[LITE_ROLE]
  const profileId = reasonable?.profileId ?? lite?.profileId ?? teamRoleFallbackProfile(team, config, profiles)?.id
  const profile = profiles.find(row => row.id === profileId)
  const catalogRow = profile ? catalogs[profile.id] : null
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  React.useEffect(() => { if (profile) void catalog(profile.id) }, [profile?.id, catalog])

  const write = async (nextReasonable, nextLite) => {
    if (busy || !nextReasonable) return
    setBusy(true); setMessage('')
    try {
      if (targets) {
        const next = { ...assignments }, rest = saved.slice(2)
        const pair = [nextReasonable, nextLite, ...rest].filter(Boolean).map(clean)
        if (pair.length) next[EXECUTION_ROLE] = pair; else delete next[EXECUTION_ROLE]
        const result = await controls.saveTeamRoleTargets({ host, teamId: team.id, expectedRevision: targets.preferenceRevision, assignments: next })
        if (!validRoleTargets(result, team.id)) throw Error('服务返回的执行配置不属于此团队，未采用。')
        onSaved({ ...result, diagnostics: [] })
      } else {
        const next = { ...assignments, [EXECUTION_ROLE]: clean(nextReasonable) }
        if (nextLite) next[LITE_ROLE] = clean(nextLite); else delete next[LITE_ROLE]
        const result = await controls.saveTeamRoles({ host, teamId: team.id, expectedRevision: legacy.preferenceRevision, assignments: next })
        if (!result || result.teamId !== team.id || result.scope !== 'local_host' || result.eligibleForExecution !== false) throw Error('服务返回的执行配置不属于此团队，未采用。')
        onSaved(result)
      }
      setMessage('已保存执行配置。已有会话与团队授权保持不变。')
    } catch (failure) {
      if (failure.status === 409) { setMessage('执行配置已在其它窗口更新，这次没有保存。已重新读取，请确认后再选择。'); onConflict() }
      else setMessage(failure.message || '未保存，请重试。')
    } finally { setBusy(false) }
  }

  const selectAgent = async id => {
    const row = await catalog(id), candidate = defaultCandidate(id, row.value)
    if (!candidate) { setMessage(row.failure || '此 Agent 当前没有可用模型，没有保存。'); return }
    await write(candidate, { ...candidate })
  }
  const selectModel = (kind, patch) => {
    if (!profile) return
    const saved = kind === 'reasonable' ? reasonable : lite
    const fallback = defaultCandidate(profile.id, catalogRow?.value)
    const current = saved?.profileId === profile.id ? saved : fallback
    if (!current) { setMessage('此 Agent 当前没有可用模型，没有保存。'); return }
    const model = patch.model ?? current.model, efforts = catalogRow?.value?.models?.find(row => row.id === model)?.reasoningEfforts ?? []
    const effort = patch.reasoningEffort ?? (model === current.model ? current.reasoningEffort : undefined)
    const next = { profileId: profile.id, model, ...(effort && efforts.some(row => row.id === effort) ? { reasoningEffort: effort } : {}),
      ...(model === current.model && typeof patch.fast === 'boolean' ? { fast: patch.fast } : model === current.model && typeof current.fast === 'boolean' ? { fast: current.fast } : {}) }
    const other = kind === 'reasonable' ? lite : reasonable
    const fallbackOther = other?.profileId === profile.id ? other : fallback
    void write(kind === 'reasonable' ? next : fallbackOther, kind === 'lite' ? next : fallbackOther)
  }
  const locked = busy ? '正在保存…' : undefined
  const data = current => {
    const models = catalogRow?.value?.models ?? [], model = models.find(row => row.id === current?.model)
    return { ...(catalogRow?.value ?? config), profiles, currentProfile: profile, selectedProfileId: profile?.id, canChangeAgent: true, models,
      selection: { provider: model?.provider, model: current?.model, reasoningEffort: current?.reasoningEffort }, fast: current?.fast }
  }
  const modelRow = (kind, title, note, saved) => {
    const current = saved?.profileId === profile?.id ? saved : defaultCandidate(profile?.id, catalogRow?.value)
    return h('div', { className: 'kode-integration-row kode-team-role-row kode-execution-model-row', 'data-model-tier': kind },
      h('span', null, h('strong', null, title), h('span', { className: 'kode-config-note' }, note)),
      h('div', { className: 'kode-team-role-pickers' },
        catalogRow?.failure || catalogRow?.value?.modelError ? h('span', { className: 'kode-config-note', role: 'status', title: catalogRow.failure || catalogRow.value.modelError }, '模型不可用')
          : h(controls.ModelPicker, { data: data(current), busy: !catalogRow, lockedReason: locked, scopeKey: `execution-model:${team.id}:${profile?.id}:${kind}`, onSelect: patch => selectModel(kind, patch) })))
  }
  return h(React.Fragment, null,
    h('style', null, roleTargetStyles),
    h('div', { className: 'kode-settings-card kode-execution-settings-card' },
      h('div', { className: 'kode-integration-row kode-team-role-row', 'data-execution-agent': team.id },
        h('span', null, h('strong', null, '执行 Agent'), h('span', { className: 'kode-config-note' }, reasonable && !profile ? '已保存的 Agent 当前不可用，请重新选择。' : '团队新任务使用的执行环境；已有会话与授权不变。')),
        h('div', { className: 'kode-team-role-pickers' }, h(controls.AgentPicker, { data: data(reasonable), busy: !config, lockedReason: locked, scopeKey: `execution-agent:${team.id}`, onSelect: id => void selectAgent(id) }))),
      modelRow('reasonable', 'Reasonable 模型', '主力推理模型，负责规划、复杂设计与核心实现。', reasonable),
      modelRow('lite', 'Lite 模型', '轻量快速模型，负责日常问答、快速核查与整理。', lite)),
    message && h('p', { className: 'kode-config-note', role: 'status' }, message))
}

export const roleTargetStyles = `
.kode-execution-settings-card{min-width:0}
.kode-execution-model-row .kode-team-role-pickers{max-width:60%}
`
