import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerificationRunners, verificationExecutableHash } from '../src/verification-runners.js'
const executable = await realpath(process.execPath), executableHash = await verificationExecutableHash(executable)
const define = (script, overrides = {}) => ({ runner_id: 'local', command_id: 'check', revision: '1', executable, executable_hash: executableHash,
  args: ['-e', script], env: { KODE_EXPLICIT_FIXTURE: 'explicit' }, timeout_ms: 2000, max_output_bytes: 8192, scenario_ids: ['smoke'], capabilities: ['read'], network: false, tool_id: 'verify', ...overrides })
const request = (command, cwd) => ({ request_id: 'run', command, cwd, operation: { id: 'op', attempt: 1, epoch: 1 }, source_sequence: 1, snapshot_hash: 'a'.repeat(64) })
test('verification executes once with explicit environment and replays durable observation after reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-verification-'))), cwd = join(root,'source'), storage = join(root,'runs')
  await mkdir(cwd)
  let runner = new VerificationRunners(storage)
  const marker = join(root,'count')
  let reopened
  const script = `const fs=require('node:fs');fs.appendFileSync(process.argv[1],'x');process.stdout.write(JSON.stringify({explicit:process.env.KODE_EXPLICIT_FIXTURE,parent:process.env.KODE_VERIFICATION_PARENT_FIXTURE??null}));process.stderr.write('fixture stderr')`
  const definition = define(script,{args:['-e',script,marker]})
  const previous = process.env.KODE_VERIFICATION_PARENT_FIXTURE
  process.env.KODE_VERIFICATION_PARENT_FIXTURE = 'must-not-inherit'
  try {
    const command = await runner.registerPersistent(definition), input = request(command,cwd)
    await runner.close(); runner = await new VerificationRunners(storage).open()
    assert.deepEqual(runner.reference('local','check','1'),command)
    assert.throws(() => runner.register({ ...definition,args:['-e','process.exit(9)'] }), /immutable/)
    await assert.rejects(runner.execute({ ...input, command:{...command,definition_hash:'b'.repeat(64)} },{authorize:async()=>true}), /binding mismatch/)
    const [a,b] = await Promise.all([runner.execute(input,{authorize:async()=>true}),runner.execute(input,{authorize:async()=>true})])
    assert.deepEqual(a,b); assert.equal(a.observed.passed,true); assert.equal(a.observed.exit_code,0); assert.equal(a.completion_authorized,false)
    const stdout = Buffer.concat(a.observed.output.filter(c=>c.stream==='stdout').map(c=>Buffer.from(c.data,'base64'))).toString()
    assert.deepEqual(JSON.parse(stdout),{explicit:'explicit',parent:null})
    assert.equal(await readFile(marker,'utf8'),'x')
    await runner.close(); reopened = await new VerificationRunners(storage).open()
    assert.deepEqual(await reopened.execute(input,{authorize:async()=>assert.fail('historical replay cannot execute')}),a)
    assert.equal(await readFile(marker,'utf8'),'x')
    await assert.rejects(reopened.execute({...input,snapshot_hash:'c'.repeat(64)},{authorize:async()=>true}),/identity conflict/)
    const state = join(storage,(await readdir(storage)).find(name=>/^[a-f0-9]{64}$/.test(name)),'state.json'), saved = JSON.parse(await readFile(state,'utf8'))
    const uncertain = structuredClone(saved)
    uncertain.result.observed.process_group_empty = false
    uncertain.result.observed.passed = false
    uncertain.result.observed.reason = 'stop_unconfirmed'
    uncertain.result_hash = createHash('sha256').update(JSON.stringify(uncertain.result)).digest('hex')
    await writeFile(state, JSON.stringify(uncertain))
    const observed = await reopened.execute(input, { authorize: async () => assert.fail('receipt replay cannot execute') })
    assert.equal(observed.observed.process_group_empty, false)
    assert.throws(() => reopened.assertStopped(input.operation), /stop unconfirmed/)
    assert.doesNotThrow(() => reopened.assertStopped({ ...input.operation, home_node: 'other' }))
    await writeFile(state,JSON.stringify({...saved,state:'launching'}))
    await assert.rejects(reopened.execute(input,{authorize:async()=>true}),/requires recovery/)
    assert.throws(() => reopened.assertStopped(input.operation), /stop unconfirmed/)
    assert.equal(await readFile(marker,'utf8'),'x')
  } finally { if(previous===undefined) delete process.env.KODE_VERIFICATION_PARENT_FIXTURE; else process.env.KODE_VERIFICATION_PARENT_FIXTURE=previous; await runner.close(); await reopened?.close(); await rm(root,{recursive:true,force:true}) }
})
test('verification records failure, bounded output, timeout and cancellation without passing', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'kode-verification-fault-')))
  try {
    for (const [mode,script,overrides] of [
      ['failure',`process.stderr.write('failed');process.exit(7)`,{}],
      ['output',`process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)`,{max_output_bytes:64}],
      ['timeout',`setInterval(()=>{},1000)`,{timeout_ms:50}],
      ['cancel',`require('node:fs').writeFileSync(process.argv[1],'started');setInterval(()=>{},1000)`,{}],
    ]) {
      const runner = new VerificationRunners(join(root,mode)), abort = new AbortController()
      const started = join(root,'started')
      const command = runner.register(define(script, mode === 'cancel' ? { ...overrides, args: ['-e',script,started] } : overrides))
      try {
        const running = runner.execute(request(command,root),{signal:abort.signal,authorize:async()=>true})
        if(mode==='cancel') {
          const deadline=Date.now()+5000
          while (!(await readFile(started,'utf8').catch(()=>null))) { assert.ok(Date.now()<deadline,'verification child started'); await new Promise(resolve=>setTimeout(resolve,10)) }
          abort.abort()
        }
        const result=await running
        assert.equal(result.observed.passed,false)
        assert.equal(result.observed.reason,({failure:'exited',output:'output_limit',timeout:'timeout',cancel:'cancelled'})[mode])
        if(mode==='failure') assert.equal(result.observed.exit_code,7)
        if(mode==='output') assert.equal(result.observed.output_bytes,64)
        assert.deepEqual(await runner.execute(request(command,root),{authorize:async()=>assert.fail('must not rerun')}),result)
      } finally { await runner.close() }
    }
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('verification refuses changed executable bytes and never retries its launch intent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'kode-verification-binary-')))
  const runner = new VerificationRunners(join(root,'runs'))
  try {
    const command = runner.register(define('process.exit(0)', { executable_hash: '0'.repeat(64) }))
    await assert.rejects(runner.execute(request(command,root),{authorize:async()=>true}),/executable identity mismatch/)
    await assert.rejects(runner.execute(request(command,root),{authorize:async()=>true}),/requires recovery/)
  } finally { await runner.close(); await rm(root,{recursive:true,force:true}) }
})

test('remote verification retains home identity and keeps equal operation IDs on different homes separate', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'kode-verification-home-'))), storage = join(root, 'runs'), marker = join(root, 'count')
  const script = "require('node:fs').appendFileSync(process.argv[1],'x')"
  const definition = define(script, { args: ['-e', script, marker] })
  let runner = new VerificationRunners(storage)
  try {
    const command = runner.register(definition), local = request(command, root)
    const input = home => ({ ...local, operation: { ...local.operation, home_node: home } })
    const first = await runner.execute(input('home-a'), { authorize: async () => true })
    assert.equal(first.operation.home_node, 'home-a')
    assert.equal(first.observed.passed, true)
    await runner.close(); runner = new VerificationRunners(storage); runner.register(definition)
    assert.deepEqual(await runner.execute(input('home-a'), { authorize: async () => assert.fail('must not rerun') }), first)
    assert.equal((await runner.execute(input('home-b'), { authorize: async () => true })).operation.home_node, 'home-b')
    assert.equal(await readFile(marker, 'utf8'), 'xx')
    await assert.rejects(runner.execute(input('../foreign'), { authorize: async () => true }), /Invalid verification execution request/)
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }) }
})
