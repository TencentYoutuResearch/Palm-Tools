/** Native question text is task data. Only these bounded fields cross the Home boundary. */
export function workerQuestions(value) {
  const bounded = (s, max) => typeof s === 'string' && !s.includes('\0') && Buffer.byteLength(s) <= max
  const text = (s, max) => bounded(s, max) && s.trim().length > 0
  const allowed = new Set(['id', 'question', 'header', 'options', 'isOther', 'isSecret'])
  if (!Array.isArray(value) || !value.length || value.length > 8 || Buffer.byteLength(JSON.stringify(value)) > 32768
      || new Set(value.map(q => q?.id)).size !== value.length
      || value.some(q => !q || typeof q !== 'object' || Object.keys(q).some(key => !allowed.has(key))
        || !text(q.id, 128) || !text(q.question, 4096)
        || (q.header !== undefined && !bounded(q.header, 256))
        || ['isOther', 'isSecret'].some(key => q[key] !== undefined && typeof q[key] !== 'boolean')
        || (q.options != null && (!Array.isArray(q.options) || q.options.length > 8
          || q.options.some(o => !o || Object.keys(o).some(key => !['label', 'description'].includes(key))
            || !text(o.label, 256) || (o.description !== undefined && !bounded(o.description, 1024))))))) {
    throw new Error('Invalid native Worker clarification')
  }
  return value.map(question => {
    const copy = structuredClone(question)
    if (copy.options === null) delete copy.options
    return copy
  })
}
