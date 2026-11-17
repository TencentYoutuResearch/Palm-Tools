import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
test('team primary action preserves native slot and does not claim the session keyboard shortcut',async()=>{
 const helper=await readFile(new URL('../packages/collab/team-primary-action.js',import.meta.url),'utf8')
 assert.match(helper,/React\.cloneElement\(native/)
 assert.match(helper,/React\.cloneElement\(button/)
 assert.match(helper,/shortcutKeys: undefined/)
 assert.match(helper,/'aria-keyshortcuts': undefined/)
 const client=await readFile(new URL('../packages/collab/client-source.js',import.meta.url),'utf8')
 assert.match(client,/state\.mode==='im'\?teamPrimaryAction\(native,openBuilder\):native/)
 assert.match(client,/h\(Button, \{ variant: 'primary', onClick: openBuilder \}, '创建团队'\)/)
})
