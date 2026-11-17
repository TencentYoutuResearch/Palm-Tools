import test from "node:test"
import assert from "node:assert/strict"
import { cursorManagedReadiness, CURSOR_PREFERRED_MODEL, CURSOR_INSPECTED_VERSION, CURSOR_PROTOCOL_EVIDENCE } from "../src/cursor-managed-readiness.js"

const catalog = ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]

test("listed preferred Gemini is discovery, never controlled inference", () => {
  const result = cursorManagedReadiness({ version: CURSOR_INSPECTED_VERSION, modelIds: catalog })
  assert.equal(result.preferredModel, CURSOR_PREFERRED_MODEL)
  assert.equal(result.preferredModelListed, true)
  assert.equal(result.installedVersionMatchesInspection, true)
  assert.equal(result.controlled, false)
  assert.equal(result.inferenceVerified, false)
  assert.equal(result.launchAllowed, false)
  assert.equal(result.status, "blocked")
  assert.equal(result.blockers.length, 5)
})

test("display names and alternate effort models cannot stand in for exact high id", () => {
  for (const modelIds of [[], ["Gemini 4 High"], ["gemini-4-argon-low"], ["gemini-4-argon-high-extra"]]) {
    const result = cursorManagedReadiness({ modelIds })
    assert.equal(result.preferredModelListed, false)
    assert.equal(result.blockers[0].code, "preferred_model_not_listed")
  }
})

test("new or missing versions do not inherit inspected-version assurance", () => {
  for (const version of [null, "future-version"]) {
    const result = cursorManagedReadiness({ version, modelIds: catalog })
    assert.equal(result.installedVersionMatchesInspection, false)
    assert.equal(result.controlled, false)
  }
})

test("caller flags cannot promote discovery into permission to launch", () => {
  const result = cursorManagedReadiness({ modelIds: catalog, controlled: true, launchAllowed: true, nativeToolsDisabled: true })
  assert.equal(result.controlled, false)
  assert.equal(result.launchAllowed, false)
  assert.ok(result.blockers.some(item => item.code === "local_native_tool_denial_unverified"))
})

test("readiness and evidence cannot be mutated to bypass blockers", () => {
  const result = cursorManagedReadiness({ modelIds: catalog })
  assert.throws(() => { result.controlled = true }, TypeError)
  assert.throws(() => result.blockers.pop(), TypeError)
  assert.throws(() => { result.blockers[0].code = "passed" }, TypeError)
  assert.throws(() => { CURSOR_PROTOCOL_EVIDENCE[0].observation = "safe" }, TypeError)
})

test("all unproven control boundaries remain explicit", () => {
  const result = cursorManagedReadiness({ modelIds: catalog })
  assert.deepEqual(result.blockers.map(item => item.code), [
    "local_native_tool_denial_unverified", "inference_admission_unimplemented",
    "provider_model_usage_unverified", "isolated_bootstrap_unverified", "owned_process_lifecycle_unverified",
  ])
  assert.match(result.evidence.find(item => item.id === "server_allowlist").observation, /not evidence of local execution denial/)
  assert.match(result.evidence.find(item => item.id === "model_identity").observation, /displayName/)
})

test("reject malformed or unbounded discovery input", () => {
  for (const input of [{ modelIds: "high" }, { modelIds: [null] }, { modelIds: Array(4097).fill("x") },
    { modelIds: ["x".repeat(513)] }, { version: {} }, { version: "x".repeat(129) }]) {
    assert.throws(() => cursorManagedReadiness(input), TypeError)
  }
})
