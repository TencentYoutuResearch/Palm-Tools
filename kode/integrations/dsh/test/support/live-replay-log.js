/** Child test output can contain model text or rich SDK errors. Keep only explicit replay metadata. */
export function selectiveReplayLog(stdout) {
 const rows=[]
 for(const line of String(stdout).split('\n')){
  const index=line.indexOf('{');if(index<0)continue
  let row;try{row=JSON.parse(line.slice(index))}catch{continue}
  if(row.live_replay_baseline){const r=row.live_replay_baseline;rows.push({live_replay_baseline:{feature_commit:r.feature_commit,source_commit:r.source_commit,scope:r.scope,baseline_acceptance_passed:r.baseline_acceptance_passed===true}})}
  if(row.live_evidence){const r=row.live_evidence;rows.push({live_evidence:{saved:r.saved===true,phase:r.phase,file:r.file,warning_count:r.warning_count}})}
  if(row.managed_decision_summary){const r=row.managed_decision_summary;rows.push({managed_decision_summary:{stage:r.stage,decisions:r.decisions,terminal_peer_closes:r.terminal_peer_closes}})}
  if(row.live_replay_retained_hub){const r=row.live_replay_retained_hub;rows.push({live_replay_retained_hub:{node:r.node,scope:r.scope,business_teams_touched:false}})}
 }
 return rows.map(row=>JSON.stringify(row)).join('\n')+'\n'
}
export function replayProcessFailure(error) {
 const safe=new Error('Historical live replay did not pass; inspect selective evidence for the original stage failure.')
 safe.name='LiveReplayProcessError';safe.code=Number.isSafeInteger(error?.code)?error.code:null
 safe.signal=['SIGTERM','SIGKILL','SIGINT'].includes(error?.signal)?error.signal:null
 return safe
}
