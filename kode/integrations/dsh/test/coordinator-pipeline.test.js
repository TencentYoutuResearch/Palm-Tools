/** Run actual Coordinator input and workspace locks in the isolated native-capable runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for(const [recovery,automatic,blocked,transfer,ownerSetup,builderSetup] of [[false,false,false,false],[true,false,false,false],[false,true,false,false],[false,false,true,false],[false,false,false,true],[false,false,false,false,true],[false,false,false,false,true,true]])test(`native Coordinator automatically executes and reports pipeline (notification recovery=${recovery}, automatic startup=${automatic}, resource wait=${blocked}, control transfer=${transfer}, owner setup=${Boolean(ownerSetup)}, builder setup=${Boolean(builderSetup)})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  timeout: 115000,
}, async () => {
  const env = { ...process.env, KODE_TEST_COORDINATOR_UPDATE_RECOVERY:recovery?'1':'0', KODE_TEST_COORDINATOR_BOOTSTRAP:automatic?'1':'0',KODE_TEST_COORDINATOR_BLOCKED:blocked?'1':'0',KODE_TEST_COORDINATOR_TRANSFER:transfer?'1':'0',KODE_TEST_COORDINATOR_OWNER_SETUP:ownerSetup?'1':'0',KODE_TEST_COORDINATOR_BUILDER_SETUP:builderSetup?'1':'0' }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 110000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
  assert.match(stdout, /skipped 0/)
})
