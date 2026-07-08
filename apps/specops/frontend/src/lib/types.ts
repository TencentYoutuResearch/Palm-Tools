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
  | 'proposed'
  | 'completed'
  | 'archived';

export interface RegistryFile {
  name: string;
  path: string;
}

export interface RegistryEntry {
  id: string;
  kind: DocumentKind;
  title: string;
  status: DocumentStatus;
  path: string;
  verifies: string[];
  paths: string[];
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
}

export interface SpecFrontmatter {
  schema_version: 1;
  id: string;
  kind: DocumentKind;
  title: string;
  status: DocumentStatus;
  verifies?: string[];
  paths?: string[];
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
  kode_session_id?: number;
}

export interface SessionAgent {
  kode_session_id: number;
  backend_key: string;
  model?: string;
  purpose: string;
  status: string;
  started_at?: string;
}

export interface WorkflowStep {
  id: string;
  state: 'pending' | 'active' | 'done' | 'failed';
  started_at?: string;
  completed_at?: string;
}

export interface RequiredActionOption {
  label: string;
  description?: string;
}

export interface RequiredAction {
  kind: string;
  prompt?: string;
  question_id?: string;
  header?: string;
  options?: RequiredActionOption[];
  multi_select?: boolean;
  plan_id?: string;
  markdown?: string;
  title?: string;
  message?: string;
  options_simple?: Array<{ id: string; label: string }>;
  patch_files?: string[];
  review_note?: string;
  [key: string]: unknown;
}

export interface SpecOpsSession {
  id: string;
  title?: string;
  backend_key?: string;
  phase?: string;
  state?: string;
  document_path?: string;
  required_action?: RequiredAction | null;
  workflow?: { current_phase?: string; failure_count?: number; steps?: WorkflowStep[] };
  agents?: SessionAgent[];
  transcript?: TranscriptEntry[];
  updated_at?: string;
}
