import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapperProviderEndpoint } from '../src/codex-wrapper-transport.js'

test('wrapper routing metadata skips opaque authentication and nested fields', () => {
  const definition = 'model_providers.fixture={name="Fixture",http_headers={base_url="https://example.com/ignored",Authorization="fixture-private-value"},base_url="http://127.0.0.1:4567/v1"}'
  assert.equal(wrapperProviderEndpoint([definition], 'fixture'), 'http://127.0.0.1:4567/v1/responses')
  assert.equal(wrapperProviderEndpoint([definition, 'model_providers.fixture.base_url="http://[::1]:7654/"'], 'fixture'), 'http://[::1]:7654/responses')
  assert.equal(wrapperProviderEndpoint(["model_providers.fixture={base_url='http://127.0.0.1:4567/',name='Fixture'}"], 'fixture'), 'http://127.0.0.1:4567/responses')
})

test('only the selected provider and a literal loopback route can establish transport', () => {
  for (const base of ['https://example.com/', 'http://example.com/', 'http://localhost:4567/',
    'http://fixture:private@127.0.0.1:4567/', 'http://127.0.0.1:4567/?key=fixture', 'http://127.0.0.1:4567/#fixture']) {
    assert.throws(() => wrapperProviderEndpoint([`model_providers.fixture={base_url=${JSON.stringify(base)}}`], 'fixture'))
  }
  assert.throws(() => wrapperProviderEndpoint(['model_providers.other={base_url="http://127.0.0.1:4567/"}'], 'fixture'))
  assert.throws(() => wrapperProviderEndpoint(['model_providers.fixture={http_headers={base_url="http://127.0.0.1:4567/"}}'], 'fixture'))
  for (const value of ['{} extra', '{base_url="http://127.0.0.1:4567/"', '{base_url="unterminated}', '{base_url=[]}']) {
    assert.throws(() => wrapperProviderEndpoint(['model_providers.fixture=' + value], 'fixture'))
  }
})
