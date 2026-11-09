/** Public metadata proposal only; no selection write, account binding, grant or dispatch. */
import { controlledBinding, managedCodexEnabled, managedCodexRoute } from './managed-codex-profile.js'
export async function proposeBuilderDefaults({ draft, profiles, defaultProfileId, providers, configured = {}, listModels, resolveModelInfo }) {
 const needs = fields => ({ state: 'needs_configuration', fields, eligible_for_execution: false })
 const available = profiles.filter(profile => controlledBinding({ profile, managedBuilder: {} }) && profile.runtime_available === true)
 const chosenProfile = configured.profile_id ?? defaultProfileId
 const profile = chosenProfile ? available.find(row => row.id === chosenProfile) : available.length === 1 ? available[0] : null
 if (!profile) return needs(['execution_profile'])
 const native = managedCodexEnabled(profile)
 const routes = providers.filter(row => row.registered === true && !row.provider_id.startsWith('kode-agent-')
  && (native ? row.provider_id === managedCodexRoute(profile.id) : !row.provider_id.startsWith('kode-workflow-')))
 const provider = configured.provider ? routes.find(row => row.provider_id === configured.provider) : routes.length === 1 ? routes[0] : null
 if (!provider) return needs(['provider'])
 const workspaces = draft.interview.workspace_refs.filter(row => row.host_id === draft.home_hub)
 const workspace = configured.workspace_id ? workspaces.find(row => row.workspace_id === configured.workspace_id) : workspaces.length === 1 ? workspaces[0] : null
 if (!workspace) return needs(['workspace'])
 const catalog = await listModels(provider.provider_id)
 if (!Array.isArray(catalog) || catalog.length > 2000 || catalog.some(row => row.provider !== provider.provider_id || typeof row.id !== 'string' || !row.id) || new Set(catalog.map(row => row.id)).size !== catalog.length) throw Error('Invalid model metadata')
 const allowed = profile.allowedModels ? catalog.filter(row => profile.allowedModels.includes(row.id)) : catalog
 const requested = configured.model ?? profile.defaultModel
 const model = requested ? allowed.find(row => row.id === requested) : allowed.length === 1 ? allowed[0] : null
 if (!model) return needs(['model'])
 const metadata = await resolveModelInfo(provider.provider_id, model.id)
 if (metadata?.provider !== provider.provider_id || metadata.id !== model.id) throw Error('Wrong model identity')
 const effort = configured.effort !== undefined ? configured.effort : profile.defaultReasoningEffort ?? null
 if (effort !== null && !metadata.reasoning?.efforts?.some(row => row.id === effort)) return needs(['effort'])
 return { state: 'proposed', draft_id: draft.id, draft_revision: draft.revision, home_hub: draft.home_hub,
  selection: { profile_id: profile.id, provider: provider.provider_id, model: model.id, effort, workspace },
  basis: { profile: chosenProfile ? 'configured' : 'only_available', provider: configured.provider ? 'configured' : 'only_available', model: requested ? 'configured' : 'only_allowed' }, eligible_for_execution: false }
}
