import QRCode from 'qrcode'
import { admitHostRequest } from './host-admission.js'

const ACCOUNT_ROUTES = {
  default_relay: '/api/v1/messaging/cloud/account/default_relay',
  methods: '/api/v1/messaging/cloud/account/methods',
  code: '/api/v1/messaging/cloud/account/code',
  sign_in: '/api/v1/messaging/cloud/account/sign_in',
  sign_out: '/api/v1/messaging/cloud/account/sign_out',
  profile: '/api/v1/messaging/cloud/account/profile',
  name: '/api/v1/messaging/cloud/account/name',
  linked: '/api/v1/messaging/cloud/account/linked',
  palmx_start: '/api/v1/messaging/cloud/account/palmx/start',
  palmx_poll: '/api/v1/messaging/cloud/account/palmx/poll',
  palmx_cancel: '/api/v1/messaging/cloud/account/palmx/cancel',
  palmx_unbind: '/api/v1/messaging/cloud/account/palmx/unbind',
  palm_sign_in: '/api/v1/messaging/cloud/account/palm/sign_in',
  palm_start: '/api/v1/messaging/cloud/account/palm/start',
  palm_poll: '/api/v1/messaging/cloud/account/palm/poll',
  palm_cancel: '/api/v1/messaging/cloud/account/palm/cancel',
  backend: '/api/v1/messaging/cloud/backend',
  activate: '/api/v1/messaging/cloud/activate',
  remove_worker: '/api/v1/messaging/cloud/remove_worker',
}

async function attachQr(result) {
  if (!result || typeof result !== 'object') return result
  const payload = result.qr_url ?? result.qr_payload ?? result.uri ?? result.url
  if (typeof payload === 'string' && payload.trim()) {
    try {
      result.qr_data_url = await QRCode.toDataURL(payload.trim(), { errorCorrectionLevel: 'M', margin: 3, scale: 6 })
    } catch {
      result.qr_error = '二维码生成失败，请重试。'
    }
  }
  return result
}

async function readJsonBody(req, limit = 65536) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('Request too large'), { status: 413 })
  }
  return body.trim() ? JSON.parse(body) : {}
}

/**
 * Host-owner proxy for Kode Account (email code / PalmX / Palm handoff / profile)
 * and Multi-Device switching (`/api/v1/messaging/cloud/account/devices`).
 */
export function registerAccountApi(ctx, backend) {
  const send = (res, status, value) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  }

  const disposeAccount = ctx.webServer.register({
    kind: 'prefix',
    path: '/api/kode/account',
    handler: async (req, res, peer) => {
      const admitted = admitHostRequest(ctx, req, peer)
      if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') {
        return send(res, 403, { error: 'Host owner required' })
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        if (req.method === 'GET' && (url.pathname === '/api/kode/account' || url.pathname === '/api/kode/account/status')) {
          return send(res, 200, await backend.call('/api/v1/messaging/cloud/status'))
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST required' })
        const input = await readJsonBody(req)
        const action = typeof input.action === 'string' ? input.action : ''
        const route = ACCOUNT_ROUTES[action]
        if (!route) return send(res, 400, { error: `Unknown account action: ${action}` })
        const { action: _ignored, ...payload } = input
        const result = await backend.call(route, payload)
        if (action === 'palmx_start' || action === 'palm_start') await attachQr(result)
        return send(res, 200, result)
      } catch (error) {
        if (error.status === 404) {
          return send(res, 503, { code: 'KODE_SERVICE_UPDATE_REQUIRED', error: '当前 Kode 服务版本较旧，需要更新并重启。' })
        }
        return send(res, error.status ?? 400, { error: error.message || '账号请求失败' })
      }
    },
  })

  const disposeDevices = ctx.webServer.register({
    kind: 'exact',
    path: '/api/kode/devices',
    handler: async (req, res, peer) => {
      const admitted = admitHostRequest(ctx, req, peer)
      if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') {
        return send(res, 403, { error: 'Host owner required' })
      }
      try {
        if (req.method === 'GET') {
          return send(res, 200, await backend.call('/api/v1/messaging/cloud/account/devices', { action: 'devices' }))
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST required' })
        const input = await readJsonBody(req)
        return send(res, 200, await backend.call('/api/v1/messaging/cloud/account/devices', input))
      } catch (error) {
        if (error.status === 404) {
          return send(res, 503, { code: 'KODE_SERVICE_UPDATE_REQUIRED', error: '当前 Kode 服务版本较旧，需要更新并重启。' })
        }
        return send(res, error.status ?? 400, { error: error.message || '设备请求失败' })
      }
    },
  })

  return () => {
    disposeAccount?.()
    disposeDevices?.()
  }
}
