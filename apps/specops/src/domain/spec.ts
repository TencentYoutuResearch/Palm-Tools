import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { SpecOpsError } from '../core/errors.js'

export const SPEC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

export type DocumentKind = 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation'
export type DocumentClass = 'normative' | 'work_item'
export type NormativeSpecType = 'capability' | 'action' | 'contract' | 'verification' | 'architecture' | 'policy' | 'invariant'
export type WorkType = 'feature' | 'bugfix' | 'refactor' | 'investigation' | 'docs' | 'chore'
export type NormativeStatus = 'draft' | 'active' | 'deprecated' | 'superseded' | 'archived'
export type WorkItemStatus = 'proposed' | 'approved' | 'in_progress' | 'blocked' | 'completed' | 'cancelled' | 'archived'
export type DocumentStatus = NormativeStatus | WorkItemStatus

export interface SpecFrontmatter {
  schema_version: 1 | 2
  id: string
  kind: DocumentKind
  /** Required for schema v2; inferred from legacy `kind` for schema v1. */
  document_class?: DocumentClass
  spec_type?: NormativeSpecType
  work_type?: WorkType
  title: string
  status: DocumentStatus
  verifies?: string[]
  paths?: string[]
  targets?: string[]
  workflow_profile?: WorkType
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
const DOCUMENT_CLASSES = new Set<DocumentClass>(['normative', 'work_item'])
const SPEC_TYPES = new Set<NormativeSpecType>(['capability', 'action', 'contract', 'verification', 'architecture', 'policy', 'invariant'])
const WORK_TYPES = new Set<WorkType>(['feature', 'bugfix', 'refactor', 'investigation', 'docs', 'chore'])
const NORMATIVE_STATUSES = new Set<NormativeStatus>(['draft', 'active', 'deprecated', 'superseded', 'archived'])
const WORK_ITEM_STATUSES = new Set<WorkItemStatus>(['proposed', 'approved', 'in_progress', 'blocked', 'completed', 'cancelled', 'archived'])

export function inferDocumentClass(kind: DocumentKind): DocumentClass {
  return kind === 'spec' ? 'normative' : 'work_item'
}

export function inferWorkType(kind: DocumentKind): WorkType {
  if (kind === 'bug') return 'bugfix'
  if (kind === 'refactor' || kind === 'investigation' || kind === 'feature') return kind
  return kind === 'spec' ? 'docs' : 'feature'
}

export function isNormative(frontmatter: Pick<SpecFrontmatter, 'document_class' | 'kind'>): boolean {
  return (frontmatter.document_class ?? inferDocumentClass(frontmatter.kind)) === 'normative'
}

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
  if (raw.schema_version !== 1 && raw.schema_version !== 2) {
    throw new SpecOpsError('unsupported_schema', `schema_version must be 1 or 2, got ${String(raw.schema_version)}`)
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
  const kind = raw.kind as DocumentKind
  const documentClass = raw.document_class === undefined
    ? inferDocumentClass(kind)
    : raw.document_class
  if (typeof documentClass !== 'string' || !DOCUMENT_CLASSES.has(documentClass as DocumentClass)) {
    throw new SpecOpsError('invalid_frontmatter', 'document_class must be normative or work_item')
  }
  if ((documentClass === 'normative') !== (kind === 'spec')) {
    throw new SpecOpsError('invalid_frontmatter', 'normative documents must use kind: spec; executable kinds must use document_class: work_item')
  }
  const specType = raw.spec_type === undefined ? (documentClass === 'normative' ? 'capability' : undefined) : raw.spec_type
  const workType = raw.work_type === undefined ? (documentClass === 'work_item' ? inferWorkType(kind) : undefined) : raw.work_type
  if (specType !== undefined && (typeof specType !== 'string' || !SPEC_TYPES.has(specType as NormativeSpecType))) {
    throw new SpecOpsError('invalid_frontmatter', 'spec_type is invalid')
  }
  if (workType !== undefined && (typeof workType !== 'string' || !WORK_TYPES.has(workType as WorkType))) {
    throw new SpecOpsError('invalid_frontmatter', 'work_type is invalid')
  }
  if (documentClass === 'normative' && workType !== undefined) throw new SpecOpsError('invalid_frontmatter', 'normative documents cannot declare work_type')
  if (documentClass === 'work_item' && specType !== undefined) throw new SpecOpsError('invalid_frontmatter', 'work items cannot declare spec_type')
  const statuses = documentClass === 'normative' ? NORMATIVE_STATUSES : WORK_ITEM_STATUSES
  const legacyStatuses = new Set(['draft', 'active', 'proposed', 'completed', 'archived'])
  const statusAllowed = raw.schema_version === 1
    ? typeof raw.status === 'string' && legacyStatuses.has(raw.status)
    : typeof raw.status === 'string' && statuses.has(raw.status as never)
  if (!statusAllowed) {
    throw new SpecOpsError('invalid_frontmatter', `status is invalid for ${documentClass}`)
  }
  if (documentClass === 'normative' && raw.workflow_profile !== undefined) {
    throw new SpecOpsError('invalid_frontmatter', 'normative documents cannot declare workflow_profile')
  }
  if (raw.workflow_profile !== undefined && (typeof raw.workflow_profile !== 'string' || !WORK_TYPES.has(raw.workflow_profile as WorkType))) {
    throw new SpecOpsError('invalid_frontmatter', 'workflow_profile is invalid')
  }

  const verifies = stringArray(raw.verifies, 'verifies')
  const paths = stringArray(raw.paths, 'paths')
  const targets = stringArray(raw.targets, 'targets')
  return {
    schema_version: raw.schema_version,
    id: raw.id,
    kind,
    document_class: documentClass as DocumentClass,
    ...(specType === undefined ? {} : { spec_type: specType as NormativeSpecType }),
    ...(workType === undefined ? {} : { work_type: workType as WorkType }),
    title: raw.title.trim(),
    status: raw.status as DocumentStatus,
    ...(verifies === undefined ? {} : { verifies }),
    ...(paths === undefined ? {} : { paths }),
    ...(targets === undefined ? {} : { targets }),
    ...(raw.workflow_profile === undefined ? {} : { workflow_profile: raw.workflow_profile as WorkType }),
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
