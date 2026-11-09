/** Keep immutable batch revisions alive across successive plugin recompositions.
 * The wrapper belongs to the module registry, so disabling Kode cannot invalidate
 * assets already referenced by a page. It retains no plugin Context or proxy. */
const installed = Symbol.for('kode.client-batch-retention.v1')
export function retainClientBatches(registry, limit = 64) {
  if (registry[installed]) return
  let original
  for (let owner = registry; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'compose')
    if (descriptor) { original = descriptor.value; break }
  }
  if (typeof original !== 'function' || !(registry.responses instanceof Map) || !(registry.batchResponses instanceof Map)) return
  const retained = new Map()
  const remember = source => {
    for (const [url, response] of source ?? []) {
      if (!retained.has(url)) retained.set(url, response)
      while (retained.size > limit) retained.delete(retained.keys().next().value)
    }
  }
  remember(registry.previousBatchResponses); remember(registry.batchResponses)
  // Calling through `this` preserves the current caller's Cordis service scope.
  registry.compose = function (...args) {
    remember(this.previousBatchResponses); remember(this.batchResponses)
    const result = original.apply(this, args)
    for (const [url, response] of retained) if (!this.responses.has(url)) this.responses.set(url, response)
    return result
  }
  registry[installed] = true
}
