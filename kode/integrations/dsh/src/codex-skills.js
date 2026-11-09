/** Collapse duplicate skill installations without guessing between different instructions. */
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
export async function deduplicateSkillCopies(skills) {
  const counts = new Map(), seen = new Set(), fingerprints = new Map(), result = []
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
  for (const skill of skills) {
    if (counts.get(skill.name) === 1) { result.push(skill); continue }
    const path = await realpath(skill.path).catch(() => skill.path)
    if (!fingerprints.has(path)) fingerprints.set(path, readFile(path).then(bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')).catch(() => 'path:' + path))
    const identity = skill.name + '\0' + await fingerprints.get(path)
    if (seen.has(identity)) continue
    seen.add(identity)
    // Retain Codex's original catalog order and advertised path. Re-read on
    // every catalog reload: an updated copy must never use a stale digest.
    result.push(skill)
  }
  return result
}
