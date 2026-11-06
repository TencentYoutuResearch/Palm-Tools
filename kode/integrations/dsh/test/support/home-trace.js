/** Actual Home/owner HTTP trace + production export collector, with no executor access. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { registerWorkRunTrace } from '../../src/work-run-trace-route.js'
import { TRACE_VIEWS,readTraceManifest,readTraceSlice,exportTracePart } from '../../packages/collab/trace-data.js'
export async function verifyHomeTrace(hub,run,peerClient,{suffix='local',searchTool='kode_write_source'}={}) {
  let route,mutations=0
  const client={call:async(path,body)=>{if(body!==undefined)mutations++;return hub.client.call(path,body)}}
  registerWorkRunTrace({webServer:{register:r=>{route=r}},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:req.headers['x-fixture-owner']==='agent'?{peer:{principal:{kind:'agent'}}}:{rejection:401}}},{backendClient:client,quotaHost:hub.node})
  const server=createServer((req,res)=>{void route.handler(req,res)})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const origin=`http://127.0.0.1:${server.address().port}`
  try {
    const url='/api/kode/work-run/trace?'+new URLSearchParams({run_id:run.id,team_id:run.team_id,view:'manifest'})
    assert.equal((await fetch(origin+url)).status,401)
    assert.equal((await fetch(origin+url,{headers:{'x-fixture-owner':'agent'}})).status,403)
    assert.equal((await fetch(origin+url,{method:'POST',headers:{'x-fixture-owner':'yes'}})).status,405)
    if(peerClient)await assert.rejects(peerClient.call(`/api/v1/messaging/work-runs/${run.id}/trace?view=manifest`),/403/)
    const request=async(path,{signal}={})=>{const response=await fetch(origin+path,{signal,headers:{'x-fixture-owner':'yes'}});if(!response.ok)throw Error('Home trace rejected '+response.status);return response.json()}
    const manifest=await readTraceManifest({run,request})
    assert.equal(manifest.retention.mode,'home_persistent_no_automatic_expiry')
    assert.equal(manifest.retention.raw_tool_payloads,'execution_session_only')
    const records=Object.fromEntries(TRACE_VIEWS.map(view=>[view,[]]));let continuation,parts=[]
    do {
      const result=await exportTracePart({run,request,continuation,maxRecords:17,uuid:()=> 'native-trace-'+suffix})
      for(const [view,rows]of Object.entries(result.document.records))records[view].push(...rows)
      parts.push(result.document);continuation=result.continuation;assert.ok(parts.length<200)
    }while(continuation)
    for(const stream of manifest.streams){assert.equal(records[stream.view].length,stream.count,stream.view);assert.equal(new Set(records[stream.view].map(row=>row.cursor)).size,stream.count,stream.view)}
    const workerAssignments=records.assignments.map(row=>row.data.id)
    assert.ok(run.stages.every(stage=>workerAssignments.includes(stage.assignment_id)))
    const tools=records.operation_events.filter(row=>row.data.kind==='tool_evidence')
    assert.ok(tools.length>0)
    for(const row of tools){assert.match(row.data.evidence.io.input.sha256,/^[a-f0-9]{64}$/);assert.ok(row.data.evidence.io.output,JSON.stringify({tool:row.data.evidence.tool,status:row.data.evidence.status,call_id:row.data.evidence.call_id}));assert.match(row.data.evidence.io.output.sha256,/^[a-f0-9]{64}$/)}
    assert.ok(records.model_calls.length>0);assert.equal(manifest.prompt_attestation.calls,records.model_calls.length)
    assert.equal(manifest.prompt_attestation.missing,records.model_calls.filter(row=>!row.data.request.prompt_provenance?.instruction).length)
    assert.equal(manifest.prompt_attestation.missing,0,'all current native calls must attest actual versioned instructions')
    for(const row of records.model_calls){const proof=row.data.request.prompt_provenance;assert.equal(proof.source,'official_prepared_input');assert.match(proof.system_sha256,/^[a-f0-9]{64}$/);assert.ok(['worker','coordinator'].includes(proof.instruction.role))}
    assert.ok(records.messages.length>0);assert.ok(records.communication_events.length>0)
    for(const stage of run.stages)for(const sequence of Object.values(stage.evidence?.outputs??{})){
      const output=records.operation_events.find(row=>row.cursor===sequence&&row.data.kind==='artifact_evidence')
      assert.ok(output,'every selected output must resolve to its actual operation evidence')
      const kind=output.data.evidence.payload.kind
      if(kind==='artifact')assert.ok(records.archives.some(row=>row.data.sequence===sequence&&row.data.availability==='home_archived'))
      if(kind==='verification')assert.ok(records.verification_archives.some(row=>row.data.sequence===sequence&&row.data.availability==='home_archived'))
    }
    let cursor,matched=[]
    do{const page=await readTraceSlice({run,manifest,view:'operation_events',q:searchTool,cursor,request});matched.push(...page.items);cursor=page.next_cursor}while(cursor)
    assert.ok(matched.some(row=>row.data.evidence?.tool===searchTool))
    assert.equal(mutations,0);assert.deepEqual(await hub.client.call(`/api/v1/messaging/work-runs/${run.id}`),run)
    await writeFile(`/tmp/superagent-home-trace-574-${suffix}.json`,JSON.stringify({parts}))
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
