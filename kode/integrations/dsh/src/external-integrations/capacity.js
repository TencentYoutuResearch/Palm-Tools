/** Bounded derived cache, not a filesystem quota or a retention/deletion policy. */
export const CACHE_LIMITS = Object.freeze({bindings:128,cards:10000,events:50000,receipts:20000,snapshot_bytes:64*1024*1024})
export class ExternalCacheCapacityError extends Error {
 constructor(resource){super(`External snapshot cache capacity reached (${resource}); existing snapshots and receipts were preserved`);this.code='external_cache_capacity';this.resource=resource}
}
export const bytes = (...values) => values.reduce((sum,value)=>sum+Buffer.byteLength(value,'utf8'),0)

export class CacheCapacity {
 constructor(db,limits={}){
  if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.keys(limits).some(key=>!Object.hasOwn(CACHE_LIMITS,key)))throw Error('Invalid cache capacity limits')
  this.limits=Object.freeze({...CACHE_LIMITS,...limits})
  for(const key of Object.keys(CACHE_LIMITS))if(!Number.isSafeInteger(this.limits[key])||this.limits[key]<1||this.limits[key]>CACHE_LIMITS[key])throw Error('Invalid cache capacity limits')
  this.db=db
  // One SQLite statement gives a consistent snapshot. Count the UTF-8 bytes in
  // every TEXT column of the three accumulating snapshot tables, not JS length.
  // Bounded binding metadata and poll rows are covered by the binding count.
  const part=(table,columns)=>`(SELECT COUNT(*) n,COALESCE(SUM(${columns.map(column=>`length(CAST(${column} AS BLOB))`).join('+')}),0) bytes FROM ${table} WHERE (? IS NULL OR binding=?))`
  this.measure=db.prepare(`SELECT (SELECT COUNT(*) FROM external_bindings) bindings,c.n cards,e.n events,r.n receipts,c.bytes+e.bytes+r.bytes snapshot_bytes FROM ${part('external_cards',['binding','key','body'])} c,${part('external_events',['binding','key','body'])} e,${part('external_receipts',['binding','request','fingerprint','body'])} r`)
  this.version=db.prepare('PRAGMA data_version');this.changes=db.prepare('SELECT total_changes() n')
  this.triggers=db.prepare("SELECT tbl_name FROM sqlite_schema WHERE type='trigger' UNION ALL SELECT tbl_name FROM sqlite_temp_schema WHERE type='trigger'")
 }
 changeCount(){return this.changes.get().n}
 stamp(){return `${this.version.get().data_version}:${this.changeCount()}`}
 usage(){
  const stamp=this.stamp()
  if(this.cached?.stamp!==stamp)this.cached={stamp,usage:{...this.measure.get(null,null,null,null,null,null)}}
  return {...this.cached.usage}
 }
 binding(id){return {...this.measure.get(id,id,id,id,id,id)}}
 remember(usage,before,expected,tables=['external_bindings','external_polls','external_cards','external_events','external_receipts']){
  // Unknown triggers must not make projected counters undercount committed
  // writes. Fail closed in this same transaction rather than discover it later.
  if(this.changeCount()-before!==expected)throw Error('External cache changed unexpectedly during write')
  // This Host-owned schema has no triggers. Equal row counts cannot prove that
  // a trigger preserved byte sizes, metadata or poll identity. Reject mutations
  // of affected tables before COMMIT; never delete/repair an unfamiliar trigger.
  // SQLite identifier matching folds ASCII case, but schema preserves DDL case.
  if(this.triggers.all().some(row=>tables.includes(row.tbl_name.replace(/[A-Z]/g,char=>char.toLowerCase()))))throw Error('External cache changed unexpectedly during write')
  this.cached={stamp:this.stamp(),usage:{...usage}}
 }
 invalidate(){this.cached=null}
 assert(usage){for(const [key,limit]of Object.entries(this.limits))if(usage[key]>limit)throw new ExternalCacheCapacityError(key)}
 status(){const usage=this.usage();return {usage,limits:this.limits,at_limit:Object.keys(this.limits).filter(key=>usage[key]>=this.limits[key])}}
}
