/** Session-local Fast preferences; canonical model selection remains upstream-compatible. */
import { z } from 'zod'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

const preferenceSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), fast: z.boolean(), serviceTier: z.string().min(1).optional() })
const schema = z.object({ preferences: z.array(preferenceSchema) })
const sameRoute = (row, selection) => row.provider === selection?.provider && row.model === selection?.model

export const fastProjection = {
  key: 'kodeFast', stateVersion: 1, stateSchema: schema,
  init: () => ({ preferences: [] }),
  apply: (state, event) => {
    if (event.type !== 'plugin:kode/model-fast') return state
    const row = event.data
    if (typeof row?.provider !== 'string' || typeof row?.model !== 'string' || typeof row?.fast !== 'boolean' || row.serviceTier !== undefined && typeof row.serviceTier !== 'string') return state
    return { preferences: [...state.preferences.filter(item => !sameRoute(item, row)), row] }
  },
  wire: { viewSchema: schema, view: state => state },
}

export function fastPreference(state, selection) {
  return state?.preferences?.findLast(row => sameRoute(row, selection))?.fast
}

export function fastServiceTier(state, selection) {
  return state?.preferences?.findLast(row => sameRoute(row, selection))?.serviceTier
}

export function effectiveFast(state, selection, model) {
  if (!model?.fastCapability) return undefined
  return fastPreference(state, selection) ?? model.fastCapability.defaultEnabled ?? false
}

export function appendFastPreference(session, selection, fast, serviceTier) {
  return appendPluginRecord(session, 'plugin:kode/model-fast', { provider: selection.provider, model: selection.model, fast, ...(serviceTier ? { serviceTier } : {}) })
}

export function cursorFastVariant(id, fast) {
  const start = id.lastIndexOf('[')
  if (start < 0 || !id.endsWith(']')) return undefined
  const parts = id.slice(start + 1, -1).split(','), index = parts.findIndex(part => /^fast=(?:true|false)$/.test(part))
  if (index < 0) return undefined
  parts[index] = `fast=${fast}`
  return `${id.slice(0, start)}[${parts.join(',')}]`
}

/** Only pair variants that were both advertised by the Agent. */
export function withModelVariantFast(models) {
  const ids = new Set(models.map(model => model.id))
  return models.map(model => {
    if (model.fastCapability) return model
    const bracketFast = cursorFastVariant(model.id, true), bracketStandard = cursorFastVariant(model.id, false)
    if (bracketFast && ids.has(bracketFast) && ids.has(bracketStandard)) return { ...model, fastCapability: { transport: 'model-variant', defaultEnabled: model.id === bracketFast, fastModelId: bracketFast, standardModelId: bracketStandard } }
    const fast = model.id.endsWith('-fast'), standardModelId = fast ? model.id.slice(0, -5) : model.id, fastModelId = fast ? model.id : `${model.id}-fast`
    if (!ids.has(fastModelId) || !ids.has(standardModelId)) return model
    return { ...model, fastCapability: { transport: 'model-variant', defaultEnabled: fast, fastModelId, standardModelId } }
  })
}
