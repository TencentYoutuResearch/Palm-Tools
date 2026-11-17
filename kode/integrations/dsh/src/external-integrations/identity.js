import {createHash} from 'node:crypto'
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function field(value, name, max=160) {
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error(`Invalid ${name}`)
 return value
}
export function id(value,name='id'){field(value,name);if(!/^[A-Za-z0-9_.:-]+$/.test(value))throw Error(`Invalid ${name}`);return value}
export function scope(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['home_hub','host_id','workspace_id','root_ref'].includes(k)))throw Error('Invalid scope')
 return {home_hub:id(value.home_hub),host_id:id(value.host_id),workspace_id:id(value.workspace_id),root_ref:field(value.root_ref,'root_ref',4096)}
}
export function source(value){
 if(!['tapd','gongfeng','github','gitlab','gitea'].includes(value?.provider))throw Error('Unsupported provider')
 const u=new URL(field(value.instance,'instance',2048))
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Expected clean HTTPS instance origin')
 const resource=field(value.resource,'resource',256)
 // v3 responses identify projects numerically. Path resolution is not implemented;
 // reject paths before I/O rather than guessing or weakening the response check.
 if(value.provider==='gongfeng'&&!/^[1-9][0-9]*$/.test(resource))throw Error('Gongfeng requires canonical numeric project ID')
 return {provider:value.provider,instance:u.origin,resource}
}
export function sourceKey(v){return JSON.stringify(Object.values(source(v)))}
export function objectKey(src,kind,value){return JSON.stringify([...Object.values(source(src)),kind,field(String(value??''),'object id',256)])}
export function safeLink(value,src,approvedOrigins=[]){
 if(!value)return null
 try {const u=new URL(value);return [source(src).instance,...approvedOrigins].includes(u.origin)&&u.protocol==='https:'&&!u.username&&!u.password?u.href:null}catch{return null}
}
export function text(value,max=32768){if(value==null)return '';if(typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>max)throw Error('Invalid external text');return value}
