import {nativeInteractiveTeamBinding,INTERACTIVE_TEAM_RECORD} from './native-interactive-team.js'
/** A deny-only boundary. Journal markers never authorize scope execution. */
import {nativePlanningBinding,NATIVE_PLANNING_RECORD} from './native-planning-session.js'
import {nativeCoordinatorBinding,isNativeCoordinatorId} from './native-coordinator-scope.js'
import {SCOPED_COORDINATOR_JOURNAL_RECORD} from './scoped-coordinator-journal.js'
export function requiresDedicatedHostAdmission(agent){
  return Boolean(nativeInteractiveTeamBinding(agent)||nativePlanningBinding(agent)||nativeCoordinatorBinding(agent)||isNativeCoordinatorId(agent.id)
    ||agent.session?.snapshotEvents?.().some(event=>event.type===INTERACTIVE_TEAM_RECORD||event.type===NATIVE_PLANNING_RECORD||event.type===SCOPED_COORDINATOR_JOURNAL_RECORD))
}
export function ordinaryHostInstall(agent,install){
  if(requiresDedicatedHostAdmission(agent))return Promise.resolve()
  return install()
}
