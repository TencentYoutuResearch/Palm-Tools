/** Shared fail-closed transform for pinned native clients (ui-conversation, ui-sidebar-right). Never modifies an installed package. */
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
const sha=x=>createHash('sha256').update(x).digest('hex')

/** Verify name, version, client and patch SHA-256 against the lock, apply in scratch, rename the loader identity. */
export async function buildPinnedClient({root,lockUrl,patch,label,from,to,command}){
 const lock=JSON.parse(await readFile(lockUrl,'utf8'))
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
 const source=await readFile(join(root,'lib/client.js'))
 if(manifest.name!==lock.name||manifest.version!==lock.version||sha(source)!==lock.clientSha256||sha(patch)!==lock.patchSha256)throw Error(`${label} upstream/patch lock mismatch; review and rebase explicitly before building`)
 const scratch=await mkdtemp(join(tmpdir(),'kode-pinned-client-build-'))
 try{
  await mkdir(join(scratch,'lib'))
  await writeFile(join(scratch,'lib/client.js'),source)
  execFileSync('git',['apply','--check','--unsafe-paths','-'],{cwd:scratch,input:patch})
  execFileSync('git',['apply','--unsafe-paths','-'],{cwd:scratch,input:patch})
  const result=await readFile(join(scratch,'lib/client.js'),'utf8')
  // Module loader identity is the wrapper; native services, slots and locale namespaces remain unchanged.
  const identity=`id: "${from}"`
  if(result.split(identity).length!==2)throw Error(`Pinned ${label} module identity changed`)
  return `// Generated from pinned dsh ${lock.name.replace('@deepseek-ai/dsh-client-','')} ${lock.version} (MIT) sha256 ${lock.clientSha256} + patch sha256 ${lock.patchSha256}. ${command}\n`
   +result.replace(identity,`id: "${to}"`)
 }finally{await rm(scratch,{recursive:true,force:true})}
}
