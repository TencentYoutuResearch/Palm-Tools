/** Owner-only read projection. External text never becomes an intake, draft, or tool call. */
import {validWorkspaceScope, workspaceScopeKey, sameWorkspace} from './workspace-scope.js'

export const EXTERNAL_RESOURCE_PAGE_SIZE = 30
export const RESOURCE_PROVIDERS = Object.freeze({tapd:'TAPD',gongfeng:'工蜂',github:'GitHub',gitlab:'GitLab',gitea:'Gitea'})
export const RESOURCE_KINDS = Object.freeze({story:'需求',bug:'缺陷',task:'任务',issue:'Issue',change_request:'MR / PR',comment:'评论'})
const disabledReasons = Object.freeze({
  authorized_connection_registry_unavailable:'TAPD / 工蜂项目绑定尚未接入此面板，当前没有读取外部服务。插件已安装或启用，不代表项目已连接。',
  no_authorized_connections:'当前没有可用的已授权项目连接。可在「管理插件」查看插件状态；安装或启用插件不代表项目已连接。',
  cache_unavailable:'资源缓存暂不可用。请检查 Host 状态后重试。',
})
/** Presentation only. Plugin installation and credential presence never enable binding or synchronization. */
export function externalResourceNotice({phase,status,selected}) {
  if(phase==='disabled')return disabledReasons[status?.reason]??'外部资源暂不可用。请检查插件授权或 Host 状态后重试。'
  if(phase==='unselected')return '请先从侧栏选择一个已登记工作区。'
  if(phase==='revoked')return '资源绑定或访问权限已失效，先前内容已隐藏。请检查插件授权和工作区绑定后刷新。'
  if(phase==='unavailable')return '无法确认资源来源或当前权限，内容已隐藏。请检查 Host 状态后重试。'
  if(phase==='empty')return selected?'此绑定暂无本地快照。刷新只核对现有缓存与访问权限，不会从外部服务同步内容。':'此工作区尚无可读取的资源绑定。此面板暂不提供新建绑定入口。'
  return null
}
const endpoint = '/api/kode/external-resources'
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const revision = value => Number.isSafeInteger(value) && value > 0
const text = (value, max=32768) => typeof value === 'string' && !/[\u0000]/.test(value) && new TextEncoder().encode(value).length <= max
const sourceKey = source => JSON.stringify([source?.provider,source?.instance,source?.resource])
const canonicalScope = value => validWorkspaceScope(value) ? Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(key=>[key,value[key]])) : null
const bindingKey = value => JSON.stringify([value.id,workspaceScopeKey(value.scope),value.surface_id,value.audience_revision,value.connection_id,value.connection_revision,value.revision,sourceKey(value.source),value.enabled])
function requireValue(value) {if(!value)throw Error('Invalid external resource response')}
function validSource(source) {
  try {const url=new URL(source.instance);return Object.hasOwn(RESOURCE_PROVIDERS,source.provider)
    && url.protocol==='https:' && url.origin===source.instance && !url.username && !url.password && text(source.resource,256) && !!source.resource.trim()}
  catch{return false}
}

/** Deliberately narrower than the provider allowlist until cross-origin link evidence is exposed. */
export function externalResourceLink(value, source) {
  try {const url=new URL(value);return validSource(source) && url.protocol==='https:' && url.origin===source.instance
    && !url.username && !url.password ? url.href : null}catch{return null}
}
export function validateExternalStatus(value) {
  requireValue(value && ['disabled','ready'].includes(value.state) && value.dispatch==='disabled'
    && value.provider_health==='not_checked' && Number.isSafeInteger(value.authorized_connections) && value.authorized_connections>=0
    && (value.state==='disabled' ? value.authorized_connections===0 : value.authorized_connections>0))
  return value
}
export const enabledResourceTabs=(bindings,providers)=>providers.filter(([id])=>bindings.some(binding=>binding.enabled&&binding.source.provider===id))
export function validateExternalBindings(value, scope) {
  requireValue(Array.isArray(value?.items))
  const seen=new Set()
  for(const binding of value.items){
    requireValue(id(binding?.id) && !seen.has(binding.id) && sameWorkspace(binding.scope,scope)
      && id(binding.surface_id) && revision(binding.audience_revision) && id(binding.connection_id)
      && text(binding.connection_revision,160) && !!binding.connection_revision.trim() && revision(binding.revision)
      && typeof binding.enabled==='boolean' && validSource(binding.source))
    seen.add(binding.id)
  }
  return value.items
}
/** The server proves this is the active channel of this project. */
export function validateChannelProject(value, scope, surfaceId) {
  requireValue(id(surfaceId) && sameWorkspace(value?.scope,scope) && value.surface_id===surfaceId
    && revision(value.audience_revision))
  return validateExternalBindings({items:value.bindings}, scope)
}
export function validateExternalObservation(value) {
  // v2 caches and older Host responses may have no recorded read evidence.
  if (value == null) return null
  requireValue(value.mode==='single_page_snapshot' && Number.isInteger(value.observed_page)
    && value.observed_page>=1 && value.observed_page<=100 && value.requested_limit===100
    && Number.isInteger(value.observed_count) && value.observed_count>=0 && value.observed_count<=value.requested_limit
    && value.has_more==='unknown' && value.reconciliation==='not_performed' && id(value.request_id)
    && Object.hasOwn(RESOURCE_KINDS,value.kind) && text(value.read_at,128)
    && Number.isFinite(Date.parse(value.read_at)) && new Date(value.read_at).toISOString()===value.read_at
    && (value.kind==='comment'
      ? value.parent && Object.hasOwn(RESOURCE_KINDS,value.parent.kind) && value.parent.kind!=='comment' && text(value.parent.id,256) && !!value.parent.id
      : value.parent===null))
  return value
}
export function validateExternalCards(page, binding, after=0) {
  requireValue(page && Array.isArray(page.items) && page.items.length<=EXTERNAL_RESOURCE_PAGE_SIZE
    && page.dispatch==='disabled' && sourceKey(page.source)===sourceKey(binding.source)
    && page.binding_revision===binding.revision && page.connection_revision===binding.connection_revision
    && ['instance-validated','unverified-instance'].includes(page.compatibility))
  let cursor=after;const seen=new Set()
  for(const card of page.items){
    requireValue(card && card.origin==='external' && card.trusted_instruction===false && card.dispatch==='disabled'
      && sourceKey(card.source)===sourceKey(binding.source) && Object.hasOwn(RESOURCE_KINDS,card.kind)
      && text(card.id,256) && !!card.id && text(card.title,2048) && text(card.body) && text(card.native_state,256)
      && text(card.author,512) && text(card.updated_at,128) && (card.url===null || text(card.url,4096))
      && card.key===JSON.stringify([...JSON.parse(sourceKey(binding.source)),card.kind,card.id]) && !seen.has(card.key)
      && Number.isSafeInteger(card.cursor) && card.cursor>cursor)
    seen.add(card.key);cursor=card.cursor
  }
  return {items:page.items,after:cursor,more:page.items.length===EXTERNAL_RESOURCE_PAGE_SIZE,compatibility:page.compatibility,last_sync:validateExternalObservation(page.last_sync)}
}
export async function requestExternalResources(operation, params={}, {signal,fetcher=globalThis.fetch}={}) {
  const fields={status:[],bindings:['home_hub','host_id','workspace_id','root_ref'],project:['home_hub','host_id','workspace_id','root_ref','surface_id'],cards:['binding','after','limit']}[operation]
  if(!fields||Object.keys(params).some(key=>!fields.includes(key)))throw Error('Unsupported external resource read')
  const query=new URLSearchParams({op:operation,...params})
  const timeout=AbortSignal.timeout(15000)
  const response=await fetcher(endpoint+'?'+query,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout})
  if(!response.ok){const error=Error('External resource read unavailable');error.status=response.status;throw error}
  return response.json()
}

/** In-memory only: every scope/generation change discards old text before I/O starts. */
export function createExternalResourcesModel({request=requestExternalResources}={}) {
  const listeners=new Set();let active=null,epoch=0,disposed=false
  const empty=scope=>({scope,phase:scope?'idle':'unselected',status:null,bindings:[],selected:null,items:[],after:0,more:false,compatibility:null,last_sync:null,loading:false})
  let state=empty(null)
  const publish=patch=>{if(disposed)return;state=Object.freeze({...state,...patch});for(const listener of listeners)listener()}
  const cancel=()=>{epoch++;active?.abort();active=null}
  async function load({bindingId=state.selected?.id,more=false}={}) {
    if(disposed)return
    const before=state,scope=canonicalScope(before.scope)
    cancel();const generation=epoch,controller=new AbortController();active=controller
    const current=()=>!disposed&&!controller.signal.aborted&&epoch===generation&&workspaceScopeKey(state.scope)===workspaceScopeKey(scope)
    publish({...empty(scope),phase:'loading',loading:true})
    try{
      const status=validateExternalStatus(await request('status',{}, {signal:controller.signal}))
      if(!current())return
      if(status.state==='disabled'){publish({phase:'disabled',status,loading:false});return}
      if(!scope){publish({phase:'unselected',status,loading:false});return}
      const bindings=validateExternalBindings(await request('bindings',scope,{signal:controller.signal}),scope)
      if(!current())return
      const selected=bindings.find(binding=>binding.id===bindingId) ?? (!bindingId ? bindings.find(binding=>binding.enabled)??bindings[0] : null)
      if(!selected){publish({phase:bindingId?'revoked':'empty',bindings,status,loading:false});return}
      if(!selected.enabled){publish({phase:'revoked',bindings,selected,status,loading:false});return}
      const append=more && before.selected && bindingKey(before.selected)===bindingKey(selected)
      if(more&&!append){publish({phase:'revoked',bindings,selected,status,loading:false});return}
      const result=validateExternalCards(await request('cards',{binding:selected.id,after:String(append?before.after:0),limit:String(EXTERNAL_RESOURCE_PAGE_SIZE)},{signal:controller.signal}),selected,append?before.after:0)
      if(!current())return
      const items=append?[...before.items.filter(old=>!result.items.some(item=>item.key===old.key)),...result.items]:result.items
      publish({...result,items,phase:items.length?'ready':'empty',bindings,selected,status,loading:false})
    }catch(error){if(current())publish({...empty(scope),phase:[401,403,409].includes(error.status)?'revoked':'unavailable',loading:false})}
    finally{if(current())active=null}
  }
  return {
    getSnapshot:()=>state,
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    setScope(value){const scope=canonicalScope(value);if(workspaceScopeKey(scope)===workspaceScopeKey(state.scope))return;cancel();publish(empty(scope))},
    refresh:()=>load(),
    select:bindingId=>state.bindings.some(binding=>binding.id===bindingId)?load({bindingId}):Promise.resolve(),
    more:()=>state.more&&!state.loading?load({more:true}):Promise.resolve(),
    clear(){cancel();publish(empty(state.scope))},
    dispose(){cancel();disposed=true;listeners.clear()},
  }
}

/** Legacy read-only card projection compatibility for Hub consumers.
 * The current panel uses validateExternalCards with revision and audience checks.
 * This adapter never enables binding, synchronization or rendering unvalidated links. */
export function validateCards(page, source) {
  if (!Array.isArray(page?.items) || page.dispatch !== 'disabled' || sourceKey(page.source) !== sourceKey(source)) throw Error('Invalid resource page')
  for (const card of page.items) if (card.origin !== 'external' || card.trusted_instruction !== false || card.dispatch !== 'disabled' || sourceKey(card.source) !== sourceKey(source)) throw Error('Invalid provenance')
  return page.items
}
