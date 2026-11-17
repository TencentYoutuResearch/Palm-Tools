/** Observation only. Never executes a CLI, reads credentials or expands Builder scope. */
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { profileRevision } from './agent-profiles.js'
import { managedNativeEnabled } from './managed-codex-profile.js'

export async function inspectExecutable(executable, pathValue = process.env.PATH ?? '') {
  if (typeof executable !== 'string' || !executable || /[\0\r\n]/.test(executable)) return { status: 'unknown', reason: 'invalid_executable' }
  // Relative executable paths need the actual execution cwd, which discovery does not guess.
  if (!isAbsolute(executable) && /[/\\]/.test(executable)) return { status: 'unknown', reason: 'execution_cwd_required' }
  const candidates = isAbsolute(executable) ? [executable] : pathValue.split(delimiter).filter(isAbsolute).slice(0, 128).map(dir => join(dir, executable))
  let inaccessible = false
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return { status: 'present', basis: 'filesystem_executable_check', trust_verified: false }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) inaccessible = true }
  }
  return { status: inaccessible ? 'unknown' : 'not_found', basis: 'filesystem_executable_check' }
}

export async function readBuilderRuntimeDiscovery(runtime, agent, draft, profileId) {
  const binding = runtime.profiles.binding(agent.id)
  if (runtime.closed || binding?.operationClosed || !binding?.managedBuilder || !binding.managedOperation || draft?.home_hub !== runtime.host || draft.status !== 'draft') throw Error('Builder discovery unavailable')
  const targets = draft.interview?.proposed_team?.execution_targets ?? []
  const permitted = profileId === binding.profile.id || targets.some(target => target.host_id === runtime.host && target.executor_profile_id === profileId)
  if (!permitted) throw Error('Profile outside Builder candidate scope')
  const profile = profileId === binding.profile.id ? structuredClone(binding.profile) : runtime.profiles.get(profileId)
  const revision = profileRevision(profile)
  const currentTargets = targets.filter(target => target.host_id === runtime.host && target.executor_profile_id === profileId)
  if (currentTargets.some(target => target.executor_profile_revision && target.executor_profile_revision !== revision)) throw Error('Candidate profile revision changed')
  const pathValue = profile.env?.PATH ?? process.env.PATH ?? ''
  const cli = profile.type === 'dsh' ? { status: 'not_applicable', basis: 'in_process_adapter' } : await inspectExecutable(profile.executable, pathValue)
  const bootstrap = profile.managedInference?.bootstrap
  const engine = bootstrap ? await inspectExecutable(bootstrap.executable, pathValue) : null
  const current = profileId === binding.profile.id ? runtime.profiles.binding(agent.id)?.profile : runtime.profiles.get(profileId)
  if (!current || profileRevision(current) !== revision || runtime.profiles.binding(agent.id)?.operationClosed) throw Error('Candidate profile changed during discovery')
  return { host_id: runtime.host, executor_profile_id: profile.id, executor_profile_revision: revision,
    observed_at: new Date().toISOString(), cli, ...(engine ? { bootstrap_engine: engine } : {}),
    catalog: { source: 'owner_profile_configuration', status: 'configured_only', models: [...new Set(profile.allowedModels ?? (profile.defaultModel ? [profile.defaultModel] : []))], live_directory_checked: false },
    managed_roles: profile.type === 'dsh' ? ['builder', 'coordinator', 'worker'] : managedNativeEnabled(profile) ? [...(profile.managedInference.roles ?? ['worker'])] : [],
    authentication: { status: 'unknown', checked: false }, inference: { status: 'not_tested' },
    eligible_for_execution: false,
    next_steps: ['Owner may query the registered adapter model catalog; configuration entries are not availability proof.', 'Before execution, exact model/profile preflight, grants, budget and role capability assessment remain required.', 'Any live inference test needs its own admitted operation; discovery does not install, log in, create credentials or execute a CLI.'],
  }
}
