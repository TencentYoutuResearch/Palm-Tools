// Mirrors of the server-side domain shapes we consume. Kept intentionally
// loose (optional fields) since the server evolves independently.

export type DocumentKind =
  | 'spec'
  | 'change'
  | 'bug'
  | 'refactor'
  | 'feature'
  | 'investigation';

export type DocumentStatus =
  | 'draft'
  | 'active'
  | 'deprecated'
  | 'superseded'
  | 'proposed'
  | 'approved'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'archived';

export type DocumentClass = 'normative' | 'work_item';
export type SpecType = 'capability' | 'action' | 'contract' | 'verification' | 'architecture' | 'policy' | 'invariant';
export type WorkType = 'feature' | 'bugfix' | 'refactor' | 'investigation' | 'docs' | 'chore';

export interface RegistryFile {
  name: string;
  path: string;
}

export interface RegistryEntry {
  id: string;
  kind: DocumentKind;
  document_class?: DocumentClass;
  spec_type?: SpecType;
  work_type?: WorkType;
  title: string;
  status: DocumentStatus;
  path: string;
  verifies: string[];
  paths: string[];
  targets?: string[];
  workflow_profile?: WorkType;
  files?: RegistryFile[];
}

export interface ScanResult {
  ok: boolean;
  command: string;
  data: {
    schema_version: 1;
    generated_at: string;
    documents: RegistryEntry[];
    constitution?: unknown;
  };
  diagnostics?: unknown[];
}

export interface WorkspaceState {
  workspace: string;
  scan: ScanResult;
  drift: unknown;
  analyze: unknown;
  assurance?: AssuranceState;
  drift_report?: { id: string; status: 'clean' | 'repair_required'; invalidated_evidence: string[]; repair_tasks: Array<{ id: string; title: string; severity: string; kind: string }>; created_at: string } | null;
  harness_health?: { total_runs: number; completed_runs: number; failed_runs: number; first_pass_task_rate: number; average_task_attempts: number; average_spec_to_green_ms: number | null; failed_gate_rate: number; exhausted_budgets: number };
}

export interface AssuranceState {
  spec_graph: { nodes: Array<{ id: string; kind: string; label: string; status: string; path?: string }>; edges: Array<{ from: string; to: string; relation: string }> };
  product_graph: { nodes: Array<{ id: string; kind: string; label: string; status: string; path?: string }>; edges: Array<{ from: string; to: string; relation: string }> };
  mappings: Array<{ spec_id: string; paths: string[]; verifies: string[]; coverage: 'mapped' | 'partial' | 'missing'; source?: 'frontmatter' | 'manifest' | 'inferred'; confidence?: number; version?: number }>;
  diff: { unmapped_specs: string[]; unmapped_product: string[]; missing_paths: string[]; missing_verification: string[] };
  completion_contracts: Array<{ subject: string; required_evidence: string[]; forbidden: string[]; pass_condition: { all_required_evidence: boolean; critical_drift: number; gate_status: string } }>;
  evidence: Array<{ id: string; subject: string; claim: string; producer: string; result: 'passed' | 'failed'; stale: boolean; created_at: string }>;
  impact: Array<{ subject: string; direct: string[]; transitive: string[]; affected_specs: string[]; required_tests: string[] }>;
  risk: Array<{ subject: string; score: number; level: string; required_approval: string; dimensions: Record<string, number> }>;
  policy: { harness_owned: string[]; agent_read_only: string[]; agent_editable: string[]; forbidden_changes: string[] };
  environment: { platform: string; runtime: string; lock_hash: string | null };
  health: { mapped_spec_rate: number; evidence_coverage_rate: number; stale_evidence: number; critical_risks: number };
  orchestration?: {
    active_tasks: number;
    blocked_tasks: number;
    failed_gates: number;
    runs: Array<{
      run_id: string;
      run_state: string;
      updated_at: string;
      budget: { max_iterations: number; used_iterations: number; exhausted: boolean };
      tasks: Array<{ id: string; title: string; state: string }>;
      loops: Array<{ id: string; kind: string; state: string; iteration: number }>;
      artifacts: Array<{ id: string; kind: string; subject: string; source_commit: string | null }>;
      gates: Array<{ id: string; status: string; reason: string }>;
    }>;
  };
}

export interface SpecFrontmatter {
  schema_version: 1 | 2;
  id: string;
  kind: DocumentKind;
  document_class?: DocumentClass;
  spec_type?: SpecType;
  work_type?: WorkType;
  title: string;
  status: DocumentStatus;
  verifies?: string[];
  paths?: string[];
  targets?: string[];
  workflow_profile?: WorkType;
}

export interface SpecDocument {
  frontmatter: SpecFrontmatter;
  body: string;
  relativePath: string;
}

export interface DocumentResponse {
  document: SpecDocument | null;
  content: string;
  version: string;
}

// --- git history (phase D) ---
export interface HistoryCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  message: string;
}

// --- sessions (phase E) ---
export type ExecutionTransport =
  | 'codebuddy_acp'
  | 'codex_app_server'
  | 'claude_stream_json'
  | 'legacy_kode_pty';

export interface ExecutionIdentity {
  execution_id: string;
  transport: ExecutionTransport;
  backend_key: string;
  native_session_id: string | null;
  process_generation: number;
}

/** Canonical UI grouping key, with numeric fallback for unnormalized v1 data. */
export function executionGroupKey(
  executionId: string | null | undefined,
  kodeSessionId: number | null | undefined,
): string | null {
  if (executionId) return `execution:${executionId}`;
  if (typeof kodeSessionId === 'number') return `legacy-kode:${kodeSessionId}`;
  return null;
}

export type TranscriptKind = 'text' | 'tool_use' | 'tool_result';
export type TranscriptRole = 'agent' | 'user' | 'system';

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  kind?: TranscriptKind;
  tool?: string;
  tool_call_id?: string;
  summary?: string;
  preview?: string;
  status?: 'running' | 'ok' | 'error';
  execution_id?: string | null;
  kode_session_id?: number | null;
}

export interface SessionAgent {
  execution_id?: string;
  transport?: ExecutionTransport;
  native_session_id?: string | null;
  process_generation?: number;
  kode_session_id: number | null;
  session_uuid?: string | null;
  backend_key: string;
  model?: string | null;
  purpose: string;
  status: string;
  started_at?: string;
  ended_at?: string | null;
}

export interface WorkflowStep {
  id: string;
  state: 'pending' | 'active' | 'awaiting_user' | 'done' | 'failed' | 'skipped';
  started_at?: string;
  completed_at?: string;
}

export interface RequiredActionOption {
  label: string;
  description?: string;
}

export interface RequiredActionQuestion {
  question_id: string;
  prompt: string;
  header?: string;
  options: RequiredActionOption[];
  multi_select?: boolean;
}

export interface RequiredAction {
  kind: string;
  prompt?: string;
  question_id?: string;
  header?: string;
  options?: RequiredActionOption[];
  multi_select?: boolean;
  questions?: RequiredActionQuestion[];
  plan_id?: string;
  markdown?: string;
  title?: string;
  message?: string;
  options_simple?: Array<{ id: string; label: string }>;
  patch_files?: string[];
  review_note?: string;
  [key: string]: unknown;
}

export interface SessionDecision {
  id: string;
  kind: 'answer' | 'plan_review';
  outcome: 'answered' | 'approved' | 'revision_requested';
  prompt: string | null;
  selections: string[];
  note: string | null;
  source: 'user';
  execution_id?: string | null;
  kode_session_id: number | null;
  at: string;
}

export interface SpecOpsSession {
  id: string;
  title?: string;
  backend_key?: string;
  run_id?: string | null;
  phase?: string;
  state?: string;
  execution?: {
    state: 'live' | 'resumable' | 'restartable' | 'detached' | 'unverified' | 'unavailable' | 'history';
    resume_mode: 'exact' | 'fresh_context' | 'none';
    last_reconciled_at?: string | null;
    last_error?: string | null;
  };
  current_execution?: ExecutionIdentity | null;
  document_path?: string;
  required_action?: RequiredAction | null;
  decisions?: SessionDecision[];
  workflow_applicable?: boolean;
  workflow?: { current_phase?: string; failure_count?: number; steps?: WorkflowStep[] };
  agents?: SessionAgent[];
  transcript?: TranscriptEntry[];
  updated_at?: string;
}

export type ScheduledTaskState = 'blocked' | 'ready' | 'running' | 'verifying' | 'reviewing' | 'completed' | 'failed' | 'cancelled';

export interface ScheduledTask {
  id: string;
  title: string;
  depends_on: string[];
  state: ScheduledTaskState;
  attempt: number;
  assigned_agent: string | null;
  worktree: string | null;
  updated_at: string;
}

export interface HarnessControlState {
  run_id: string;
  run_state: string;
  tasks: ScheduledTask[];
  updated_at: string;
}
