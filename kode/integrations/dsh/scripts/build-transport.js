import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
const result = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: [new URL('../packages/transport/client-source.js', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2022', external: ['react', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'] })
await writeFile(new URL('../packages/transport/client.js', import.meta.url), `// Generated from the public dsh Connection API; run npm run build:transport.\nwindow.__ModuleLoader__.load({id:'@kode/dsh-transport/client',factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text.replace(/^\/\/ (?:.*\/)?node_modules\//gm, '// node_modules/')}\nreturn module.exports}})\n`)
