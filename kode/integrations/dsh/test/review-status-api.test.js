import test from 'node:test'
import assert from 'node:assert/strict'
import { registerReviewStatusApi } from '../src/review-status-api.js'

test('only owners can refresh supported links; concurrent cards share lookups and preserve the original URL', async () => {
  const calls = []
  const statuses = {
    'https://github.com/example/project/pull/86':'merged',
    'https://github.com/example/project/pull/88':'open',
    'https://git.woa.com/team/project/-/merge_requests/119':'merged',
  }
  const api = registerReviewStatusApi({
    webServer:{ register:route => route },
    connection:{ admit:req => ({peer:{principal:{kind:req.kind}}}) },
  }, async urls => { calls.push(urls); return statuses })
  const request = (urls,kind='owner') => new Promise(resolve => {
    let status
    api.handler({method:'GET',kind,url:'/?'+new URLSearchParams(urls.map(url=>['url',url]))},
      {writeHead:code=>{status=code},end:body=>resolve([status,JSON.parse(body)])})
  })
  const urls=Object.keys(statuses)
  assert.deepEqual(await request(urls,'guest'),[403,{}])
  assert.deepEqual(await request(['https://git.example.org/a/b/pull/1']),[400,{}])
  const results=await Promise.all([request(urls),request(urls)])
  for(const result of results) assert.deepEqual(result,[200,statuses])
  assert.deepEqual(calls,[urls])
})
