/** Explicit, pinned source transform. Never modifies an installed package. */
import {createRequire} from 'node:module'
import {readFile,writeFile,copyFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
const require=createRequire(import.meta.url)
const root=dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json'))
const out=new URL('../packages/sidebar/',import.meta.url)
const lock=JSON.parse(await readFile(new URL('upstream-lock.json',out),'utf8'))
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const source=await readFile(join(root,'lib/client.js'))
const patch=await readFile(new URL('../patches/dsh-sidebar-0.2.1-rc.5/brand-controls.patch',import.meta.url))
const sha=x=>createHash('sha256').update(x).digest('hex')
if(manifest.name!==lock.name||manifest.version!==lock.version||sha(source)!==lock.clientSha256||sha(patch)!==lock.patchSha256)throw Error('Sidebar upstream/patch lock mismatch; review and rebase explicitly before building')
const scratch=await mkdtemp(join(tmpdir(),'kode-sidebar-build-'))
try{
 await mkdir(join(scratch,'lib'))
 await writeFile(join(scratch,'lib/client.js'),source)
 execFileSync('git',['apply','--check','--unsafe-paths','-'],{cwd:scratch,input:patch})
 execFileSync('git',['apply','--unsafe-paths','-'],{cwd:scratch,input:patch})
 let result=await readFile(join(scratch,'lib/client.js'),'utf8')
 // Module loader identity is the wrapper; native slot/locale namespaces remain unchanged.
 result=result.replace('id: "@deepseek-ai/dsh-client-ui-sidebar"','id: "@kode/dsh-sidebar"')
 await writeFile(new URL('client.js',out),'// Generated from pinned dsh sidebar (MIT). npm run build:sidebar\n'+result)
 await copyFile(join(root,'LICENSE'),new URL('LICENSE.upstream',out))
}finally{await rm(scratch,{recursive:true,force:true})}
