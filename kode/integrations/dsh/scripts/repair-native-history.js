/** One-time maintenance for the old text-only import. Default: report only.
 * --apply requires the session's real kernel writer lock. Original artifacts
 * and projection caches are backed up; native CLI logs are never modified. */
import { readFile,writeFile,readdir,open,copyFile,mkdir,rename } from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {zstdDecompressSync} from 'node:zlib'
import {buildHistorySeed,renumberNativeTurns,encodeHistoryArtifact} from '../src/native-history.js'
import {BackendClient} from '../src/backend-client.js'
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1]
for(const name of ['--home','--url','--token-file','--runtime-modules'])if(!args.includes(name))throw new Error(`Missing ${name}`)
const home=option('--home'),modules=option('--runtime-modules'),apply=args.includes('--apply')
const require=createRequire(join(modules,'@deepseek-ai/dsh-session-persistence-jsonl/package.json'))
const {tryLockExclusive}=await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/flock')))
const {Session,KNOWN_SESSION_EVENT_TYPES}=await import(pathToFileURL(join(modules,'@deepseek-ai/dsh-session/lib/index.js')))
const {assertReleasedV4Relationships}=await import(pathToFileURL(join(modules,'@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')))
const client=new BackendClient(option('--url'),(await readFile(option('--token-file'),'utf8')).trim())
const index=(await client.call('/api/v1/messaging/workbench/documents/session-index')).value
const roots=(await readdir(join(home,'sessions'),{withFileTypes:true})).filter(row=>row.isDirectory()).map(row=>join(home,'sessions',row.name))
const conversation=new Set(['turn/start','turn/end','step/start','step/end','request/header','user/message','assistant/message','assistant/attempt','tool/call','tool/result'])
async function mark(id){for(let attempt=0;attempt<6;attempt++){const row=await client.call('/api/v1/messaging/workbench/documents/session-index');row.value.imports[id].formatVersion=3;try{await client.call('/api/v1/messaging/workbench/documents/session-index',{expected_revision:row.revision,value:row.value});return}catch(error){if(attempt===5||!/configuration changed/.test(error.message))throw error}}}
for(const [id,record] of Object.entries(index?.imports??{})){
 if(record.formatVersion>=3)continue
 let directory,rows,originalArtifact
 for(const root of roots){try{originalArtifact=await readFile(join(root,id,'session.v4.jsonl.zstd'));rows=zstdDecompressSync(originalArtifact).toString().trim().split('\n').map(JSON.parse);directory=join(root,id);break}catch(error){if(error.code!=='ENOENT')throw error}}
 if(!rows)continue
 const [wireHeader,...events]=rows,header={...wireHeader};delete header.type
 if(events.some(event=>event.type==='plugin:kode/history-repaired')){if(apply)await mark(id);continue}
 const first=events.findIndex(event=>event.type==='turn/start')
 if(first<0)continue
 const inbox=events.findIndex(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.length)
 const cut=inbox<0?events.length:inbox
 const before=inbox<0?undefined:events.slice(inbox).find(event=>event.type==='turn/start')?.time
 const transcript=await client.call('/api/v1/messaging/workbench/transcript',{backend_key:record.backendKey,session_id:record.nativeSessionId,cwd:record.cwd,...(before===undefined?{}:{before})})
 if(!transcript.available || !transcript.messages.length){console.log(id,'skipped: no timestamped native history in the recent window');continue}
 const selection=events.find(event=>event.type==='request/header')?.data.header.config
 if(!selection)throw new Error('Original native model selection is missing')
 const seed=buildHistorySeed(transcript,selection),prefix=events.slice(0,first),metadata=events.slice(first,cut).filter(event=>!conversation.has(event.type)),suffix=events.slice(cut)
 const original=new Set([...prefix,...metadata,...suffix]),combined=[...prefix,...seed,...metadata,...suffix]
 const seqs=new Map(combined.flatMap((event,seq)=>original.has(event)?[[event.seq,seq]]:[]))
 const userText=event=>event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
 const oldUsers=new Map()
 for(const event of events.slice(first,cut).filter(event=>event.type==='user/message')){const text=userText(event),items=oldUsers.get(text)??[];items.push(event.seq);oldUsers.set(text,items)}
 for(let index=0;index<seed.length;index++){const event=seed[index];if(event.type==='user/message'){const old=oldUsers.get(userText(event))?.shift();if(old!==undefined)seqs.set(old,prefix.length+index)}}
 const remap=seq=>{if(!seqs.has(seq))throw new Error('A retained event references the replaced import; manual migration is required');return seqs.get(seq)}
 let repaired=renumberNativeTurns(combined.map((event,seq)=>{
  const row=structuredClone(event);row.seq=seq
  if(original.has(event)){
   if(row.data.messageSeqs){
    if(row.data.messageSeqs.some(seq=>!seqs.has(seq))){row.type='plugin:kode/history-title';row.ignorable=true;row.data={originalType:event.type,originalData:event.data};return row}
    row.data.messageSeqs=row.data.messageSeqs.map(remap)
   }
   if(row.sourceEventSeqs)row.sourceEventSeqs=row.sourceEventSeqs.map(remap)
   if(row.data.headerSeq!==undefined)row.data.headerSeq=remap(row.data.headerSeq)
   if(row.data.sourceEventSeq!==undefined)row.data.sourceEventSeq=remap(row.data.sourceEventSeq)
  }
  return row
 }))
 repaired.push({type:'plugin:kode/history-repaired',seq:repaired.length,time:Date.now(),ignorable:true,data:{formatVersion:3,oldEventCount:events.length,source:'native-cli'}})
 assertReleasedV4Relationships({header,inheritedEventCount:0,events:repaired},KNOWN_SESSION_EVENT_TYPES)
 Session.create(id,repaired,header,0)
 console.log(id,apply?'repair':'would repair',`history=${seed.length} events, retained live=${suffix.length}, tools=${repaired.filter(event=>event.type==='tool/call').length}`)
 if(!apply)continue
 const lease=await open(join(directory,'session.lock'),'r+')
 try{
  await tryLockExclusive(lease.fd)
  const path=join(directory,'session.v4.jsonl.zstd'),current=await readFile(path)
  if(!current.equals(originalArtifact))throw new Error('Session changed during preparation; retry when offline')
  const backup=join(home,'migrations',`native-history-${Date.now()}`,id);await mkdir(backup,{recursive:true,mode:0o700})
  await copyFile(path,join(backup,'session.v4.jsonl.zstd'))
  const temporary=path+'.history-repair';await writeFile(temporary,encodeHistoryArtifact(wireHeader,repaired),{mode:0o600})
  const file=await open(temporary,'r+');try{await file.sync()}finally{await file.close()}
  await rename(temporary,path)
  const cache=join(home,'storages/session_projcache/sessions',id+'.json')
  try{await rename(cache,join(backup,'projection-cache.json'))}catch(error){if(error.code!=='ENOENT')throw error}
  await mark(id)
 }finally{await lease.close()}
}
