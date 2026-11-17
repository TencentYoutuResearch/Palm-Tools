import { workspaceScopeKey, teamInWorkspace } from './workspace-scope.js'
/** Separate pagination per canonical scope; Team/conversation identities remain shared, not copied. */
export function createWorkspaceContacts({request,onTeams}) {
  const listeners=new Set(), jobs=new Map(), controllers=new Set(), active=new Map()
  let snapshot=Object.freeze({}),closed=false
  const publish=(key,patch)=>{if(closed)return;snapshot=Object.freeze({...snapshot,[key]:Object.freeze({...snapshot[key],...patch})});for(const fn of listeners)fn()}
  const load=(scope,{more=false,reload=false,search}={})=>{
    if(closed)return Promise.resolve()
    scope=scope?{home_hub:scope.home_hub,host_id:scope.host_id,workspace_id:scope.workspace_id,root_ref:scope.root_ref}:null
    const key=workspaceScopeKey(scope)
    if(!key)return Promise.reject(Error('Invalid workspace scope'))
    const before=snapshot[key],queryText=search??before?.query??''
    if(typeof queryText!=='string'||new TextEncoder().encode(queryText).length>160||queryText.includes('\0'))return Promise.reject(Error('Invalid workspace search'))
    const changed=queryText!==(before?.query??'')
    if(jobs.has(key)&&!changed)return jobs.get(key)
    if(changed)active.get(key)?.abort()
    if(before?.loaded&&!more&&!reload&&!changed)return Promise.resolve()
    if(more&&!before?.cursor)return Promise.resolve()
    const controller=new AbortController();controllers.add(controller);active.set(key,controller)
    const after=more?before.cursor:''
    publish(key,{loading:true,error:'',query:queryText,...(changed?{teams:[],cursor:null,loaded:false}:{})})
    const task=Promise.resolve().then(async()=>{
      try{
        if(closed||controller.signal.aborted)return
        const query=new URLSearchParams({view:'contacts',after,limit:'25',workspace_host:scope.host_id,workspace_id:scope.workspace_id,workspace_root:scope.root_ref,q:queryText})
        const page=await request('/api/kode/collab/teams?'+query,{signal:controller.signal})
        if(closed||controller.signal.aborted)return
        if(page.home_hub!==scope.home_hub||page.projection!=='contact_directory'||page.archived!==false||page.order!=='pinned_attention_unread_recent'
          ||!Array.isArray(page.items)||page.items.length>25||page.items.some(team=>!teamInWorkspace(team,scope))
          ||new Set(page.items.map(t=>t.id)).size!==page.items.length
          ||(page.next_cursor!==null&&(typeof page.next_cursor!=='string'||!/^[A-Za-z0-9_-]{1,16384}$/.test(page.next_cursor)||page.next_cursor===after)))throw Error('Invalid workspace directory receipt')
        const teams=new Map((more?before.teams:[]).map(team=>[team.id,team]));for(const team of page.items)teams.set(team.id,team)
        onTeams(page.items,page.home_hub)
        publish(key,{teams:[...teams.values()],cursor:page.next_cursor,loaded:true})
      }catch(error){if(!closed&&!controller.signal.aborted)publish(key,{error:'暂时无法读取这个工作区的频道，请重试。'})}
      finally{controllers.delete(controller);if(active.get(key)===controller){active.delete(key);jobs.delete(key);publish(key,{loading:false})}}
    })
    jobs.set(key,task);return task
  }
  return {getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},load,
    close(){closed=true;for(const c of controllers)c.abort();controllers.clear();listeners.clear()}}
}
