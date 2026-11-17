/**
 * Cursor discovery is not managed inference admission. This module never starts
 * a CLI, reads authentication, grants a lease, or enables managedNative.
 * Evidence below was inspected offline in Cursor 2026.10.22-27dcf5f.
 */
export const CURSOR_PREFERRED_MODEL = "gemini-4-argon-high"
export const CURSOR_INSPECTED_VERSION = "2026.10.22-27dcf5f"

export const CURSOR_PROTOCOL_EVIDENCE = Object.freeze([
  Object.freeze({ id: "native_tools", source: "cursor-agent --help",
    observation: "--print has all native tools; ask/plan read-only is not tool-free execution." }),
  Object.freeze({ id: "server_allowlist", source: "8008.index.js: src/utils/exclude-tools{,-headers}.ts; index.js: constants/cloud-agent.js",
    observation: "Empty --allowed-tools parses as [] and becomes x-cursor-agent-allowed-tools: an empty header. This is not evidence of local execution denial." }),
  Object.freeze({ id: "model_identity", source: "8008.index.js: headless system.init and result emitters",
    observation: "system.init model is displayName; success result has optional usage and no returned exact model slug." }),
  Object.freeze({ id: "configuration", source: "index.js: workspace path helpers and CLI options",
    observation: "CURSOR_CONFIG_DIR, CURSOR_DATA_DIR and hidden --exclude-workspace-context exist. Their presence does not prove hooks, MCP, credentials or all context are isolated." }),
])

const blockers = Object.freeze([
  Object.freeze({ code: "local_native_tool_denial_unverified", required: "A local deny-all native execution boundary, including read, shell, MCP and delegated tools, tested against hostile server tool requests." }),
  Object.freeze({ code: "inference_admission_unimplemented", required: "A protocol-aware gate admitting each exact model-bearing inference against the current Host lease before upstream forwarding; retries must not bypass admission." }),
  Object.freeze({ code: "provider_model_usage_unverified", required: "Provider response evidence binding the exact model and complete usage to the admitted request, rejecting missing or conflicting fields." }),
  Object.freeze({ code: "isolated_bootstrap_unverified", required: "A supported existing-auth bootstrap without copying secrets or inheriting daily hooks, MCP, plugins, workspace rules or session state." }),
  Object.freeze({ code: "owned_process_lifecycle_unverified", required: "Owned process-group cancellation, bounded output, timeout and close evidence before releasing Host actions." }),
])

/**
 * Input is a discovery snapshot supplied by the caller, not verified inference.
 * Catalog rows must contain exact ids, never display-name or substring matches.
 * There is deliberately no boolean override or readiness promotion mechanism.
 */
export function cursorManagedReadiness({ version = null, modelIds = [] } = {}) {
  if (version !== null && (typeof version !== "string" || version.length > 128)) throw new TypeError("Invalid Cursor version")
  if (!Array.isArray(modelIds) || modelIds.length > 4096 || modelIds.some(id => typeof id !== "string" || id.length > 512)) {
    throw new TypeError("Expected bounded exact Cursor model ids")
  }
  const preferredModelListed = modelIds.includes(CURSOR_PREFERRED_MODEL)
  const catalogBlockers = preferredModelListed ? [] : [Object.freeze({
    code: "preferred_model_not_listed", required: "Read the current account model catalog and find the exact preferred model id.",
  })]
  return Object.freeze({
    provider: "cursor", preferredModel: CURSOR_PREFERRED_MODEL,
    preferredModelListed, catalogBasis: "caller_supplied_discovery_snapshot",
    version, inspectedVersion: CURSOR_INSPECTED_VERSION,
    installedVersionMatchesInspection: version === CURSOR_INSPECTED_VERSION,
    controlled: false, inferenceVerified: false, launchAllowed: false,
    status: "blocked", blockers: Object.freeze([...catalogBlockers, ...blockers]),
    evidence: CURSOR_PROTOCOL_EVIDENCE,
  })
}
