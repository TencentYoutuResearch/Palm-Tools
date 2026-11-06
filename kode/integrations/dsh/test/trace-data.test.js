import test from 'node:test'
import assert from 'node:assert/strict'
import { TRACE_VIEWS,readTraceManifest,readTracePage,readTraceSlice,exportTracePart } from '../packages/collab/trace-data.js'
const run={id:'run',team_id:'team',home_hub:'home',revision:3}
const base=view=>({schema_version:1,...run,run_id:run.id,run_revision:3,view,read_only:true,consistency:'anchored_membership_current_records',redaction_policy:'credential_fields_environments_arguments_v1',archive_payloads_included:false,cost_attribution:'operation_scoped_shared_coordinator_not_allocated'})
const manifest=()=>({...base('manifest'),context:run,redacted_paths:[],prompt_attestation:{calls:2,missing:2,status:'incomplete'},streams:TRACE_VIEWS.map(view=>({view,through:2,count:2}))})
const row=cursor=>({cursor,data:{kind:'fixture'},links:{scope:'work_run'},raw_sha256:'a'.repeat(64),raw_bytes:20,redacted_paths:[]})
function fixture(){
 const reads=[]
 const request=async(path,options)=>{assert.ok(path.startsWith('/api/kode/work-run/trace?'));assert.ok(!options?.body);reads.push(path);const p=new URL(path,'http://fixture').searchParams,view=p.get('view');if(view==='manifest')return manifest();const after=Number(p.get('after')),cursor=after+1;return {...base(view),query:p.get('q'),after,through:2,scanned_to:cursor,scanned:1,items:[row(cursor)],next_cursor:cursor===2?null:cursor}}
 return {request,reads}
}
test('trace search permits an empty advancing scan and rejects foreign/non-advancing pages',async()=>{
 const m=manifest();m.streams.find(r=>r.view==='work_events').through=55;m.streams.find(r=>r.view==='work_events').count=55
 const empty={...base('work_events'),query:'needle',after:0,through:55,scanned_to:50,scanned:50,items:[],next_cursor:50}
 const found=await readTracePage({run,manifest:m,view:'work_events',q:'needle',request:async()=>empty});assert.equal(found.next_cursor,50)
 for(const change of [{home_hub:'foreign'},{next_cursor:0},{scanned_to:56},{next_cursor:null},{archive_payloads_included:true}])await assert.rejects(readTracePage({run,manifest:m,view:'work_events',q:'needle',request:async()=>({...empty,...change})}))
 await assert.rejects(readTracePage({run,manifest:m,view:'work_events',request:async()=>({...empty,query:''})}),/progress/)
})
test('export parts retain one manifest/watermark and prove every source count without duplicate records',async()=>{
 const f=fixture(),all=Object.fromEntries(TRACE_VIEWS.map(view=>[view,[]]));let continuation,parts=0,last
 do{const result=await exportTracePart({run,request:f.request,continuation,maxRecords:3,uuid:()=> 'one-export'});parts++;assert.equal(result.document.export_id,'one-export');assert.equal(result.document.part,parts);for(const [view,rows]of Object.entries(result.document.records))all[view].push(...rows.map(r=>r.cursor));continuation=result.continuation;last=result.document;assert.ok(parts<30)}while(continuation)
 assert.equal(last.complete,true);assert.equal(last.parts_total,parts);assert.equal(f.reads.filter(url=>url.includes('view=manifest')).length,1)
 for(const view of TRACE_VIEWS){assert.deepEqual(all[view],[1,2]);assert.equal(last.counts[view],2)}
})
test('incomplete counts, corrupt continuation and a changed task cannot produce a complete export',async()=>{
 const f=fixture(),part=await exportTracePart({run,request:f.request,maxRecords:1,uuid:()=> 'export'})
 await assert.rejects(exportTracePart({run,request:f.request,continuation:{...part.continuation,counts:{}}}),/counts/)
 await assert.rejects(exportTracePart({run:{...run,revision:4},request:f.request,continuation:part.continuation}),/scope/)
 await assert.rejects(exportTracePart({run,request:async(path,options)=>{if(new URL(path,'http://fixture').searchParams.get('view')==='manifest')return manifest();const page=await f.request(path,options);return {...page,items:[row(2)],scanned_to:2,next_cursor:null}}}),/count/)
 const stop=new AbortController();stop.abort();const reads=f.reads.length;await assert.rejects(exportTracePart({run,request:f.request,signal:stop.signal}));assert.equal(f.reads.length,reads)
 await assert.rejects(readTraceManifest({run,request:async()=>({...manifest(),streams:[]})}),/incomplete/)
})
test('export can split inside a page without exceeding record or byte budgets',async()=>{
 const f=fixture()
 const request=async(path,options)=>{const p=new URL(path,'http://fixture').searchParams;if(p.get('view')==='manifest')return manifest();const after=Number(p.get('after'));return {...base(p.get('view')),query:'',after,through:2,scanned_to:2,scanned:2-after,items:after===0?[row(1),row(2)]:[row(2)],next_cursor:null}}
 const first=await exportTracePart({run,request,maxRecords:1,maxBytes:10000,uuid:()=> 'bounded'})
 assert.equal(first.document.records.work_events.length,1);assert.equal(first.continuation.after,1);assert.ok(new TextEncoder().encode(JSON.stringify(first.document)).length<=10000)
 const second=await exportTracePart({run,request,continuation:first.continuation,maxRecords:1,maxBytes:10000})
 assert.equal(second.document.records.work_events[0].cursor,2)
 await assert.rejects(exportTracePart({run,request:f.request,maxBytes:1}),/byte budget/)
})
test('cross-source reader bounds each slice and fences reused search cursors',async()=>{
 const f=fixture(),m=manifest();let cursor,records=[]
 do{const page=await readTraceSlice({run,manifest:m,request:f.request,cursor,maxRecords:3,maxPages:2});assert.ok(page.items.length<=3);records.push(...page.items);cursor=page.next_cursor;if(cursor)await assert.rejects(readTraceSlice({run,manifest:m,request:f.request,cursor,q:'changed'}),/another query/)}while(cursor)
 assert.equal(records.length,TRACE_VIEWS.length*2)
 assert.equal(new Set(records.map(row=>row.view+':'+row.cursor)).size,records.length)
})
