/** Resolve pinned review links with the viewing Host's existing provider access. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { RpcProcess } from './rpc-process.js'

const exec = promisify(execFile)
const project = '[A-Za-z0-9_-][A-Za-z0-9_.-]*'
const github = new RegExp('^https://github\\.com/('+project+'/'+project+')/pull/([1-9]\\d{0,9})$')
const gongfeng = new RegExp('^https?://git\\.woa\\.com/('+project+'(?:/'+project+')+?)/(?:-/)?merge_requests/([1-9]\\d{0,9})$')

async function githubToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  try { return (await exec('gh',['auth','token','--hostname','github.com'],{timeout:3000})).stdout.trim() } catch {}
  // git credential fill reads the request on stdin. Never pass credentials through argv or the renderer.
  return new Promise(resolve => {
    const child = spawn('git',['-c','credential.interactive=false','credential','fill'],{
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_ASKPASS:'/usr/bin/false'},
      stdio:['pipe','pipe','ignore'],timeout:3000,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.on('error', () => resolve(undefined))
    child.stdin.on('error', () => {})
    child.on('close', code => resolve(code === 0 ? /^password=(.+)$/m.exec(output)?.[1] : undefined))
    child.stdin.end('protocol=https\nhost=github.com\n\n')
  })
}

async function readGithub(githubRefs, statuses) {
  if (!githubRefs.length) return
  const token = await githubToken()
  await Promise.allSettled(githubRefs.map(async ([url, repo, number]) => {
    const res = await fetch('https://api.github.com/repos/'+repo+'/pulls/'+number,{
      headers:token ? {Authorization:'Bearer '+token} : {}, redirect:'error',signal:AbortSignal.timeout(8000),
    })
    if (!res.ok) return
    const row = await res.json()
    if (String(row.number) !== number) return
    if (row.merged_at) statuses[url]='merged'
    else if (row.state === 'closed') statuses[url]='closed'
    else if (row.state === 'open') statuses[url]=row.draft ? 'draft' : 'open'
  }))
}

async function readGongfeng(mrRefs, statuses) {
  if (!mrRefs.length) return
  // A transient read-only MCP client; no model turn or durable conversation.
  const rpc = new RpcProcess({executable:'codex'},homedir())
  try {
    await rpc.request('initialize',{clientInfo:{name:'kode-review',version:'1'},capabilities:{experimentalApi:true}})
    rpc.notify('initialized',{})
    const {thread} = await rpc.request('thread/start',{cwd:homedir(),ephemeral:true,approvalPolicy:'never',sandbox:'read-only'})
    await Promise.allSettled(mrRefs.map(async ([url,repo,iid]) => {
      const result = await rpc.request('mcpServer/tool/call',{threadId:thread.id,server:'gongfeng',tool:'search_merge_request',
        arguments:{project_id:repo,iid:Number(iid),per_page:1}})
      if (result.isError) return
      const rows = result.structuredContent ?? JSON.parse(result.content.find(b=>b.type==='text').text)
      const row = rows.find(r=>String(r.iid)===iid)
      if (row?.state==='merged' || row?.state==='closed') statuses[url]=row.state
      else if (['open','opened','reopened'].includes(row?.state)) statuses[url]=row.draft || row.work_in_progress ? 'draft' : 'open'
    }))
  } finally { await rpc.close() }
}

export async function lookupReviews(urls) {
  const statuses = {}, githubRefs = [], mrRefs = []
  for (const url of urls) {
    const pr = github.exec(url), mr = gongfeng.exec(url)
    if (pr) githubRefs.push(pr)
    if (mr) mrRefs.push(mr)
  }
  await Promise.allSettled([readGithub(githubRefs, statuses), readGongfeng(mrRefs, statuses)])
  return statuses
}

export function registerReviewStatusApi(ctx, lookup = lookupReviews) {
  const cache = new Map()
  return ctx.webServer.register({kind:'exact',path:'/api/kode/review-status',handler:async(req,res)=>{
    const admission=ctx.connection.admit(req)
    const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))}
    if ('rejection' in admission || admission.peer.principal.kind!=='owner') return send(403,{})
    if (req.method!=='GET') return send(405,{})
    const urls=[...new Set(new URL(req.url,'http://localhost').searchParams.getAll('url'))]
    if (urls.length>20 || urls.some(u=>u.length>1024 || !(github.test(u)||gongfeng.test(u)))) return send(400,{})
    const now=Date.now()
    const stale=urls.filter(u=>!cache.has(u)||cache.get(u).until<=now)
    if (stale.length) {
      const batch=lookup(stale).catch(() => ({}))
      for (const u of stale) {
        const entry={until:Infinity}
        entry.result=batch.then(rows=>{
          if(rows[u]) entry.status=rows[u]
          entry.until=Date.now()+(rows[u]==='merged'?86400000:rows[u]?60000:15000)
          return entry.status
        })
        entry.status=cache.get(u)?.status
        cache.delete(u);cache.set(u,entry)
      }
    }
    const result=Object.fromEntries(await Promise.all(urls.map(async u=>[u,await cache.get(u).result])))
    if(cache.size>512) for(const [u,e] of cache){if(e.until!==Infinity) cache.delete(u);if(cache.size<=512)break}
    send(200,result)
  }})
}
