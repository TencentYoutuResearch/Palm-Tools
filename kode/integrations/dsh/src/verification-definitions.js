/** Immutable Host-local command configuration. Atomic publication never launches the command. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, open, readdir, link, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writePrivateJson } from './agent-profiles.js'
const name = row => createHash('sha256').update(JSON.stringify([row.definition.runner_id,row.definition.command_id,row.definition.revision])).digest('hex')+'.json'
async function directory(root){
 await mkdir(root,{recursive:true,mode:0o700})
 if(!(await lstat(root)).isDirectory())throw Error('Invalid verification storage')
 const path=join(root,'definitions');await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
 if(!(await lstat(path)).isDirectory())throw Error('Invalid verification definition storage')
 for(const dirPath of [root,dirname(root)]){const dir=await open(dirPath,'r');try{await dir.sync()}finally{await dir.close()}}
 return path
}
async function read(path,normalize){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>2*1048576)throw Error('Verification definition bounds')
  const saved=JSON.parse(await file.readFile('utf8'))
  if(saved.version!==1||Object.keys(saved).sort().join(',')!=='definition,reference,version')throw Error('Invalid stored verification definition')
  const row=normalize(saved.definition)
  if(!isDeepStrictEqual(row.reference,saved.reference)||!path.endsWith('/'+name(row)))throw Error('Verification definition integrity mismatch')
  return row
 }finally{await file.close()}
}
export async function loadVerificationDefinitions(root,normalize){
 const path=await directory(root),files=(await readdir(path)).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))
 const rows=[];for(const file of files)rows.push(await read(join(path,file),normalize))
 return rows
}
export async function persistVerificationDefinition(root,row,normalize){
 const path=await directory(root),final=join(path,name(row)),temporary=join(path,randomUUID()+'.pending')
 const saved={version:1,...row}
 if(Buffer.byteLength(JSON.stringify(saved))>2*1048576)throw Error('Verification definition bounds')
 // Fully synced private file becomes visible under its immutable name with link(2).
 // Competing writers cannot replace a different definition with the same identity.
 try{
  await writePrivateJson(temporary,saved)
  try{await link(temporary,final)}catch(error){if(error.code!=='EEXIST')throw error}
  const existing=await read(final,normalize)
  if(!isDeepStrictEqual(existing,row))throw Error('Verification definition revision is immutable')
  const dir=await open(path,'r');try{await dir.sync()}finally{await dir.close()}
  return existing
 }finally{await rm(temporary,{force:true})}
}
