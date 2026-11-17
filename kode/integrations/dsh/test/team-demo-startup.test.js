import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,readFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {seedTeamDemoAtStartup,runTeamDemoStartup} from '../src/team-demo-startup.js'
const fresh = () => ({enabled:true,expectedNodeId:'fixture-home',seedKey:'walkthrough-v1',workspacePath:join(tmpdir(),'kode-team-demo-'+randomUUID())})

test('startup default is disabled, including truthy strings, with no client access',async()=>{
  const client={call:()=>{throw Error('must not access client')}}
  for(const config of [undefined,{}, {enabled:false},{enabled:'true'}])assert.equal(await seedTeamDemoAtStartup(client,config),null)
})

test('startup requires fixed explicit scope and rejects wrong Hub before creating files',async()=>{
  const config=fresh(), client={url:'http://127.0.0.1:48984',call:async()=>({node_id:'wrong'})}
  await assert.rejects(seedTeamDemoAtStartup(client,config),/identity mismatch/)
  await assert.rejects(access(config.workspacePath),{code:'ENOENT'})
  for(const change of [{seedKey:undefined},{workspacePath:'/real/project'},{unexpected:true},{expectedNodeId:undefined}])await assert.rejects(seedTeamDemoAtStartup(client,{...config,...change}),/Explicit demo/)
})

test('startup refuses existing unmarked directories without writes to Hub',async()=>{
  const config=fresh(),calls=[]
  await mkdir(config.workspacePath)
  try {
    await assert.rejects(seedTeamDemoAtStartup({url:'http://127.0.0.1:48984',call:async(path,body)=>{calls.push({path,body});return {node_id:'fixture-home'}}},config))
    assert.ok(calls.every(c=>c.body===undefined));await assert.rejects(access(join(config.workspacePath,'.kode-team-demo.json')),{code:'ENOENT'})
  }finally{await rm(config.workspacePath,{recursive:true,force:true})}
})

test('startup passes existing client to seeder; marker permits retry without credential access',async()=>{
  const config=fresh(),calls=[]
  const client={url:'http://127.0.0.1:48984',call:async(path,body)=>{
    calls.push({path,body})
    if(path.endsWith('/node'))return {node_id:'fixture-home'}
    throw Error('fixture stop before first Hub mutation')
  }}
  try {
    for(let i=0;i<2;i++)await assert.rejects(seedTeamDemoAtStartup(client,config),/fixture stop/)
    const marker=JSON.parse(await readFile(join(config.workspacePath,'.kode-team-demo.json'),'utf8'))
    assert.equal(marker.expectedNodeId,config.expectedNodeId);assert.equal(marker.seedKey,config.seedKey)
    assert.ok(calls.every(c=>c.body===undefined))
    await assert.rejects(seedTeamDemoAtStartup(client,{...config,seedKey:'different'}),/not this demo scope/)
  }finally{await rm(config.workspacePath,{recursive:true,force:true})}
})

test('Host startup hook is opt-in and reuses authenticated admin',async()=>{
  const source=await readFile(new URL('../src/host.js',import.meta.url),'utf8')
  assert.ok(source.includes('if (runtimeConfig.teamDemo?.enabled === true)'))
  assert.ok(source.includes('await runTeamDemoStartup(admin, runtimeConfig.teamDemo)'))
  assert.ok(source.includes('ordinary Host startup continues.'))
})

test('optional startup failure is local and never exposes caught errors',async()=>{
  const config=fresh()
  const result=await runTeamDemoStartup({url:'http://127.0.0.1:48984',call:async()=>{throw Error('secret backend response')}},config)
  assert.deepEqual(result,{status:'blocked',code:'DEMO_STARTUP_FAILED'})
  assert.equal(JSON.stringify(result).includes('secret'),false)
  assert.deepEqual(await runTeamDemoStartup({},undefined),{status:'disabled'})
})
