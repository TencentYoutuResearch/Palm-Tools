import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkRunController } from '../src/work-run-controller.js'
import { WorkRunService } from '../src/work-run-service.js'
test('bounded service rotates distinct teams and their parallel remote-waiting branches', async () => {
const dir = await mkdtemp(join(tmpdir(), 'kode-fairness-evidence-'))
const reads = []
const runs = ['a','b'].map(id => ({id, team_id: `team-${id}`, home_hub:'home', revision:1, state:'running', context:{binding:{workflow:{pack:{}}}}, stages:['one','two'].map(stage => ({stage_id:stage, assignment_id:`${id}-${stage}`,state:'ready'}))}))
const runtime = {host:'home',profiles:{path:join(dir,'profiles.json')},client:{async call(path) {
  if(path.includes('/active')) { const after = new URL(path,'http://fixture.invalid').searchParams.get('after'); return {items:runs.filter(row=>!after || row.id>after),next_cursor:null} }
  const id=path.split('/').at(-1)
  if(path.includes('/work-runs/')) return structuredClone(runs.find(row=>row.id===id))
  reads.push(id)
  return {id, state:'prepared', worker:{node_id:'remote',session_id:id},resources:{state:'held'}}
}}}
const controller = new WorkRunController({host:{execution:runtime,stop:new AbortController(),handles:new Map()}},{prepare(){throw Error('Unexpected local preparation')}})
const service = await new WorkRunService(controller,{maxWatches:1,intervalMs:100}).open()
try {
 for(let i=0;i<40;i++){await service.scan(); await delay(10)}
 assert.ok(reads.includes('a-one') && reads.includes('a-two'),'actual controller rotates branches')
 assert.ok(reads.includes('b-one') && reads.includes('b-two'), 'second team and both parallel branches must progress')

} finally {await service.close(); await rm(dir,{recursive:true,force:true})}

})
