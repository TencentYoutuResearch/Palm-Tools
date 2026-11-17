/** Authentication plan plus an explicit, confirmation-gated RPC login controller.
 * Plan construction has no login, credential access, process or network side effects.
 * Source: https://github.com/openai/codex/blob/main/codex-rs/cli/src/doctor.rs
 * Test: provider_reachability_chatgpt_uses_inference_endpoint.
 * This public-source route is NOT proof that the installed CLI/account supports a model.
 * Integration must retain CodexModelGate admission, redirect rejection, usage and process
 * drainage. Real login and auth-header forwarding require separate owner confirmation.
 */
export const officialCodexResponsesEndpoint = 'https://chatgpt.com/backend-api/codex/responses'

export function validateOfficialCodexEndpoint(value) {
  // Require the exact spelling too: URL normalization must not admit alternate paths,
  // embedded credentials, fragments, queries, default ports or encoded delimiters.
  if (typeof value !== 'string' || value !== officialCodexResponsesEndpoint) {
    throw new Error('Managed ChatGPT inference destination rejected')
  }
  return value
}

export function managedChatgptAuthPlan({ gateBase, endpoint = officialCodexResponsesEndpoint } = {}) {
  validateOfficialCodexEndpoint(endpoint)
  let gate
  try { gate = new URL(gateBase) } catch { throw new Error('Managed ChatGPT gate rejected') }
  if (typeof gateBase !== 'string' || gate.href !== gateBase || gate.protocol !== 'http:'
      || gate.hostname !== '127.0.0.1' || !gate.port || gate.username || gate.password
      || gate.search || gate.hash || !/^\/kode-model\/[a-f0-9-]{36}$/.test(gate.pathname)) {
    throw new Error('Managed ChatGPT gate rejected')
  }
  // Deliberately fixed provider and ephemeral storage; do not accept arbitrary config
  // fields or credential material. A login must occur inside this same decision process.
  const settings = Object.freeze([
    'cli_auth_credentials_store="ephemeral"',
    'model_provider="kode_workflow"',
    `model_providers.kode_workflow={name="Kode managed ChatGPT",base_url=${JSON.stringify(gateBase)},wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  ])
  return Object.freeze({ endpoint, settings,
    login: Object.freeze({ method: 'account/login/start', params: Object.freeze({ type: 'chatgpt' }) }),
    readiness: 'requires_owner_confirmation_and_live_validation',
    credentialPersistence: 'none',
  })
}

export function requireManagedChatgptConfirmation(value) {
  if (!value || value.mode !== 'ephemeral-chatgpt' || value.confirmed !== true
      || typeof value.confirmationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.confirmationId)
      || typeof value.onLogin !== 'function'
      || Object.keys(value).some(key => !['mode', 'confirmed', 'confirmationId', 'onLogin'].includes(key))) {
    throw Object.assign(new Error('Managed ChatGPT login and local credential forwarding require current owner confirmation'),
      { code: 'managed_chatgpt_confirmation_required' })
  }
}

/** Called only after the caller has obtained action-time permission. Never returns tokens.
 * The caller must own and stop this RPC process on failure, cancellation and completion.
 */
export function suppressManagedChatgptDiagnostics(rpc) {
  for (const target of [rpc, rpc.process]) {
    if (!target) continue
    const descriptor = Object.getOwnPropertyDescriptor(target, 'stderr')
    if (descriptor?.configurable === false) continue
    Object.defineProperty(target, 'stderr', { configurable: false, enumerable: false,
      get: () => '', set: () => {} })
  }
}

export async function loginManagedChatgpt(rpc, authorization, signal) {
  requireManagedChatgptConfirmation(authorization)
  suppressManagedChatgptDiagnostics(rpc)
  signal.throwIfAborted()
  const cancelled = Symbol('cancelled')
  let loginId, failed = false, finish, terminate
  const queued = []
  const completed = new Promise(resolve => { finish = resolve })
  const terminated = new Promise(resolve => { terminate = resolve })
  const stop = () => { failed = true; terminate(cancelled); finish(false) }
  const accept = params => {
    if (!loginId) {
      if (queued.length < 8) queued.push({ loginId: params?.loginId, success: params?.success })
      return
    }
    if (params?.loginId === loginId) {
      if (params.success !== true) stop()
      else finish(true)
    }
  }
  const notification = event => { if (event.method === 'account/login/completed') accept(event.params) }
  rpc.on('notification', notification)
  rpc.on('closed', stop)
  signal.addEventListener('abort', stop, { once: true })
  try {
    if (rpc.closed || signal.aborted) stop()
    if (failed) throw new Error()
    const result = await Promise.race([rpc.request('account/login/start', { type: 'chatgpt' }, { signal }), terminated])
    if (failed || signal.aborted || result === cancelled) throw new Error()
    if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || !result.loginId
        || result.loginId.length > 256) throw new Error()
    loginId = result.loginId
    const url = new URL(result.authUrl)
    if (url.protocol !== 'https:' || !['chatgpt.com', 'auth.openai.com'].includes(url.hostname)
        || url.username || url.password || url.port || url.hash) throw new Error()
    for (const params of queued) accept(params)
    const displayed = await Promise.race([Promise.resolve().then(() => {
      // Recheck in the callback microtask, not only before scheduling it.
      if (failed || signal.aborted || rpc.closed) throw new Error()
      return authorization.onLogin(Object.freeze({ authUrl: url.href }))
    }), terminated])
    if (displayed === cancelled || failed || !(await completed) || signal.aborted || rpc.closed) throw new Error()
    return Object.freeze({ mode: 'ephemeral-chatgpt', authenticated: true })
  } catch {
    throw Object.assign(new Error('Managed ChatGPT login did not complete'), { code: 'managed_chatgpt_login_failed' })
  } finally {
    rpc.off('notification', notification)
    rpc.off('closed', stop)
    signal.removeEventListener('abort', stop)
    queued.length = 0
  }
}
