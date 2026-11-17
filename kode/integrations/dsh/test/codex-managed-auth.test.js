import test from 'node:test'
import assert from 'node:assert/strict'
import { managedChatgptAuthPlan, validateOfficialCodexEndpoint, officialCodexResponsesEndpoint } from '../src/codex-managed-auth.js'
const gateBase = 'http://127.0.0.1:12345/kode-model/12345678-1234-1234-1234-123456789abc'

test('auth plan is inert, ephemeral and pinned to the existing gate contract', () => {
  const plan = managedChatgptAuthPlan({ gateBase })
  assert.equal(plan.endpoint, officialCodexResponsesEndpoint)
  assert.equal(plan.credentialPersistence, 'none')
  assert.equal(plan.readiness, 'requires_owner_confirmation_and_live_validation')
  assert.deepEqual(plan.login, { method: 'account/login/start', params: { type: 'chatgpt' } })
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.settings) && Object.isFrozen(plan.login.params))
  assert.ok(plan.settings.includes('cli_auth_credentials_store="ephemeral"'))
  const provider = plan.settings[2]
  for (const expected of [gateBase, 'requires_openai_auth=true', 'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=0']) assert.ok(provider.includes(expected))
  assert.equal(provider.includes(officialCodexResponsesEndpoint), false)
})

test('upstream destination rejects all alternate origins, routes and URL normalization tricks', () => {
  assert.equal(validateOfficialCodexEndpoint(officialCodexResponsesEndpoint), officialCodexResponsesEndpoint)
  for (const value of [null, new URL(officialCodexResponsesEndpoint), 'http://chatgpt.com/backend-api/codex/responses',
    'https://chatgpt.com.example/backend-api/codex/responses', 'https://chatgpt.com:443/backend-api/codex/responses',
    'https://user:secret@chatgpt.com/backend-api/codex/responses', officialCodexResponsesEndpoint + '?token=secret',
    officialCodexResponsesEndpoint + '#secret', officialCodexResponsesEndpoint + '/',
    'https://chatgpt.com/backend-api/codex/../codex/responses', 'https://chatgpt.com/backend-api/codex/%72esponses']) {
    assert.throws(() => validateOfficialCodexEndpoint(value), { message: 'Managed ChatGPT inference destination rejected' })
  }
})

test('gate configuration rejects remote destinations and secret-bearing URLs without echoing them', () => {
  for (const value of [undefined, 'http://localhost:12345/kode-model/test', gateBase + '?secret=value',
    gateBase.replace('127.0.0.1', 'example.com'), gateBase.replace('127.0.0.1', 'user:secret@127.0.0.1'),
    gateBase + '/responses', gateBase.replace('http:', 'https:')]) {
    assert.throws(() => managedChatgptAuthPlan({ gateBase: value }), { message: 'Managed ChatGPT gate rejected' })
  }
})

import { EventEmitter } from 'node:events'
import { loginManagedChatgpt } from '../src/codex-managed-auth.js'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'
const authorization = onLogin => ({ mode: 'ephemeral-chatgpt', confirmed: true, confirmationId: 'synthetic-confirmation', onLogin })
function fakeRpc(url = 'https://auth.openai.com/authorize?fixture=synthetic') {
  const rpc = new EventEmitter()
  rpc.stderr = 'synthetic diagnostic'
  rpc.request = async (method, params) => {
    assert.equal(method, 'account/login/start')
    assert.deepEqual(params, { type: 'chatgpt' })
    return { type: 'chatgpt', loginId: 'synthetic-login', authUrl: url, ignored: 'must-not-escape' }
  }
  return rpc
}

test('decision refuses missing current confirmation before process or gate creation', async () => {
  const decision = new CodexManagedDecision({ profile: { type: 'codex', executable: '/fixture/codex' }, cwd: '/fixture',
    stateRoot: '/fixture/state', model: 'fixture', chatgptAuth: { mode: 'ephemeral-chatgpt' }, admit: async () => {} })
  await assert.rejects(decision.prepare({ messages: [], tools: [] }), { code: 'managed_chatgpt_confirmation_required' })
  assert.equal(decision.authenticationState, 'awaiting_owner_confirmation')
  assert.equal(decision.rpc, undefined)
  assert.equal(decision.gate, undefined)
})

test('isolated official login passes only the verified URL and waits for matching completion', async () => {
  const rpc = fakeRpc(), stop = new AbortController()
  const result = await loginManagedChatgpt(rpc, authorization(async value => {
    assert.deepEqual(Object.keys(value), ['authUrl'])
    rpc.emit('notification', { method: 'account/login/completed', params: { loginId: 'foreign', success: true } })
    rpc.emit('notification', { method: 'account/login/completed', params: { loginId: 'synthetic-login', success: true } })
  }), stop.signal)
  assert.deepEqual(result, { mode: 'ephemeral-chatgpt', authenticated: true })
  assert.equal(rpc.stderr, '')
  assert.equal(rpc.listenerCount('notification'), 0)
})

test('login rejects nonofficial URLs without sending them to UI or echoing RPC detail', async () => {
  for (const url of ['http://auth.openai.com/authorize', 'https://auth.openai.com.example/authorize',
    'https://secret@chatgpt.com/authorize', 'https://chatgpt.com/authorize#secret']) {
    let shown = false
    await assert.rejects(loginManagedChatgpt(fakeRpc(url), authorization(() => { shown = true }), new AbortController().signal),
      { code: 'managed_chatgpt_login_failed', message: 'Managed ChatGPT login did not complete' })
    assert.equal(shown, false)
  }
})

test('cancellation settles a pending UI callback and removes login listeners', async () => {
  const rpc = fakeRpc(), stop = new AbortController()
  await assert.rejects(loginManagedChatgpt(rpc, authorization(() => {
    stop.abort()
    return new Promise(() => {})
  }), stop.signal), { code: 'managed_chatgpt_login_failed' })
  assert.equal(rpc.listenerCount('closed'), 0)
  assert.equal(rpc.listenerCount('notification'), 0)
})

import { CodexModelGate } from '../src/codex-model-gate.js'
test('synthetic auth crosses admission once, never follows an upstream redirect', async () => {
  const original = globalThis.fetch
  let admitted = 0, forwarded = 0
  const gate = new CodexModelGate({ endpoint: officialCodexResponsesEndpoint, model: 'fixture', tools: [],
    admit: async () => { admitted++ } })
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), officialCodexResponsesEndpoint)
    assert.equal(admitted, 1)
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.authorization, 'Bearer SYNTHETIC-NOT-A-CREDENTIAL')
    forwarded++
    return new Response('', { status: 302, headers: { location: 'https://example.com/leak' } })
  }
  try {
    const base = await gate.open()
    gate.bindThread('synthetic-thread')
    const response = await original(base + '/responses', { method: 'POST',
      headers: { authorization: 'Bearer SYNTHETIC-NOT-A-CREDENTIAL' }, body: JSON.stringify({ model: 'fixture', tools: [] }) })
    await response.text()
    assert.equal(gate.state, 'failed')
    assert.equal(forwarded, 1)
    assert.equal(JSON.stringify(gate.failureDetails).includes('SYNTHETIC-NOT-A-CREDENTIAL'), false)
  } finally { globalThis.fetch = original; await gate.close() }
})

import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('opt-in decision performs synthetic login in its isolated process before thread preparation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-auth-decision-')))
  const executable = join(root, 'synthetic-cli')
  await writeFile(executable, `#!${process.execPath}
const {createInterface}=require('node:readline');
const args=process.argv.slice(2);
if(!args.includes('cli_auth_credentials_store="ephemeral"') || !args.some(a=>a.includes('requires_openai_auth=true'))) process.exit(2);
if(process.env.HOME!==require('node:path').dirname(process.env.CODEX_HOME)) process.exit(3);
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let loggedIn=false;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='account/login/start'){send({id:m.id,result:{type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/authorize?fixture=synthetic'}});loggedIn=true;send({method:'account/login/completed',params:{loginId:'fixture-login',success:true}});}
else if(m.method==='thread/start' && loggedIn)send({id:m.id,result:{thread:{id:'fixture-auth-thread'},model:m.params.model,modelProvider:m.params.modelProvider,cwd:m.params.cwd,reasoningEffort:null,activePermissionProfile:{id:m.params.permissions}}});
else process.exit(4);});
`, { mode: 0o700 })
  let shown = 0, admitted = 0
  const decision = new CodexManagedDecision({ profile: { type: 'codex', executable }, cwd: root, stateRoot: root,
    model: 'fixture', chatgptAuth: authorization(() => { shown++ }), admit: async () => { admitted++ } })
  try {
    const config = await decision.prepare({ messages: [], tools: [] })
    assert.equal(config.native_thread_id, 'fixture-auth-thread')
    assert.equal(decision.authenticationState, 'authenticated_ephemeral')
    assert.equal(shown, 1)
    assert.equal(admitted, 0)
    assert.equal(decision.gate.forwarded, 0)
  } finally {
    const stopped = await decision.close()
    assert.equal(stopped.process_group_empty, true)
    await rm(root, { recursive: true, force: true })
  }
})

test('abort or process close during login response never invokes the login UI', async () => {
  for (const timing of ['abort', 'close']) {
    const rpc = fakeRpc(), stop = new AbortController(), original = rpc.request
    let shown = false
    rpc.request = async (...args) => {
      const value = await original(...args)
      if (timing === 'abort') stop.abort()
      else rpc.emit('closed')
      return value
    }
    await assert.rejects(loginManagedChatgpt(rpc, authorization(() => { shown = true; return new Promise(() => {}) }), stop.signal),
      { code: 'managed_chatgpt_login_failed' })
    assert.equal(shown, false)
    assert.equal(rpc.listenerCount('closed'), 0)
  }
})

import { RpcProcess } from '../src/rpc-process.js'
import { suppressManagedChatgptDiagnostics } from '../src/codex-managed-auth.js'
test('real spawned auth process never retains either stderr buffer, ordinary process keeps diagnostics', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-auth-stderr-')))
  const script = join(root, 'diagnostics.cjs')
  await writeFile(script, `process.stderr.write('SYNTHETIC-AUTH-MARKER');
const readline=require('node:readline').createInterface({input:process.stdin});
readline.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});
readline.on('close',()=>process.stderr.write('SYNTHETIC-LATE-MARKER'));
`)
  try {
    for (const auth of [false, true]) {
      const rpc = new RpcProcess({ executable: process.execPath, args: [script] }, root, { gracefulCloseMs: 1000 })
      if (auth) suppressManagedChatgptDiagnostics(rpc)
      try {
        await rpc.request('initialize', {})
        await new Promise(resolve => setTimeout(resolve, 30))
        for (const target of [rpc, rpc.process]) {
          if (auth) assert.equal(target.stderr, '')
          else assert.match(target.stderr, /SYNTHETIC-AUTH-MARKER/)
        }
      } finally { await rpc.close() }
      await new Promise(resolve => setTimeout(resolve, 30))
      for (const target of [rpc, rpc.process]) {
        if (auth) assert.equal(target.stderr, '')
        else assert.match(target.stderr, /SYNTHETIC-LATE-MARKER/)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
