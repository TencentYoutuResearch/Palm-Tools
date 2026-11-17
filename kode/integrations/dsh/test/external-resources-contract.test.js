import test from 'node:test'
import assert from 'node:assert/strict'
import {ReadonlyProvider, normalizeResponse} from '../src/external-integrations/providers.js'
import {objectKey, source} from '../src/external-integrations/identity.js'
import {tapdStory, tapdTask, tapdComment} from './support/tapd-contract-fixture.js'
const tapd = {provider: 'tapd', instance: 'https://tapd.example', resource: '100'}
const gongfeng = {provider: 'gongfeng', instance: 'https://git.example', resource: '42'}
const provider = (src, capabilities, readJson) => new ReadonlyProvider({source: src, authorizationRevision: 'contract-v1', capabilities, readJson})

for (const [kind, apiType] of [['story', 'stories'], ['task', 'tasks'], ['bug', 'bug']]) {
  test(`TAPD ${kind} comment uses the documented entry_type and exact parent`, async () => {
    let request
    const parent = {kind, id: '1'}
    const p = provider(tapd, ['comment'], async value => {request = value; return tapdComment({entry_type: apiType})})
    const result = await p.page('comment', {page: 2, parent})
    const url = new URL(request.path, request.origin)
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error')
    assert.equal(url.origin, tapd.instance); assert.equal(url.pathname, '/comments')
    assert.deepEqual(Object.fromEntries(url.searchParams), {workspace_id: '100', page: '2', limit: '100', entry_type: apiType, entry_id: '1'})
    assert.equal(result.objects[0].parent_key, objectKey(tapd, kind, '1'))
    assert.equal(result.objects[0].author, 'fixture_comment_author')
    assert.equal(result.objects[0].origin, 'external'); assert.equal(result.objects[0].trusted_instruction, false)
    assert.equal(result.objects[0].dispatch, 'disabled'); assert.equal(result.complete, false)
    assert.equal(result.compatibility, 'unverified-instance')
  })
  test(`TAPD ${kind} comment rejects cross-parent and cross-project attribution`, () => {
    const parent = {kind, id: '1'}
    for (const override of [{entry_id: 'other'}, {entry_type: kind === 'bug' ? 'stories' : 'bug'}, {workspace_id: '200'}]) {
      assert.throws(() => normalizeResponse(tapd, 'comment', tapdComment({entry_type: apiType, ...override}), {parent}), /(?:parent|project) mismatch/)
    }
    for (const entry_type of ['story', 'task', 'bug_remark', 'STORIES', 'wiki']) {
      assert.throws(() => normalizeResponse(tapd, 'comment', tapdComment({entry_type}), {parent}), /parent mismatch/)
    }
  })
}
for (const [kind, fixture, expected] of [['story', tapdStory, 'fixture_story_creator'], ['task', tapdTask, 'fixture_task_creator']]) {
  test(`TAPD ${kind} maps creator, not owner or guessed author aliases`, async () => {
    let request
    const p = provider(tapd, [kind], async value => {request = value; return fixture({author: 'wrong_alias', owner: 'current_assignee'})})
    const [row] = (await p.page(kind)).objects
    assert.equal(row.kind, kind); assert.equal(row.author, expected)
    assert.equal(new URL(request.path, request.origin).pathname, `/${kind === 'story' ? 'stories' : 'tasks'}`)
    assert.equal(normalizeResponse(tapd, kind, fixture({creator: null, author: 'not_a_documented_fallback'}))[0].author, '')
    assert.throws(() => normalizeResponse(tapd, kind, fixture({creator: {name: 'not_a_string'}})), /external text/)
    assert.throws(() => normalizeResponse(tapd, kind, fixture({workspace_id: '200'})), /project mismatch/)
  })
}
test('TAPD comment author is distinct from creator, and no unverified Bug mapping is invented', () => {
  assert.equal(normalizeResponse(tapd, 'comment', tapdComment({creator: 'wrong'}), {parent: {kind: 'story', id: '1'}})[0].author, 'fixture_comment_author')
  assert.equal(normalizeResponse(tapd, 'bug', {status: 1, data: [{Bug: {id: '1', workspace_id: '100', creator: 'wrong', reporter: 'unverified'}}]})[0].author, '')
})
test('TAPD rejects unsupported parent kinds before calling transport', async () => {
  let reads = 0
  const p = provider(tapd, ['comment'], async () => {reads++; return tapdComment()})
  for (const kind of ['stories', 'tasks', 'bug_remark', 'comment', 'wiki']) await assert.rejects(p.page('comment', {parent: {kind, id: '1'}}), /parent/)
  assert.equal(reads, 0)
})
test('non-comment resources reject parent attribution before transport and normalization', async () => {
  const cases = [
    [tapd, 'story', tapdStory()], [tapd, 'task', tapdTask()],
    [tapd, 'bug', {status: 1, data: [{Bug: {id: '1', workspace_id: '100'}}]}],
    ...['gongfeng', 'gitlab', 'github', 'gitea'].flatMap(name => ['issue', 'change_request'].map(kind => [
      {provider: name, instance: 'https://git.example', resource: name === 'gongfeng' ? '42' : 'owner/repo'},
      kind, [{id: 900, number: 7}],
    ])),
  ]
  let reads = 0
  for (const [src, kind, payload] of cases) {
    const p = provider(src, [kind], async () => {reads++; return payload})
    for (const parent of [{kind: 'task', id: '999'}, {}, false, 0, '']) {
      await assert.rejects(p.page(kind, {parent}), /Only comments accept a parent/)
      assert.throws(() => normalizeResponse(src, kind, payload, {parent}), /Only comments accept a parent/)
    }
  }
  assert.equal(reads, 0)
  for (const [src, kind, payload] of cases) {
    const p = provider(src, [kind], async () => payload)
    assert.equal((await p.page(kind, {parent: null})).objects[0].parent_key, null)
    assert.equal(normalizeResponse(src, kind, payload)[0].parent_key, null)
  }
})
test('Gongfeng rejects noncanonical project IDs before any transport call', async () => {
  let reads = 0
  for (const resource of ['team/repo', 'team%2Frepo', '042', '0', '-1', '42.0', ' 42']) {
    await assert.rejects(async () => provider({...gongfeng, resource}, ['issue'], async () => {reads++; return []}).page('issue'), /canonical numeric project ID/)
    assert.throws(() => source({...gongfeng, resource}), /canonical numeric project ID/)
  }
  assert.equal(reads, 0)
  assert.equal(source({...gongfeng, provider: 'gitlab', resource: 'team/repo'}).resource, 'team/repo')
})
for (const [kind, endpoint] of [['issue', 'issues'], ['change_request', 'merge_requests']]) {
  test(`Gongfeng ${kind} keeps v3 project ID scope and global object ID`, async () => {
    let request
    const p = provider(gongfeng, [kind], async value => {request = value; return [{id: 900, iid: 7, project_id: 42, title: 'Synthetic item', author: {name: 'fixture_author'}}]})
    const [row] = (await p.page(kind)).objects
    assert.equal(request.path, `/api/v3/projects/42/${endpoint}?page=1&per_page=100`)
    assert.equal(request.method, 'GET'); assert.equal(row.id, '900'); assert.equal(row.author, 'fixture_author')
    assert.throws(() => normalizeResponse(gongfeng, kind, [{id: 900, project_id: 99}]), /Repository mismatch/)
  })
}
