import {openPrivateDatabase} from './cache-storage.js'
export const CACHE_VERSION = 2
const CACHE_APPLICATION = 0x4b455852
import {randomUUID} from 'node:crypto'
import {hash,id,scope,source,sourceKey,objectKey,field} from './identity.js'
import {CacheCapacity,bytes} from './capacity.js'
const parse=JSON.parse
/** Host-owned external event cache. Never a second task authority; creates no tasks or owner messages. */
export class ExternalInbox {
 constructor(path,{clock=()=>Date.now(),cacheIdentity='isolated-cache',capacityLimits}={}){
  this.clock=clock;this.closed=false;this.leases=new Map();this.db=openPrivateDatabase(path)
  try {
   this.db.exec('PRAGMA busy_timeout=5000')
   const version=this.db.prepare('PRAGMA user_version').get().user_version
   const application=this.db.prepare('PRAGMA application_id').get().application_id
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
   if(version===0&&application===0&&tables.length===0){
    this.tx(()=>{
     this.db.exec(`
      CREATE TABLE external_cache_meta(identity TEXT NOT NULL);
      CREATE TABLE external_bindings(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE external_polls(binding TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE external_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,binding TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(binding,key));
      CREATE TABLE external_cards(binding TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(binding,key));
      CREATE TABLE external_receipts(binding TEXT NOT NULL,request TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(binding,request));
      PRAGMA application_id=${CACHE_APPLICATION}; PRAGMA user_version=${CACHE_VERSION};`)
     this.db.prepare('INSERT INTO external_cache_meta VALUES(?)').run(hash(cacheIdentity))
    })
   }else if(version!==CACHE_VERSION||application!==CACHE_APPLICATION){throw Error('Unsupported external cache version')}
   const metadata=this.db.prepare('SELECT identity FROM external_cache_meta').all()
   if(metadata.length!==1||metadata[0].identity!==hash(cacheIdentity))throw Error('External cache Host identity mismatch')
   this.db.exec('PRAGMA journal_mode=WAL')
   this.capacity=new CacheCapacity(this.db,capacityLimits)
  }catch(error){this.db.close();this.closed=true;throw error}
 }
 close(){
  if(this.closed)return
  try{this.tx(()=>{const usage=this.capacity.usage(),before=this.capacity.changeCount();let changed=0;for(const [binding,token]of this.leases)changed+=Number(this.db.prepare('DELETE FROM external_polls WHERE binding=? AND token=?').run(binding,token).changes);this.capacity.remember(usage,before,changed,['external_polls'])})}
  finally{this.leases.clear();this.db.close();this.closed=true}
 }
 tx(fn){this.db.exec('BEGIN IMMEDIATE');const before=this.capacity?.changeCount();try{const v=fn();this.db.exec('COMMIT');return v}catch(e){if(this.capacity?.changeCount()!==before)this.capacity?.invalidate();this.db.exec('ROLLBACK');throw e}}
 bind(input){
  const b={id:id(input.id),scope:scope(input.scope),surface_id:id(input.surface_id),audience_revision:input.audience_revision,
   connection_id:id(input.connection_id),connection_revision:field(input.connection_revision,'connection revision'),source:source(input.source),enabled:input.enabled===true}
  if(!Number.isSafeInteger(b.audience_revision)||b.audience_revision<1||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw Error('Invalid binding revision')
  return this.tx(()=>{const old=this.db.prepare('SELECT * FROM external_bindings WHERE id=?').get(b.id)
   if((old?.revision??0)!==input.expected_revision)throw Error('Binding revision changed')
   if(old){const prior=parse(old.body);if(JSON.stringify([prior.scope,prior.surface_id,prior.connection_id,prior.source])!==JSON.stringify([b.scope,b.surface_id,b.connection_id,b.source]))throw Error('Binding target is immutable; create a new binding')}
   const usage=this.capacity.usage()
   if(old){
    // Existing explicit generation changes remain possible even for a legacy
    // over-limit cache. They only remove snapshot data, never evict on capacity.
    const removed=this.capacity.binding(b.id)
    for(const key of ['cards','events','receipts','snapshot_bytes'])usage[key]-=removed[key]
   }else{usage.bindings++;this.capacity.assert(usage)}
   b.revision=input.expected_revision+1
   const before=this.capacity.changeCount();let changed=1
   this.db.prepare('INSERT INTO external_bindings VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,body=excluded.body').run(b.id,b.revision,+b.enabled,JSON.stringify(b))
   changed+=Number(this.db.prepare('DELETE FROM external_polls WHERE binding=?').run(b.id).changes)
   // Every explicit binding revision starts a new cache audience/authorization
   // generation. Previously read text cannot reappear after revoke/re-enable.
   for(const table of ['external_cards','external_events','external_receipts'])changed+=Number(this.db.prepare(`DELETE FROM ${table} WHERE binding=?`).run(b.id).changes)
   this.capacity.remember(usage,before,changed)
   this.leases.delete(b.id)
   return b
  })
 }
 get(binding){const r=this.db.prepare('SELECT body FROM external_bindings WHERE id=?').get(id(binding));if(!r)throw Error('Unknown binding');return parse(r.body)}
 list(s){s=scope(s);return this.db.prepare('SELECT body FROM external_bindings ORDER BY id').all().map(x=>parse(x.body)).filter(b=>JSON.stringify(b.scope)===JSON.stringify(s))}
 begin(binding,revision){return this.start(binding,revision).token}
 start(binding,revision,request=null,command={}){return this.tx(()=>{
  const b=this.get(binding);if(!b.enabled||b.revision!==revision)throw Error('Binding disabled or changed')
  // Repeat the receipt check under the write lock: another process may have
  // committed this exact request after the service's authorization await.
  if(request!==null){const receipt=this.receipt(binding,request,command);if(receipt)return {receipt}}
  const usage=this.capacity.usage();this.capacity.assert({...usage,receipts:usage.receipts+1})
  const old=this.db.prepare('SELECT * FROM external_polls WHERE binding=?').get(binding),now=this.clock()
  if(old&&old.expires>now)throw Error('Synchronization already in progress')
  const token=randomUUID(),before=this.capacity.changeCount();this.db.prepare('INSERT OR REPLACE INTO external_polls VALUES(?,?,?)').run(binding,token,now+60000);this.capacity.remember(usage,before,1,['external_polls']);this.leases.set(binding,token);return {token}
 })}
 receipt(binding,request,command){const row=this.db.prepare('SELECT body FROM external_receipts WHERE binding=? AND request=?').get(id(binding),id(request));if(!row)return null;const result=parse(row.body);if(result.command_hash!==hash(command))throw Error('Request id reused with changed operation');return result}
 finish(binding,revision,token,request,objects,command={},observation=null){
  id(request,'request id');if(!Array.isArray(objects)||objects.length>100)throw Error('Invalid page')
  return this.tx(()=>{
   const b=this.get(binding),lease=this.db.prepare('SELECT * FROM external_polls WHERE binding=?').get(binding)
   if(!b.enabled||b.revision!==revision||lease?.token!==token||lease.expires<=this.clock())throw Error('Synchronization lease invalidated')
   for(const o of objects){if(sourceKey(o.source)!==sourceKey(b.source)||o.key!==objectKey(b.source,o.kind,o.id)||o.origin!=='external'||o.trusted_instruction!==false||o.dispatch!=='disabled')throw Error('Invalid external object')}
   const fp=hash({objects,command}),prior=this.db.prepare('SELECT * FROM external_receipts WHERE binding=? AND request=?').get(binding,request)
   const usage=this.capacity.usage()
   if(prior){if(prior.fingerprint!==fp)throw Error('Request id reused with changed snapshot');const before=this.capacity.changeCount();this.db.prepare('DELETE FROM external_polls WHERE binding=? AND token=?').run(binding,token);this.capacity.remember(usage,before,1);return parse(prior.body)}
   const changes=[],pending=new Map()
   for(const o of objects){const body=JSON.stringify(o),previous=pending.has(o.key)?pending.get(o.key):this.db.prepare('SELECT body FROM external_cards WHERE binding=? AND key=?').get(binding,o.key)?.body
    if(previous===body)continue
    // Snapshot observation identity, not provider revision ordering or deletion inference.
    const key=hash([o.key,body,this.clock(),randomUUID()])
    usage.events++;usage.snapshot_bytes+=bytes(binding,key,body)
    if(previous===undefined){usage.cards++;usage.snapshot_bytes+=bytes(binding,o.key,body)}else usage.snapshot_bytes+=bytes(body)-bytes(previous)
    changes.push({key,card:o.key,body});pending.set(o.key,body)
   }
   const receipt={request_id:request,command_hash:hash(command),updated:changes.length,observed:objects.length,origin:'external',dispatch:'disabled',binding_revision:revision,last_sync:observation},receiptBody=JSON.stringify(receipt)
   usage.receipts++;usage.snapshot_bytes+=bytes(binding,request,fp,receiptBody)
   // No snapshot table is changed before the complete page's projected usage
   // passes inside BEGIN IMMEDIATE. Rejected writes create no error receipts.
   this.capacity.assert(usage)
   const before=this.capacity.changeCount()
   for(const change of changes){
    const result=this.db.prepare('INSERT INTO external_events(binding,key,body,created) VALUES(?,?,?,?)').run(binding,change.key,change.body,this.clock())
    this.db.prepare('INSERT INTO external_cards VALUES(?,?,?,?) ON CONFLICT(binding,key) DO UPDATE SET body=excluded.body,seq=excluded.seq').run(binding,change.card,change.body,Number(result.lastInsertRowid))
   }
   // Optional v2 JSON metadata: older caches remain unknown. This is updated in
   // the same successful receipt transaction, including empty/unchanged pages.
   // It describes only the latest read, not the age or coverage of all cards.
   this.db.prepare('UPDATE external_bindings SET body=? WHERE id=?').run(JSON.stringify({...b,last_sync:observation}),binding)
   this.db.prepare('INSERT INTO external_receipts VALUES(?,?,?,?)').run(binding,request,fp,receiptBody);this.db.prepare('DELETE FROM external_polls WHERE binding=? AND token=?').run(binding,token)
   this.capacity.remember(usage,before,changes.length*2+3)
   return receipt
  })
 }
 release(binding,token){this.tx(()=>{const usage=this.capacity.usage(),before=this.capacity.changeCount(),changed=this.db.prepare('DELETE FROM external_polls WHERE binding=? AND token=?').run(binding,token).changes;this.capacity.remember(usage,before,Number(changed),['external_polls'])});if(this.leases.get(binding)===token)this.leases.delete(binding)}
 cards(binding,{after=0,limit=30}={}){if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid page');const b=this.get(binding);if(!b.enabled)throw Error('Binding disabled');return this.db.prepare('SELECT body,seq FROM external_cards WHERE binding=? AND seq>? ORDER BY seq LIMIT ?').all(binding,after,limit).map(x=>({...parse(x.body),cursor:x.seq}))}
}
