/** Explicit, pinned source transform of the native right Sidebar client (panel host scopes). Never modifies an installed package. */
import {createRequire} from 'node:module'
import {readFile,writeFile,copyFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {realpathSync} from 'node:fs'
import {buildPinnedClient} from './pinned-client-patch.js'
const require=createRequire(import.meta.url)
const out=new URL('../packages/sidebar-right/',import.meta.url)
const patchUrl=new URL('../patches/dsh-sidebar-right-0.2.1-rc.5/panel-host-scope.patch',import.meta.url)

/** Patched client source; any version, upstream or patch drift fails closed before anything is written. */
export async function buildSidebarRightClient({root=dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json')),patch}={}){
 return buildPinnedClient({root,lockUrl:new URL('upstream-lock.json',out),patch:patch??await readFile(patchUrl),label:'Sidebar right',
  from:'@deepseek-ai/dsh-client-ui-sidebar-right',to:'@kode/dsh-sidebar-right',command:'npm run build:sidebar-right'})
}

// CLI entry (paths compared after symlink resolution, e.g. macOS /var → /private/var).
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const client=await buildSidebarRightClient()
 await writeFile(new URL('client.js',out),client)
 await copyFile(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json')),'LICENSE'),new URL('LICENSE.upstream',out))
}
