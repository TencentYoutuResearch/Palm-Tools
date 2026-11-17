import {writeFileSync} from 'node:fs'
writeFileSync(process.env.KODE_CODEBUDDY_ARGV_LOG,JSON.stringify(process.argv.slice(2)))
await import('./fixture-acp-server.js')
