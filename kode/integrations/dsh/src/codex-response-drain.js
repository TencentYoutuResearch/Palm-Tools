/** Forward with backpressure; a completed-response peer close does not destroy its upstream. */
import { Readable } from 'node:stream'

export function drainCodexResponse(body, response, { observer, signal, successful = false,
  timeoutMs = 2000, maxTailBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1 || maxTailBytes > 8 * 1024 * 1024) throw new Error('Invalid managed response drain bounds')
  const source = Readable.fromWeb(body)
  return new Promise((resolve, reject) => {
    let settled = false, upstreamEof = false, peerClosed = false, destinationFinished = false
    let timer, tailBytes = 0
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      source.unpipe(response)
      source.off('data', data); source.off('end', ended); source.off('error', upstreamError); source.off('close', sourceClosed)
      response.off('close', downstreamClosed); response.off('error', downstreamError); response.off('finish', finished)
    }
    const finish = error => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        error.upstream_complete = upstreamEof
        error.stream_failure_side ??= peerClosed ? 'downstream' : 'upstream'
        // Destroy without an arbitrary error payload. Contain a delayed web-reader cancellation error.
        if (!source.closed) {
          const ignored = () => {}
          source.on('error', ignored)
          source.once('close', () => source.off('error', ignored))
          source.destroy()
        }
        if (!response.destroyed) response.destroy()
        reject(error)
      } else resolve(Object.freeze({ upstream_eof: true, peer_closed: peerClosed, tail_bytes: tailBytes }))
    }
    const failure = (code, side) => Object.assign(new Error('Managed CLI response drainage failed'), { code, stream_failure_side: side })
    const terminalValid = () => observer && !observer.invalidEvidence
      && observer.terminal?.event === 'response.completed' && observer.terminal.status === 'completed'
    const complete = () => {
      if (!upstreamEof || (!destinationFinished && !peerClosed)) return
      if (peerClosed && !terminalValid()) finish(failure('managed_cli_upstream_tail_invalid', 'upstream'))
      else finish()
    }
    const data = bytes => {
      if (peerClosed) {
        tailBytes += bytes.length
        if (tailBytes > maxTailBytes) { finish(failure('managed_cli_upstream_drain_limit', 'upstream')); return }
      }
      observer?.push(bytes)
      if (peerClosed && observer?.invalidEvidence) finish(failure('managed_cli_upstream_tail_invalid', 'upstream'))
    }
    const ended = () => { upstreamEof = true; observer?.finish(); complete() }
    const upstreamError = error => finish(Object.assign(failure(error?.code ?? 'ERR_STREAM_PREMATURE_CLOSE', 'upstream'), { cause: error }))
    const sourceClosed = () => { if (!upstreamEof) finish(failure('ERR_STREAM_PREMATURE_CLOSE', 'upstream')) }
    const downstreamClosed = () => {
      if (response.writableFinished) { destinationFinished = true; complete(); return }
      if (peerClosed || settled) return
      peerClosed = true
      source.unpipe(response)
      if (!successful || !terminalValid()) { finish(failure('ERR_STREAM_PREMATURE_CLOSE', 'downstream')); return }
      if (!upstreamEof) {
        // One absolute deadline starts at peer close and is never extended by tail bytes.
        timer = setTimeout(() => finish(failure('managed_cli_upstream_drain_timeout', 'upstream')), timeoutMs)
        source.resume()
      }
      complete()
    }
    const downstreamError = () => downstreamClosed()
    const finished = () => { destinationFinished = true; complete() }
    const aborted = () => finish(failure('ABORT_ERR', 'upstream'))
    source.on('data', data); source.once('end', ended); source.once('error', upstreamError); source.once('close', sourceClosed)
    response.once('close', downstreamClosed); response.once('error', downstreamError); response.once('finish', finished)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
    else source.pipe(response)
  })
}
