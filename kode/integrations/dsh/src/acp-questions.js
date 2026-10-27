/** ACP form elicitation → dsh's existing question UI, validated with the official MCP validator. */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
const validator = new AjvJsonSchemaValidator()
function optionsFor(schema) {
  const source = schema.type === 'array' ? schema.items : schema
  const values = source?.oneOf ?? source?.anyOf ?? source?.enum?.map(value => ({ const: value })) ?? (source?.type === 'boolean' ? [{ const: true }, { const: false }] : [])
  return values.map(v => ({ value: v.const, label: v.title ?? String(v.const), ...(v.description ? { description: v.description } : {}) }))
}
export async function askAcpForm(request, ask, signal) {
  if (request.mode !== 'form') return { action: 'cancel' }
  const schema = request.requestedSchema, fields = Object.entries(schema.properties ?? {})
  const companions = new Map(fields.filter(([id, spec]) => id.endsWith('_custom') && spec.type === 'string' && Object.hasOwn(schema.properties, id.slice(0, -7))).map(([id]) => [id.slice(0, -7), id]))
  const displayed = fields.filter(([id]) => ![...companions.values()].includes(id))
  if (!displayed.length) {
    const result = await ask({ structured: true, questions: [{ id: 'consent', question: request.message, options: [{ label: 'Accept' }, { label: 'Decline' }] }] }, signal)
    return result?.answers.consent?.answers.includes('Accept') ? { action: 'accept', content: {} } : { action: 'decline' }
  }
  const choices = new Map(displayed.map(([id, spec]) => [id, optionsFor(spec)]))
  const result = await ask({ structured: true, questions: displayed.map(([id, spec]) => ({ id, question: spec.description ?? spec.title ?? request.message,
    ...(spec.title ? { header: spec.title } : {}), ...(spec.type === 'array' ? { multiSelect: true } : {}),
    ...(choices.get(id).length ? { options: choices.get(id).map(({ label, description }) => ({ label, ...(description ? { description } : {}) })) } : {}),
  })) }, signal)
  if (!result) return { action: 'cancel' }
  const content = Object.create(null)
  for (const [id, spec] of displayed) {
    const answer = result.answers[id]
    if (!answer) continue
    const listed = choices.get(id), selected = answer.selected ?? answer.answers.filter(v => listed.some(o => o.label === v))
    const custom = answer.custom ?? answer.answers.filter(v => !listed.some(o => o.label === v)).join('\n')
    if (listed.length) {
      const values = selected.map(label => listed.find(o => o.label === label)?.value)
      if (values.some(v => v === undefined)) return { action: 'cancel' }
      if (spec.type === 'array') content[id] = values
      else if (values.length === 1) content[id] = values[0]
      if (custom) { if (!companions.has(id)) return { action: 'cancel' }; content[companions.get(id)] = custom }
    } else if (custom || answer.answers.length) {
      const value = custom || answer.answers.join('\n')
      content[id] = ['number', 'integer'].includes(spec.type) ? Number(value) : value
    }
  }
  const checked = validator.getValidator(schema)(content)
  return checked.valid ? { action: 'accept', content } : { action: 'cancel' }
}
