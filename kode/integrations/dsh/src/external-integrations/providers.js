/** Read-only API adapters. No token is accepted from the browser or persisted here.
 * Schemas must be validated against each real instance before enabling production use.
 */
import {source,objectKey,safeLink,text,field,scope} from './identity.js'
const allowed={tapd:['story','bug','task','comment'],gongfeng:['issue','change_request','comment'],github:['issue','change_request'],gitlab:['issue','change_request'],gitea:['issue','change_request']}
// Public TAPD REST contract reviewed 2026-11-10; internal kinds stay singular.
// No legacy singular aliases or bug_remark expansion without a verified contract.
const tapdEntryType={story:'stories',task:'tasks',bug:'bug'}
function record(src,kind,row,parent,approvedLinkOrigins){
 if(!row||typeof row!=='object'||Array.isArray(row))throw Error('Invalid provider row')
 // GitHub's issue-envelope ID and pull-request ID differ for the same PR.
 // Repository-local issue/PR number is the common stable identity on both APIs.
 const githubNumber=src.provider==='github'&&['issue','change_request'].includes(kind)
 if(githubNumber&&(!Number.isSafeInteger(row.number)||row.number<1))throw Error('Invalid GitHub resource number')
 const rid=field(String((githubNumber?row.number:row.id)??''),'provider object id',256)
 const parentKey=parent?objectKey(src,parent.kind,parent.id):null
 const author=src.provider==='tapd'&&['story','task'].includes(kind)?row.creator:
  (typeof row.author==='string'?row.author:(row.author?.name??row.author?.login??row.author?.username??''))
 return {key:objectKey(src,kind,rid),source:source(src),kind,id:rid,parent_key:parentKey,
  title:text(row.title??row.name??'',2048),body:text(row.body??row.description??''),native_state:text(row.state??row.status??'',256),
  author:text(author,512),
  url:safeLink(row.web_url??row.html_url??row.url,src,approvedLinkOrigins),updated_at:text(row.updated_at??row.modified??'',128),
  origin:'external',trusted_instruction:false,dispatch:'disabled'}
}
export function normalizeResponse(src,kind,payload,{parent,approvedLinkOrigins=[]}={}){
 src=source(src)
 if(!allowed[src.provider]?.includes(kind))throw Error('Unsupported resource capability')
 if(kind!=='comment'&&parent!=null)throw Error('Only comments accept a parent')
 if(kind==='comment'&&(!parent||!allowed[src.provider].includes(parent.kind)||parent.kind==='comment'))throw Error('Comment requires an explicit supported parent')
 let rows
 if(src.provider==='tapd'){
  if(payload?.status!==1||!Array.isArray(payload.data))throw Error('TAPD response not successful')
  const wrapper={story:'Story',bug:'Bug',task:'Task',comment:'Comment'}[kind]
  rows=payload.data.map(x=>{const r=x?.[wrapper];if(!r||String(r.workspace_id)!==src.resource)throw Error('TAPD project mismatch');if(kind==='comment'&&(String(r.entry_id)!==String(parent.id)||r.entry_type!==tapdEntryType[parent.kind]))throw Error('Comment parent mismatch');return r})
 }else{
  if(!Array.isArray(payload))throw Error('Expected provider list response')
  rows=payload
 }
 if(rows.length>100)throw Error('Page exceeds configured limit')
 return rows.map(row=>{
  // GitHub issues API includes pull requests. Do not relabel them as issues.
  const actual=src.provider==='github'&&kind==='issue'&&row.pull_request?'change_request':kind
  if(src.provider!=='tapd'&&row.project_id!=null&&String(row.project_id)!==src.resource)throw Error('Repository mismatch')
  if(kind==='comment'&&row.noteable_id!=null&&String(row.noteable_id)!==String(parent.id))throw Error('Comment parent mismatch')
  return record(src,actual,row,parent,approvedLinkOrigins)
 })
}
function request(src,kind,{page=1,parent}={}){
 if(!Number.isInteger(page)||page<1||page>100)throw Error('Invalid page')
 if(!allowed[src.provider]?.includes(kind))throw Error('Unsupported resource capability')
 if(kind!=='comment'&&parent!=null)throw Error('Only comments accept a parent')
 const r=encodeURIComponent(src.resource),p=new URLSearchParams()
 if(src.provider==='tapd'){
  p.set('workspace_id',src.resource);p.set('page',String(page));p.set('limit','100')
  if(kind==='comment'){if(!parent||!['story','bug','task'].includes(parent.kind))throw Error('Comment requires parent');p.set('entry_type',tapdEntryType[parent.kind]);p.set('entry_id',field(String(parent.id),'parent id'))}
  return '/'+({story:'stories',bug:'bugs',task:'tasks',comment:'comments'}[kind])+'?'+p
 }
 p.set('page',String(page));p.set('per_page','100')
 let path
 if(src.provider==='gongfeng'||src.provider==='gitlab'){
  const version=src.provider==='gongfeng'?'v3':'v4'
  if(kind==='comment'){
   if(!parent||!['issue','change_request'].includes(parent.kind))throw Error('Comment requires parent')
   // Notes route is an explicit capability, not inferred from GitLab similarity.
   path=`/api/${version}/projects/${r}/${parent.kind==='issue'?'issues':'merge_requests'}/${encodeURIComponent(field(String(parent.id),'parent id'))}/notes`
  }else path=`/api/${version}/projects/${r}/${kind==='issue'?'issues':'merge_requests'}`
 }else{
  const parts=src.resource.split('/');if(parts.length!==2||parts.some(x=>!x||x==='.'||x==='..'))throw Error('Expected owner/repository')
  path=(src.provider==='gitea'?'/api/v1':'')+'/repos/'+parts.map(encodeURIComponent).join('/')+'/'+(kind==='issue'?'issues':'pulls')
 }
 return path+'?'+p
}
export class ReadonlyProvider {
 #capabilities
 constructor({source:src,readJson,capabilities=[],authorizationRevision,instanceValidated=false,approvedLinkOrigins=[],allowedScopes}){
  if(allowedScopes)this.allowedScopes=Object.freeze(allowedScopes.map(value=>Object.freeze(scope(value))))
  this.authorizationRevision=field(authorizationRevision,'connection authorization revision',160)
  if(typeof readJson!=='function'||!Array.isArray(capabilities)||capabilities.some(k=>!allowed[src?.provider]?.includes(k)))throw Error('Invalid read capabilities')
  this.approvedLinkOrigins=approvedLinkOrigins.map(instance=>source({...src,instance}).instance)
  this.source=Object.freeze(source(src));this.readJson=readJson;this.#capabilities=new Set(capabilities);this.instanceValidated=instanceValidated===true
  Object.freeze(this.approvedLinkOrigins)
  Object.freeze(this)
 }
 get capabilities(){return new Set(this.#capabilities)}
 async page(kind,options={}){
  if(!this.capabilities.has(kind))throw Error('Read capability not configured')
  const path=request(this.source,kind,options)
  // The injected trusted transport owns credentials, redirect policy and destination allowlist.
  // It must reject redirects and enforce response bounds; this adapter never selects another origin.
  const payload=await this.readJson({method:'GET',origin:this.source.instance,path,maxBytes:4*1024*1024,redirect:'error',signal:options.signal})
  const objects=normalizeResponse(this.source,kind,payload,{...options,approvedLinkOrigins:this.approvedLinkOrigins})
  return {objects:objects.filter(o=>this.#capabilities.has(o.kind)),complete:false,page:options.page??1,
   coverage:{mode:'single_page_snapshot',observed_page:options.page??1,requested_limit:100,observed_count:objects.length,has_more:'unknown',reconciliation:'not_performed'},
   compatibility:this.instanceValidated?'instance-validated':'unverified-instance',source:this.source}
 }
}
