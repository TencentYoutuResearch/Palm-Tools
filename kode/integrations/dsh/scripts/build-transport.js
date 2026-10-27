import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
const result = await build({ entryPoints: [new URL('../packages/transport/client-source.js', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2022' })
await writeFile(new URL('../packages/transport/client.js', import.meta.url), `// Generated from the public dsh Connection API; run npm run build:transport.\nwindow.__ModuleLoader__.load({id:'@kode/dsh-transport/client',factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports}})\n`)
