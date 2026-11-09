/** Persist a selected plan before any funded start. Retries never rerank a committed intent. */
import { isDeepStrictEqual } from 'node:util'
import { normalizeCoordinatorPlanInput } from './coordinator-start-plan.js'
export async function startPlannedCoordinator(host, input) {
  input = normalizeCoordinatorPlanInput(input)
  host.stop.signal.throwIfAborted()
  const key = JSON.stringify([host.execution.host,input.team_id,input.request_id])
  const pending = host.coordinatorPlanStarts.get(key)
  if (pending) {
    if (!isDeepStrictEqual(pending.input,input)) throw Error('Coordinator planned start identity conflict')
    return pending.task
  }
  const task = perform(host,key,input)
  host.coordinatorPlanStarts.set(key,{input,task})
  try { return await task } finally {
    if (host.coordinatorPlanStarts.get(key)?.task === task) host.coordinatorPlanStarts.delete(key)
  }
}
async function perform(host,key,input) {
  const profiles = host.execution.profiles
  const check = row => {
    if (row && (!isDeepStrictEqual(row.input,input) || row.home_hub !== host.execution.host)) throw Error('Coordinator planned start identity conflict')
    return row
  }
  let saved = check(profiles.coordinatorStartPlans[key])
  if (!saved) {
    const plan = await host.planCoordinatorStart(input)
    // Recheck inside the existing fsync-backed profile transaction. No external
    // effect precedes this save; a failed/ambiguous save must not trigger startup.
    saved = await profiles.update(state => {
      host.stop.signal.throwIfAborted()
      const prior = check(state.coordinatorStartPlans[key])
      if (prior) return prior
      const row = { home_hub:host.execution.host, input, command:plan.command, created_at:Date.now() }
      Object.defineProperty(state.coordinatorStartPlans,key,{value:row,enumerable:true,writable:true,configurable:true})
      return row
    })
  }
  host.stop.signal.throwIfAborted()
  return host.startCoordinator(structuredClone(saved.command))
}
