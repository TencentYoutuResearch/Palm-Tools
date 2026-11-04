import test from 'node:test'
import assert from 'node:assert/strict'
import { repairOptionalPluginRecords } from '../src/repair-plugin-records.js'
test('optional Fast records retain all metadata and payloads while becoming readable', () => {
  const event = { type: 'plugin:kode/model-fast', seq: 17, time: 123, data: { provider: 'fixture', model: 'fixture', fast: true } }
  const input = [event], result = repairOptionalPluginRecords(input)
  assert.deepEqual(result.events, [{ ...event, ignorable: true }])
  assert.equal(event.ignorable, undefined)
  assert.equal(result.events[0].data, event.data)
  assert.deepEqual(repairOptionalPluginRecords(result.events).changes, [])
})
test('unknown extension and core events are never silently made ignorable', () => {
  const events = [{ type: 'plugin:other/unknown', seq: 0 }, { type: 'unknown/core-event', seq: 1 }]
  const result = repairOptionalPluginRecords(events)
  assert.equal(result.events, events)
  assert.deepEqual(result.changes, [])
})
