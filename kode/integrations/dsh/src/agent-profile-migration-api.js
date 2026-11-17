/** Owner-only carrier integration lives in agent-api. Previews are ephemeral;
 * confirmed changes use the existing private, revisioned preference store only.
 * No model discovery, process launch, session rebinding or shared-document write.
 */
import { planRegistryAgentProfileMigration, applyAgentProfileMigration, rollbackAgentProfileMigration } from './agent-profile-migration.js'
import { preferenceDigest, preferencePayload } from './local-agent-preferences.js'

const actions = new Set(['preview-agent-migration', 'confirm-agent-migration', 'preview-agent-migration-rollback', 'confirm-agent-migration-rollback'])
const conflict = message => Object.assign(Error(message), { statusCode: 409 })
const fields = (input, allowed) => {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw Error('Unknown migration request field')
}
const disclosure = Object.freeze({
  scope: 'local_host', eligibleForExecution: false,
  legacyProfilesUnchanged: true, existingSessionsUnchanged: true, defaultAgentUnchanged: true,
  canonicalUsage: 'ordinary_native_conversations_only', teamRoleExecution: 'unavailable',
  modelCatalog: 'native_cli_advertised_only_not_probed',
  ordinaryToolPermissions: 'not_verified_may_be_broader_than_managed_workflow',
  warnings: [
    '旧安全 profile、allowedModels、managedInference、已有会话和计量/取消状态保持不变。',
    '新 canonical Agent 仅供新建普通原生会话，不具备团队执行授权；角色与模型映射只是本机偏好，不能启动团队任务。',
    '普通 CLI 会话使用其原生工具权限和审批策略，不继承受控工作流的 Host 工具白名单、租约或计量约束，权限可能更广；本预览未探测实际工具权限。',
    '不会自动修改默认 Agent 或迁移旧会话；模型目录须后续由原生 CLI 提供，本次不启动 CLI、不验证模型可用性。',
    '仅写本机独立偏好文件，可回滚；有后续偏好变更时回滚将拒绝覆盖，已创建会话的身份快照不会删除。',
  ],
})
export function createAgentMigrationApi(profiles, { now = Date.now } = {}) {
  const previews = new Map()
  async function refresh() { await profiles.reload?.(); await profiles.localPreferences.open() }
  function remember(plan, kind, owner) {
    const key = `${owner}:${kind}:${plan.planHash}`
    for (const [id, entry] of previews) if (entry.expiresAt <= now()) previews.delete(id)
    while (previews.size >= 32) previews.delete(previews.keys().next().value)
    const expiresAt = now() + 10 * 60 * 1000
    previews.set(key, { plan: structuredClone(plan), expiresAt })
    return { migrationId: plan.id, planHash: plan.planHash, expectedRevision: plan.expectedRevision, expiresAt, ...disclosure }
  }
  return {
    handles: action => actions.has(action),
    clear: () => previews.clear(),
    async run(input, principal) {
      if (principal?.kind !== 'owner') throw Error('Host owner required')
      const owner = preferenceDigest(principal)
      if (!actions.has(input.action)) throw Error('Unknown migration operation')
      if (input.action === 'preview-agent-migration') {
        fields(input, ['action', 'recipe'])
        await refresh()
        const plan = planRegistryAgentProfileMigration(profiles, input.recipe)
        return { ...remember(plan, 'apply', owner), groups: input.recipe.groups.map(group => ({ profileId: group.id, sourceProfileIds: [...group.sourceProfileIds] })), archivedProfiles: (input.recipe.archiveProfileIds ?? []).map(id => ({ profileId: id, sourceProfileRevision: plan.sourceRevisions[id] })), teamRoles: plan.after.teamRoles }
      }
      if (input.action === 'preview-agent-migration-rollback') {
        fields(input, ['action', 'migrationId'])
        await refresh()
        const state = profiles.localPreferences.snapshot()
        const migration = Object.hasOwn(state.migrations, input.migrationId) && state.migrations[input.migrationId]
        if (!migration || migration.status !== 'applied') throw Error('Applied local Agent migration required')
        if (preferenceDigest(preferencePayload(state)) !== migration.afterHash) throw conflict('Local preferences changed; rollback would overwrite newer choices')
        const plan = { id: input.migrationId, expectedRevision: state.revision, appliedPlanHash: migration.planHash }
        plan.planHash = preferenceDigest({ ...plan, afterHash: migration.afterHash, action: 'rollback' })
        return remember(plan, 'rollback', owner)
      }
      fields(input, ['action', 'migrationId', 'planHash', 'expectedRevision', 'acknowledgeOrdinaryPermissions'])
      const kind = input.action === 'confirm-agent-migration' ? 'apply' : 'rollback'
      const entry = previews.get(`${owner}:${kind}:${input.planHash}`)
      if (!entry || entry.expiresAt <= now() || entry.plan.id !== input.migrationId || entry.plan.expectedRevision !== input.expectedRevision) throw conflict('Matching current migration preview required; preview again after expiry or Host restart')
      if (input.acknowledgeOrdinaryPermissions !== true) throw Error('Confirm the disclosed ordinary CLI permission differences first')
      await refresh()
      const state = profiles.localPreferences.snapshot()
      const prior = state.migrations[input.migrationId]
      if (kind === 'apply' && prior?.planHash === entry.plan.planHash) return { id: input.migrationId, status: prior.status, scope: 'local_host' }
      if (kind === 'rollback' && prior?.planHash === entry.plan.appliedPlanHash && prior.status === 'rolled_back') return { id: input.migrationId, status: prior.status, scope: 'local_host' }
      if (state.revision !== input.expectedRevision) throw conflict('Local preferences changed; prepare a new migration preview')
      try {
        if (kind === 'apply') return await applyAgentProfileMigration(profiles, entry.plan)
        if (state.migrations[input.migrationId]?.planHash !== entry.plan.appliedPlanHash) throw conflict('Applied migration changed')
        return await rollbackAgentProfileMigration(profiles, input.migrationId, input.expectedRevision)
      } catch (error) {
        if (/changed|newer choices|already used/.test(error.message)) error.statusCode = 409
        throw error
      }
    },
  }
}
