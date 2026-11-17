/** Real disposable Hub. Fresh credentials only; never the live DSH instance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {BackendClient} from '../src/backend-client.js'
import {prepareTeamDemo,seedTeamDemoScope} from '../src/team-demo-fixture.js'
import {runTeamDemoStartup} from '../src/team-demo-startup.js'

test('real temporary Hub accepts draft Teams, projects and discussions without activation or execution', {skip:!process.env.KODE_TEST_HUB_BIN,timeout:30000},async()=>{
  const handle=await prepareTeamDemo(),startupPath=join(tmpdir(),'kode-team-demo-'+randomUUID())
  let child
  try {
    child=spawn(process.env.KODE_TEST_HUB_BIN,['--config',handle.configPath,'--token-file',handle.tokenFile,'--bind','127.0.0.1:0'],{env:{...process.env,...handle.environment},stdio:['ignore','pipe','pipe']})
    const address=await new Promise((resolve,reject)=>{
      let output=''
      const timer=setTimeout(()=>reject(Error('Disposable Hub startup timeout')),10000)
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('exit',()=>{clearTimeout(timer);reject(Error('Disposable Hub exited before ready'))})
      child.stdout.on('data',bytes=>{output+=bytes;const match=output.match(/kode-session-server [a-zA-Z0-9_-]+ (127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}})
    })
    assert.ok(!['48984','58984'].includes(address.split(':')[1]))
    const client=new BackendClient('http://'+address,(await readFile(handle.tokenFile,'utf8')).trim())
    const options={expectedNodeId:handle.node,workspacePath:handle.workspacePath,seedKey:'integration-v1'}
    const seeded=await seedTeamDemoScope(client,options)
    assert.equal(seeded.teams.length,3)
    for(const team of seeded.teams){
      assert.equal(team.status,'draft');assert.equal(team.eligible_for_execution,false)
      assert.ok(team.superagent_id&&team.conversation_id)
      assert.deepEqual(team.spec.execution_targets,[])
      await assert.rejects(client.call(`/api/v1/messaging/teams/${team.id}/activation`),{status:404})
      const runs=await client.call(`/api/v1/messaging/teams/${team.id}/work-runs?limit=25`)
      assert.deepEqual(runs.items,[])
    }
    const contacts=await client.call('/api/v1/messaging/contact-directory?'+new URLSearchParams({workspace_host:handle.node,workspace_id:seeded.workspace.id,workspace_root:seeded.scope.root_ref}))
    assert.equal(contacts.items.length,3)
    assert.deepEqual(contacts.items.map(t=>t.id).sort(),seeded.teams.map(t=>t.id).sort())
    assert.ok(contacts.items.every(t=>t.status==='draft' && t.spec.name.startsWith('【演示】')))
    const surfaces=await client.call('/api/v1/messaging/collaboration/surfaces?'+new URLSearchParams(seeded.scope))
    assert.deepEqual(surfaces.items.map(s=>s.id).sort(),seeded.surfaceIds.slice().sort())
    assert.ok(surfaces.items.every(s=>s.team_ids.every(id=>seeded.teams.some(t=>t.id===id))))
    const snapshot=()=>{
      const db=new DatabaseSync(join(handle.root,'ledger.sqlite'),{readOnly:true})
      try{return Object.fromEntries(['teams','team_revisions','collaboration_surfaces','collaboration_messages'].map(table=>[table,db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))}finally{db.close()}
    }
    const before=snapshot();assert.deepEqual(before,{teams:3,team_revisions:3,collaboration_surfaces:3,collaboration_messages:3})
    await seedTeamDemoScope(client,options);assert.deepEqual(snapshot(),before)
    const config={enabled:true,expectedNodeId:handle.node,workspacePath:startupPath,seedKey:'startup-v1'}
    assert.equal((await runTeamDemoStartup(client,config)).status,'ready')
    const after=snapshot();assert.deepEqual(after,{teams:6,team_revisions:6,collaboration_surfaces:6,collaboration_messages:6})
    assert.equal((await runTeamDemoStartup(client,config)).status,'ready');assert.deepEqual(snapshot(),after)
    assert.deepEqual(await runTeamDemoStartup(client,{...config,expectedNodeId:'wrong-home'}),{status:'blocked',code:'DEMO_STARTUP_FAILED'})
    assert.equal((await client.call('/api/v1/messaging/node')).node_id,handle.node)
    assert.deepEqual(snapshot(),after)
    const db=new DatabaseSync(join(handle.root,'ledger.sqlite'),{readOnly:true})
    try {
      for(const table of ['work_runs','work_assignments','resource_accounts','resource_bindings','budgets'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workbench_documents WHERE key LIKE 'team-activation:%' OR key LIKE 'team-grant:%'").get().n,0)
    }finally{db.close()}
    console.log('Real Hub verified: 3 scoped contacts; 6 draft Teams across two demo scopes; 6 stored messages; repeat counts unchanged; failure isolated; no activation, WorkRuns, assignments, resource accounts/bindings or budgets; actual scoped contact and surfaces queries verified.')
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGINT');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited}finally{clearTimeout(timer)}}
    await rm(handle.root,{recursive:true,force:true});await rm(startupPath,{recursive:true,force:true})
  }
})
