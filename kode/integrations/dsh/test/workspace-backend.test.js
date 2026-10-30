import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Backend from '../src/workspace-backend.js'
import Registry from '../src/workspace-registry.js'
import {BackendClient} from '../src/backend-client.js'
const url=process.env.KODE_TEST_BACKEND_URL,tokenFile=process.env.KODE_TEST_TOKEN_FILE
test('workspace registry uses only Kode backend, retains ids on reload and never makes a default',{skip:!url||!tokenFile},async()=>{
 const client=new BackendClient(url,(await readFile(tokenFile,'utf8')).trim()),root=await mkdtemp(join(tmpdir(),'kode-workspace-contract-'))
 async function host(){const ctx=new Context(),fibers=[];fibers.push(await ctx.plugin(Storage));ctx.provide('kodeBackend',client);ctx.provide('sessionPersistence',{list:async()=>[]});fibers.push(await ctx.plugin(Backend));fibers.push(await ctx.plugin(Domain,{backend:'kode-workspaces'}));fibers.push(await ctx.plugin(Registry));return{ctx,close:async()=>{for(const fiber of fibers.reverse())await fiber.dispose()}}}
 let h=await host(),ctx=h.ctx
 try{
  assert.equal(await ctx.workspaceRegistry.initializeDefault(()=>{throw Error('must not create a dsh directory')}),undefined)
  const workspace=await ctx.workspaceRegistry.create(root,'Shared project'),id=workspace.id
  assert.ok((await client.call('/api/v1/messaging/workbench/workspaces')).workspaces.some(row=>row.id===id&&row.title==='Shared project'))
  await workspace.setTitle('Renamed in dsh')
  await h.close();h=await host();ctx=h.ctx
  assert.equal(ctx.workspaceRegistry.get(id).title,'Renamed in dsh')
  await ctx.workspaceRegistry.delete(id)
  assert.equal(await ctx.workspaceRegistry.initializeDefault(()=>{throw Error('default must stay disabled')}),undefined)
  assert.ok(!(await client.call('/api/v1/messaging/workbench/workspaces')).workspaces.some(row=>row.id===id))
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
