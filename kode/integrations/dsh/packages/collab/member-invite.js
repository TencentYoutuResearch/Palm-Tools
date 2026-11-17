/** Explicit channel audience change; no team creation, activation or task dispatch. */
import {discussionKey, sameDiscussionScope} from './discussion-model.js'
export function eligibleChannelTeams(surface, teams) {
 if(surface?.kind!=='channel'||!surface.enabled)return []
 return teams.filter(t=>t.home_hub===surface.scope.home_hub&&!surface.team_ids.includes(t.id)&&
  t.spec?.workspace_refs?.some(w=>w.host_id===surface.scope.host_id&&w.workspace_id===surface.scope.workspace_id&&w.root_ref===surface.scope.root_ref))
}
export function inviteStorageKey(surface){return 'kode.collaboration.invite.v1:'+JSON.stringify([discussionKey(surface.scope),surface.id])}
export function createChannelInvite({surface,team,teams,requestId}){
 if(!eligibleChannelTeams(surface,teams).some(t=>t.id===team)||!requestId)throw Error('Team is not eligible for this channel')
 return {surface_id:surface.id,input:{request_id:requestId,expected_revision:surface.revision,scope:surface.scope,kind:surface.kind,title:surface.title,team_ids:[...surface.team_ids,team],enabled:surface.enabled}}
}
export function validateChannelInvite(pending,scope,surfaceId){
 const p=pending?.input
 if(pending?.surface_id!==surfaceId||!sameDiscussionScope(p?.scope,scope)||p.kind!=='channel'||!p.enabled||!Number.isSafeInteger(p.expected_revision)||!p.request_id||!Array.isArray(p.team_ids)||!p.team_ids.length)throw Error('Invalid invitation record')
 return pending
}
export function acceptChannelInvite(pending,result){
 validateChannelInvite(pending,result?.scope,result?.id)
 const input=pending.input
 if(result.revision!==input.expected_revision+1||result.title!==input.title||result.enabled!==input.enabled||result.kind!==input.kind||JSON.stringify(result.team_ids)!==JSON.stringify(input.team_ids))throw Error('Invitation receipt does not match')
 return result
}
