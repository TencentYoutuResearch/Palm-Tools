/** Bundle the released MIT directory browser with a distinct composition priority.
 * The UI itself is unchanged. The secondary seat permits the native Finder
 * interaction and the remote browser to coexist in one Host-switching shell.
 */
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
const appRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json'))
let source = await readFile(appRequire.resolve('@deepseek-ai/dsh-client-ui-directory-picker-browse/client'), 'utf8')
source = source.replaceAll('@deepseek-ai/dsh-client-ui-directory-picker-browse', '@kode/dsh-directory-browse')
for (const name of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
  const pattern = `name: "${name}",`
  if (source.split(pattern).length !== 2) throw new Error('Unsupported dsh directory browser: slot contract changed')
  source = source.replace(pattern, `${pattern}\n                    priority: 20,`)
}
await writeFile(new URL('../packages/directory-browse/client.js', import.meta.url), '// Generated from the MIT-licensed @deepseek-ai/dsh-client-ui-directory-picker-browse, 0.2.1-rc.2.\n// Run npm run build:directory-browse.\n' + source)
