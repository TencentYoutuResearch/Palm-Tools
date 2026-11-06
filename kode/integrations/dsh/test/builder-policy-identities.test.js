import test from 'node:test'
import assert from 'node:assert/strict'
import { builderPolicyIdentities } from '../src/builder-policy-identities.js'
test('candidate policy names are stable, home/team scoped and bounded without creating authority', () => {
  const result = builderPolicyIdentities('home', 'candidate')
  assert.deepEqual(builderPolicyIdentities('home', 'candidate'), result)
  for (const alternative of [builderPolicyIdentities('other', 'candidate'), builderPolicyIdentities('home', 'other')]) {
    for (const key of Object.keys(result.proposed_policy_ids)) assert.notEqual(alternative.proposed_policy_ids[key], result.proposed_policy_ids[key])
  }
  assert.equal(result.configuration_created, false); assert.equal(result.eligible_for_execution, false)
  for (const id of Object.values(builderPolicyIdentities('h'.repeat(160), 't'.repeat(160)).proposed_policy_ids)) assert.match(id, /^[A-Za-z0-9_.:-]{1,160}$/)
  assert.throws(() => builderPolicyIdentities('home', '../team'))
})
