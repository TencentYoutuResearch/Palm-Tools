/** Read-only Builder close diagnostics fenced to the current Home operation. */
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)

export async function readBuilderCloseStatus(client, operationId, homeHub) {
  if (!valid(operationId) || !valid(homeHub)) throw new Error('Invalid Builder close status scope')
  const path = `/api/v1/messaging/operations/${encodeURIComponent(operationId)}`
  const state = await client.call(`${path}/builder-close`)
  const { scope } = await client.call(`${path}/builder-scope`)
  const operation = state?.operation
  if (operation?.id !== operationId || operation.worker?.node_id !== homeHub
      || !scope || scope.operation_id !== operationId || scope.home_hub !== homeHub
      || scope.worker?.node_id !== homeHub || scope.worker?.session_id !== operation.worker.session_id
      || scope.request?.attempt !== operation.attempt || scope.request?.epoch !== operation.epoch) {
    throw new Error('Builder close status belongs to another Home operation')
  }
  return state
}
