/** Orbit rows reuse the ui-workspace CSS modules. The hash prefix changes per build, so
 * native-rows.js resolves it at runtime; this checks the local class names it reads exist in
 * every installed build: the dev one and, when present, the live rc.5 runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {existsSync} from 'node:fs'

const require=createRequire(import.meta.url)
const builds=[require.resolve('@deepseek-ai/dsh-client-ui-workspace/client'),process.env.KODE_LIVE_UI_WORKSPACE].filter(path=>path&&existsSync(path))

test('native-rows never hardcodes a CSS-module hash and every class it reads exists per build',async()=>{
 const rows=await readFile(new URL('../packages/collab/native-rows.js',import.meta.url),'utf8')
 assert.doesNotMatch(rows,/\b[A-Za-z0-9]{6}_(?:sessionRow|projectRow|groupSection)\b/,'no build hash in source')
 const rowNames=JSON.parse(/const ROW_NAMES = (\[[^\]]+\])/.exec(rows)[1].replaceAll("'",'"'))
 const listNames=[...(/const LIST_NAMES = \{([^}]+)\}/.exec(rows)[1]).matchAll(/'(\w+)'/g)].map(m=>m[1])
 assert.ok(rowNames.length>=20&&listNames.length>=6)
 for(const path of builds){
  const source=await readFile(path,'utf8')
  const css=tag=>{const id=`"@deepseek-ai/dsh-client-ui-workspace/${tag}"`,at=source.indexOf(id);assert.ok(at>0,tag+' injected by '+path);return source.slice(source.lastIndexOf('const css',at),at)}
  const rowsCss=css('Rows.module.css'),listCss=css('WorkspaceBrowser.module.css')
  assert.deepEqual(rowNames.filter(n=>!new RegExp(`\\.[A-Za-z0-9-]+_${n}\\b`).test(rowsCss)),[],path)
  assert.deepEqual(listNames.filter(n=>!new RegExp(`\\.[A-Za-z0-9-]+_${n}\\b`).test(listCss)),[],path)
 }
})
