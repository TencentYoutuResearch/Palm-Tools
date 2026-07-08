import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { SpecOpsError } from '../core/errors.js'

export const SPEC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

export type DocumentKind = 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation'
export type DocumentStatus = 'draft' | 'active' | 'proposed' | 'completed' | 'archived'

export interface SpecFrontmatter {
  schema_version: 1
  id: string
  kind: DocumentKind
  title: string
  status: DocumentStatus
  verifies?: string[]
  paths?: string[]
}

export interface SpecDocument {
  frontmatter: SpecFrontmatter
  body: string
  relativePath: string
}

/**
 * A change is a folder under `.specops/changes/<id>/` containing:
 * - proposal.md (required) — YAML frontmatter + body describing the change
 * - tasks.md (required) — implementation checklist
 * - design.md (optional) — technical decisions
 * - specs/ (optional) — delta specs for this change
 */
export interface ChangeFolder {
  id: string
  title: string
  status: DocumentStatus
  relativePath: string
  files: ChangeFile[]
}

export interface ChangeFile {
  name: string // e.g. "proposal.md", "tasks.md", "design.md", "specs/auth/spec.md"
  path: string // relative to workspace root
}

const KINDS = new Set<DocumentKind>(['spec', 'change', 'bug', 'refactor', 'feature', 'investigation'])
const STATUSES = new Set<DocumentStatus>(['draft', 'active', 'proposed', 'completed', 'archived'])

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new SpecOpsError('invalid_frontmatter', `${field} must be an array of strings`)
  }
  return value
}

export function validateFrontmatter(value: unknown): SpecFrontmatter {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecOpsError('invalid_frontmatter', 'frontmatter must be a mapping')
  }
  const raw = value as Record<string, unknown>
  if (raw.schema_version !== 1) {
    throw new SpecOpsError('unsupported_schema', `schema_version must be 1, got ${String(raw.schema_version)}`)
  }
  if (typeof raw.id !== 'string' || !SPEC_ID_PATTERN.test(raw.id)) {
    throw new SpecOpsError('invalid_frontmatter', 'id has an invalid format')
  }
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind as DocumentKind)) {
    throw new SpecOpsError('invalid_frontmatter', `kind must be one of: ${[...KINDS].join(', ')}`)
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    throw new SpecOpsError('invalid_frontmatter', 'title must be a non-empty string')
  }
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status as DocumentStatus)) {
    throw new SpecOpsError('invalid_frontmatter', 'status is invalid')
  }

  const verifies = stringArray(raw.verifies, 'verifies')
  const paths = stringArray(raw.paths, 'paths')
  return {
    schema_version: 1,
    id: raw.id,
    kind: raw.kind as DocumentKind,
    title: raw.title.trim(),
    status: raw.status as DocumentStatus,
    ...(verifies === undefined ? {} : { verifies }),
    ...(paths === undefined ? {} : { paths }),
  }
}

export function parseDocument(content: string, relativePath: string): SpecDocument {
  const normalized = content.replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (match === null) {
    throw new SpecOpsError('missing_frontmatter', `${relativePath}: missing YAML frontmatter`)
  }
  try {
    return {
      frontmatter: validateFrontmatter(parseYaml(match[1] ?? '')),
      body: match[2] ?? '',
      relativePath,
    }
  } catch (error) {
    if (error instanceof SpecOpsError) {
      throw new SpecOpsError(error.code, `${relativePath}: ${error.message}`, error.exitCode)
    }
    throw new SpecOpsError(
      'invalid_frontmatter',
      `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function serializeDocument(document: Omit<SpecDocument, 'relativePath'>): string {
  const yaml = stringifyYaml(document.frontmatter, { lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n\n${document.body.trim()}\n`
}

/** Smart default status by kind: spec→active, everything else→proposed. */
export function defaultStatusForKind(kind: DocumentKind): DocumentStatus {
  return kind === 'spec' ? 'active' : 'proposed'
}
