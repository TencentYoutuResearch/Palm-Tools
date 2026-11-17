import {field, id} from './identity.js'

/** Evidence for one completed source read, never a completeness/deletion claim. */
export function pageObservation(result, command, requestId, readAt) {
  const c = result?.coverage
  if (!c || c.mode !== 'single_page_snapshot' || c.observed_page !== command.page
    || !Number.isInteger(c.observed_page) || c.observed_page < 1 || c.observed_page > 100
    || c.requested_limit !== 100 || !Number.isInteger(c.observed_count)
    || c.observed_count < result.objects?.length || c.observed_count > c.requested_limit || c.observed_count < 0
    || !Array.isArray(result.objects) || c.has_more !== 'unknown' || c.reconciliation !== 'not_performed'
    || (command.kind === 'comment' ? !command.parent : command.parent != null)
    || !Number.isSafeInteger(readAt) || readAt < 0) throw Error('Invalid source observation')
  return {
    mode: c.mode, observed_page: c.observed_page, requested_limit: c.requested_limit,
    observed_count: c.observed_count, has_more: 'unknown', reconciliation: 'not_performed',
    read_at: new Date(readAt).toISOString(), kind: field(command.kind, 'resource kind'),
    parent: command.parent ? {kind: field(command.parent.kind, 'parent kind'), id: field(String(command.parent.id), 'parent id')} : null,
    request_id: id(requestId),
  }
}
