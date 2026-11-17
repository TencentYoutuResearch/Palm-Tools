import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, realpath, readdir, stat, rename, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivatePlanningLocation, assertPrivatePlanningLocation } from '../src/planning-private-directory.js'
import { validatePlanningBinding } from '../src/native-planning-session.js'
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-planning-location-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = { profilesPath: join(root, 'profiles.json'), home: 'fixture', draftId: 'draft', sessionId: 'session-11111111-1111-4111-8111-111111111111' }
  const makeBinding = location => validatePlanningBinding({ version: 1, mode: 'interactive_planning', home_hub: input.home, draft_id: input.draftId, context_epoch: 1, session_id: input.sessionId, ...location })
  return { root, input, makeBinding }
}
test('private cwd is fresh, empty, owner-only and inside existing application data', async t => {
  const f = await fixture(t), location = await createPrivatePlanningLocation(f.input), binding = f.makeBinding(location)
  assert.equal(location.workspace_id, null); assert.deepEqual(await readdir(location.cwd), [])
  assert.equal((await stat(location.cwd)).mode & 0o777, 0o700)
  assert.equal((await stat(join(f.root, 'planning-sessions'))).mode & 0o777, 0o700)
  assert.equal(await assertPrivatePlanningLocation(binding, f.input.profilesPath), location.cwd)
  await assert.rejects(createPrivatePlanningLocation(f.input), { code: 'PLANNING_DIRECTORY_UNAVAILABLE' })
})
test('missing or replaced planning directories are never recreated or rebound', async t => {
  const f = await fixture(t), location = await createPrivatePlanningLocation(f.input), binding = f.makeBinding(location)
  await rename(location.cwd, location.cwd + '.original')
  await assert.rejects(assertPrivatePlanningLocation(binding, f.input.profilesPath), { code: 'PLANNING_DIRECTORY_CHANGED' })
  await mkdir(location.cwd, { mode: 0o700 })
  await assert.rejects(assertPrivatePlanningLocation(binding, f.input.profilesPath), /replaced/)
})
test('symlinked or shared planning roots are rejected without home fallback', async t => {
  const f = await fixture(t), alternate = join(f.root, 'other')
  await mkdir(alternate, { mode: 0o700 }); await symlink(alternate, join(f.root, 'planning-sessions'))
  await assert.rejects(createPrivatePlanningLocation(f.input), { code: 'PLANNING_DIRECTORY_CHANGED' })
  assert.deepEqual(await readdir(alternate), [])
  const g = await fixture(t), sharedRoot = join(g.root, 'planning-sessions')
  await mkdir(sharedRoot, { mode: 0o755 })
  // A restrictive process umask must not turn this rejected fixture into a valid private directory.
  await chmod(sharedRoot, 0o755)
  assert.equal((await stat(sharedRoot)).mode & 0o777, 0o755)
  await assert.rejects(createPrivatePlanningLocation(g.input), { code: 'PLANNING_DIRECTORY_CHANGED' })
  await assert.rejects(createPrivatePlanningLocation({ ...g.input, profilesPath: undefined }), { code: 'PLANNING_DIRECTORY_UNAVAILABLE' })
})
test('private location identity cannot be attached to a different draft or workspace', async t => {
  const f = await fixture(t), location = await createPrivatePlanningLocation(f.input), binding = f.makeBinding(location)
  await assert.rejects(assertPrivatePlanningLocation({ ...binding, draft_id: 'other' }, f.input.profilesPath), { code: 'PLANNING_DIRECTORY_CHANGED' })
  assert.throws(() => validatePlanningBinding({ ...binding, workspace_id: 'project' }))
  assert.throws(() => validatePlanningBinding({ ...binding, location: { ...binding.location, inode: 1 } }))
})
