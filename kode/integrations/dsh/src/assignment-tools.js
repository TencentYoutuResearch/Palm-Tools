import { validWriteRequest } from './assignment-write-tool.js'
import { validSourceRequest } from './assignment-source-tools.js'
import { validReviewRequest, validReviewShape } from './assignment-evidence-tools.js'
/** Trusted, per-Agent workflow tools. The frozen allow mask/grant still decides visibility and use. */
const id = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,120}$', minLength: 1, maxLength: 120 }
const definitions = [
  { name: 'kode_write_source', validate: validWriteRequest, capabilities: ['read', 'workspace_write'],
    description: 'Create or atomically replace a UTF-8 file within the assigned writable repository. Supply the SHA-256 from your last read, or null for a new file. Conflicts fail without overwriting. An already_present result observes desired bytes; it does not resolve an earlier uncertain tool call. No commit is performed.',
    properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, expected_sha256: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' }, content: { type: 'string', maxLength: 262144 } } },
  ...['kode_list_source', 'kode_read_source'].map(name => ({ name, validate: validSourceRequest, readOnlyErrors: true,
    description: name === 'kode_list_source' ? 'List a directory inside your assigned source workspace. Use path . for its root. Git metadata is excluded; symlinks cannot be followed.'
      : 'Read a UTF-8 source file inside your assigned workspace, returning its exact bytes hash. Relative paths only; no symlinks, Git metadata, binary files or files above 256 KiB.',
    properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } } })),
  { name: 'kode_capture_output', description: 'Capture and archive the current granted repository as a declared artifact output. The repository is fixed by the workflow; this does not commit code. Publish the returned evidence ID after home archival.',
    properties: { output: id, request_id: id } },
  { name: 'kode_review_output', description: 'Record your review verdict and findings against the exact frozen source artifact. A passed verdict cannot contain blocking findings. After Home archival, publish the returned evidence ID with kode_publish_output for this declared output. Only the Hub can pass the stage.',
    validate: validReviewRequest, validateShape: validReviewShape,
    properties: { output: id, request_id: id, verdict: { type: 'string', enum: ['passed', 'failed', 'inconclusive'] },
      findings: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false,
        properties: { id, blocking: { type: 'boolean' }, evidence_ref: id }, required: ['id', 'blocking', 'evidence_ref'] } } } },
  { name: 'kode_publish_output', description: 'Publish a declared stage output using this Worker\'s archived evidence ID. Publication does not pass the stage; the Hub checks the evidence. Published outputs cannot be replaced within this attempt.',
    properties: { output: id, evidence_id: { ...id, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]{1,160}$' } } },
  { name: 'kode_verify_output', description: 'Execute the trusted command configured for a verification output against its frozen source snapshot. Use a stable request_id; never rerun to recover an uncertain result. The result identifies evidence to publish after home archival.',
    properties: { output: id, request_id: id } },
]
export const assignmentToolNames = Object.freeze(definitions.map(definition => definition.name))
export function installAssignmentTools(ctx, agent, runtime, allowedNames = []) {
  if (!Array.isArray(allowedNames)) throw new Error('Explicit Assignment tool allow list required')
  const tools = ctx.get('tools').forScope(ctx), policies = ctx.get('kodeOfficialToolPolicies')
  const disposers = []
  try {
    for (const definition of definitions.filter(definition => allowedNames.includes(definition.name))) {
      const validateArguments = args => Boolean(args && Object.keys(args).sort().join(',') === Object.keys(definition.properties).sort().join(',')
        && (definition.validate ? definition.validate(args) : Object.entries(definition.properties).every(([key, schema]) => typeof args[key] === 'string'
          && new RegExp(schema.pattern).test(args[key]))))
      disposers.push(tools.register({ name: definition.name, description: definition.description,
        parameters: { type: 'object', additionalProperties: false, properties: definition.properties, required: Object.keys(definition.properties) },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async args => JSON.stringify(await runtime.executeAssignmentTool(agent, definition.name, args)),
      }))
      disposers.push(policies.register(definition.name, { capabilities: definition.capabilities ?? ['read'], network: false, workspaceLock: true,
        readOnlyErrors: definition.readOnlyErrors === true,
        implementation: tools.get(definition.name, agent),
        // Review validates only evidence argument shape. Source paths retain grant checks.
        // Extra authority fields still reach the original grant-denial path.
        ...(!definition.validate || definition.validateShape ? { validateArguments: args => !args
          || Object.keys(args).some(key => !Object.hasOwn(definition.properties, key))
          || (definition.validateShape ? definition.validateShape(args) : validateArguments(args)) } : {}),
        authorize: request => request.agent === agent && validateArguments(request.arguments),
      }, agent))
    }
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
