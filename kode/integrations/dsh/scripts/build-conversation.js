/** Explicit, pinned source transform of the native Conversation client. Never modifies an installed package. */
import {createRequire} from 'node:module'
import {readFile,writeFile,copyFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {realpathSync} from 'node:fs'
import {buildPinnedClient} from './pinned-client-patch.js'
const require=createRequire(import.meta.url)
const out=new URL('../packages/conversation/',import.meta.url)
const patchUrl=new URL('../patches/dsh-conversation-0.2.1-rc.5/composer-root-ownership.patch',import.meta.url)

/** Patched client source; any version, upstream or patch drift fails closed before anything is written. */
export async function buildConversationClient({root=dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')),patch}={}){
 return buildPinnedClient({root,lockUrl:new URL('upstream-lock.json',out),patch:patch??await readFile(patchUrl),label:'Conversation',
  from:'@deepseek-ai/dsh-client-ui-conversation',to:'@kode/dsh-conversation',command:'npm run build:conversation'})
}

// CLI entry (paths compared after symlink resolution, e.g. macOS /var → /private/var).
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const client=await buildConversationClient()
 await writeFile(new URL('client.js',out),client)
 await copyFile(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')),'LICENSE'),new URL('LICENSE.upstream',out))
}
