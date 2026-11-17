import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { interactiveDmScope, existingInteractiveDms, readInteractiveDms, selectInteractiveDm, primaryInteractiveDm, openPrimaryInteractiveDm } from '../packages/collab/interactive-team-dm.js'

const scope = { home_hub: 'home', host_id: 'host', workspace_id: 'work', root_ref: '/project' }
const team = { id: 'team', home_hub: 'home', revision: 1, conversation_id: 'legacy', spec: { execution_mode: 'interactive_native', workspace_refs: [scope] } }
const dm = { id: 'original-dm', scope, kind: 'dm', enabled: true, revision: 2, audience_revision: 1, team_ids: ['team'], title: 'Native DM' }
const page = items => ({ scope, items })

test('only exact workspace enabled private surfaces for this single team are eligible', () => {
  const candidates = [dm, { ...dm, id: 'another-dm' }, { ...dm, id: 'channel', kind: 'channel' }, { ...dm, id: 'disabled', enabled: false }, { ...dm, id: 'other', team_ids: ['other'] }, { ...dm, id: 'shared', team_ids: ['team', 'other'] }]
  assert.deepEqual(existingInteractiveDms(team, scope, page(candidates)).map(row => row.id), ['original-dm', 'another-dm'])
  assert.notEqual(dm.id, team.conversation_id)
  for (const changed of [{ home_hub: 'other' }, { host_id: 'other' }, { workspace_id: 'other' }, { root_ref: '/other' }]) {
    assert.throws(() => interactiveDmScope(team, { ...scope, ...changed }))
    assert.throws(() => existingInteractiveDms(team, scope, { ...page([dm]), scope: { ...scope, ...changed } }))
    assert.throws(() => existingInteractiveDms(team, scope, page([{ ...dm, scope: { ...scope, ...changed } }])))
  }
  assert.throws(() => interactiveDmScope({ ...team, spec: { ...team.spec, execution_mode: 'managed' } }, scope))
  assert.throws(() => interactiveDmScope(team, null))
})

test('existing directory cannot provide malformed versions or ambiguous ids', () => {
  for (const change of [{ id: '../channel' }, { revision: 0 }, { audience_revision: 0 }]) assert.throws(() => existingInteractiveDms(team, scope, page([{ ...dm, ...change }])))
  assert.throws(() => existingInteractiveDms(team, scope, page([dm, dm])))
  assert.throws(() => existingInteractiveDms(team, scope, { scope }))
})

test('opening requires explicit choice and re-reads exact scope without writing or moving a draft', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return page([dm]) }
  assert.deepEqual(await readInteractiveDms({ team, scope, request }), [dm])
  assert.equal(calls.length, 1)
  await assert.rejects(selectInteractiveDm({ team, scope, surfaceId: '', request }))
  assert.equal(calls.length, 1, 'blank choice never defaults to the sole result')
  const result = await selectInteractiveDm({ team, scope, surfaceId: dm.id, request })
  assert.deepEqual(result, { scope, surface: dm, thread: null })
  for (const call of calls) { assert.equal(call[0], 'surfaces'); assert.deepEqual(call[1], scope); assert.equal(call[2], undefined) }
  await assert.rejects(selectInteractiveDm({ team, scope, surfaceId: dm.id, request: async () => page([{ ...dm, enabled: false }]) }))
  await assert.rejects(selectInteractiveDm({ team, scope, surfaceId: dm.id, request: async () => page([{ ...dm, team_ids: ['other'] }]) }))
})

test('scope navigation or cancellation discards late directory responses, even if transport ignores abort', async () => {
  let resolve, calls = 0
  const controller = new AbortController()
  const pending = selectInteractiveDm({ team, scope, surfaceId: dm.id, signal: controller.signal, request: () => { calls++; return new Promise(done => { resolve = done }) } })
  controller.abort(); resolve(page([dm]))
  await assert.rejects(pending, /Disposed/)
  await assert.rejects(readInteractiveDms({ team, scope, signal: controller.signal, request: () => { calls++; return page([dm]) } }), /Disposed/)
  assert.equal(calls, 1)
})

test('team rows open the primary native DM directly and never render the legacy jump page', async () => {
  const client = await readFile(new URL('../packages/collab/client-source.js', import.meta.url), 'utf8')
  const discussions = await readFile(new URL('../packages/collab/discussion-ui.js', import.meta.url), 'utf8')
  assert.match(client, /discussions\.openTeamDm\(team,scope,tab\)/)
  assert.match(client, /discussions\.openTeamDm\(nativeTeam, state\.workspace\)/)
  assert.ok(client.indexOf("if (nativeTeam) return") < client.indexOf("if (team) return h(Conversation"), 'restored interactive teams never render the legacy Conversation')
  assert.match(client, /正在打开团队私信…/)
  assert.doesNotMatch(client, /InteractiveTeamDmEntry|TAPD 和工蜂资源在项目频道查看/)
  assert.match(discussions, /openPrimaryInteractiveDm\(\{team,scope,storage\}\)/)
  assert.match(discussions, /label:'设置'/)
  assert.match(discussions, /tools:recipientPicker,trailing:modelPicker/)
  assert.match(discussions, /dmTeam\?\.spec\?\.name\|\|surface\.title/)
  assert.match(discussions, /label:'更多对话操作'/)
  assert.match(discussions, /onOpenTeamDm\?\.\(team,target\.scope\)/)
  assert.match(client, /navigation\.selectMode\('im'\); ctx\.layout\.selectPanel\('kode-collab'\)/)
  assert.doesNotMatch(discussions, /kode-discussion-context-actions/)
  assert.doesNotMatch(discussions, /h\('select'|CLI \/ 模型组合/)
})

test('primary native DM reuses the latest surface or creates one idempotently', async () => {
  const latest={...dm,id:'latest',updated_at:'2026-02-01T00:00:00Z'}
  assert.equal(primaryInteractiveDm([dm,{...dm,id:'newer'}]).id,'newer')
  assert.equal(primaryInteractiveDm([dm,latest]).id,'latest')
  const writes=new Map(),storage={getItem:key=>writes.get(key)??null,setItem:(key,value)=>writes.set(key,value),removeItem:key=>writes.delete(key)}
  let posted
  const request=async(path,query,body)=>{
    if(path==='surfaces')return page([])
    posted={path,body};return {...dm,id:path.split('/')[1],revision:1,title:body.title}
  }
  const target={...team,spec:{...team.spec,name:'前端团队'}}
  const result=await openPrimaryInteractiveDm({team:target,scope,storage,request})
  assert.equal(result.surface.id,posted.path.split('/')[1]);assert.equal(posted.body.expected_revision,0);assert.deepEqual(posted.body.team_ids,['team']);assert.equal(posted.body.title,'前端团队')
  assert.equal(writes.size,0,'confirmed creation clears the pending record')
  const existing=await openPrimaryInteractiveDm({team:target,scope,storage,request:async()=>page([dm,latest])})
  assert.equal(existing.surface.id,'latest')
})
