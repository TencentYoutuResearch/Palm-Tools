import { registerBuilderClose } from '../../src/builder-close-route.js'
import { registerBuilderAccounting } from '../../src/builder-accounting-route.js'
import { registerBuilderStart } from '../../src/builder-start-route.js'
import { registerBuilderInput } from '../../src/builder-input-route.js'
/** Real owner HTTP surfaces used by creation-to-execution fixtures. No daily service. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerTeamBudget } from '../../src/team-budget-route.js'
import { registerTeamResource } from '../../src/team-resource-route.js'
import { registerTeamAuthority } from '../../src/team-authority-route.js'
import { registerTeamActivation } from '../../src/team-activation-route.js'
import { registerVerificationDefinition } from '../../src/verification-definition-route.js'
import { registerBuilderWorkflowSetup } from '../../src/builder-workflow-setup.js'
import { registerBuilderAccept } from '../../src/builder-accept-route.js'
export async function teamOwnerHttp(ctx,client){
 const routes=new Map(),adapter={get:name=>ctx.get(name),webServer:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path)}},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}}
 for(const register of [registerBuilderClose,registerBuilderAccounting,registerTeamBudget,registerTeamResource,registerTeamAuthority,registerTeamActivation,registerVerificationDefinition,registerBuilderWorkflowSetup,registerBuilderAccept,registerBuilderStart,registerBuilderInput])register(adapter,{backendClient:client})
 const server=createServer((req,res)=>{const route=routes.get(new URL(req.url,'http://fixture.invalid').pathname);if(!route){res.writeHead(404);res.end();return}void route.handler(req,res)})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const request=async(method,path,{body,owner=true}={})=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/kode/${path}`,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(owner?{'x-fixture-owner':'yes'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  return {status:response.status,body:await response.json(),headers:response.headers}
 }
 return {request,async post(path,body){
  const result=await request('POST',path,{body});assert.equal(result.status,200,JSON.stringify({path,result:result.body}));return result.body
 },async get(path,owner=true){return request('GET',path,{owner})},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
