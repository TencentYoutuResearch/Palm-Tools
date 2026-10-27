import test from 'node:test'
import assert from 'node:assert/strict'
import { KodeWorkspaceBackend } from '../src/workspace-backend.js'

test('workspace writes retry CAS conflicts without losing concurrent membership or metadata',async()=>{
  let value={version:2,tables:{workspaces:{project:{path:'/srv/project',title:'Project',sessionIds:[]}}},global:{initialized:true,workspaceIds:['project'],archivedSessionIds:[],pinnedSessionIds:[]}},revision=1,conflict=true
  const initial=structuredClone(value)
  const client={call:async(_path,update)=>{
    if(update){
      if(conflict){conflict=false;value.tables.workspaces.project.title='Renamed elsewhere';value.tables.workspaces.project.sessionIds.push('remote-session');value.global.pinnedSessionIds.push('remote-session');revision++;throw new Error('configuration changed; reload before saving')}
      assert.equal(update.expected_revision,revision);value=structuredClone(update.value);revision++
    }
    return{value:structuredClone(value),revision}
  }}
  const backend=new KodeWorkspaceBackend(client),unit=await backend.kv.open({name:'workspace',version:2,tables:['workspaces']})
  await unit.putRecord('workspaces','project',{...initial.tables.workspaces.project,sessionIds:['local-session']})
  assert.equal(value.tables.workspaces.project.title,'Renamed elsewhere')
  assert.deepEqual(new Set(value.tables.workspaces.project.sessionIds),new Set(['local-session','remote-session']))
  await Promise.all([
    unit.putRecord('workspaces','project',{...initial.tables.workspaces.project,sessionIds:['second-local','local-session']}),
    unit.setGlobal({...initial.global,pinnedSessionIds:['local-session']}),
  ])
  assert.deepEqual(new Set(value.tables.workspaces.project.sessionIds),new Set(['second-local','local-session','remote-session']))
  assert.deepEqual(new Set(value.global.pinnedSessionIds),new Set(['local-session','remote-session']))
  await backend.close()
})
