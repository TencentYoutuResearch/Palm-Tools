/** DSH alpha.2 may choose a child Session with no turns as a reusable workspace blank. */
export async function fetchWithWorkspaceSessionCreation(input, init, send) {
  const response = await send(input, init)
  if (!response.ok || init?.method !== 'POST' || typeof init.body !== 'string'
    || new URL(input, 'http://localhost/').pathname !== '/api/session/create') return response

  let envelope
  try { envelope = JSON.parse(init.body) } catch { return response }
  const request = envelope?.payload?.args?.request
  if (envelope?.type !== 'client-request' || envelope.method !== 'session/create'
    || typeof envelope.rpcId !== 'string' || typeof request?.workspaceId !== 'string'
    || typeof request.sessionId !== 'string' || request.cwd !== undefined) return response

  let result
  try { result = await response.clone().json() } catch { return response }
  const error = result?.result?.error
  if (result?.type !== 'server-response' || result.rpcId !== envelope.rpcId
    || result.result?.ok !== false || error?.code !== 'session/agent-busy'
    || error.details?.reason !== 'use subagent delivery for this child session') return response

  // The Host checks ownership before any create/reuse side effects. Let the
  // same Host mint a new ordinary Session in this workspace on this one retry.
  init.signal?.throwIfAborted()
  delete request.sessionId
  return send(input, { ...init, body: JSON.stringify(envelope) })
}
