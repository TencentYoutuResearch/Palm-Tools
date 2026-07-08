import { writable, type Writable } from 'svelte/store';
import { api } from '../api';
import type { DocumentResponse, RegistryEntry, WorkspaceState } from '../types';

export const workspaceState = writable<WorkspaceState | null>(null);
export const stateError = writable<string | null>(null);

export const selectedDoc = writable<RegistryEntry | null>(null);
export const selectedDocContent = writable<DocumentResponse | null>(null);
export const docLoading = writable<boolean>(false);

export interface SelectedTextContext {
  path: string;
  text: string;
  lineStart: number | null;
  lineEnd: number | null;
  blockId?: string;
  blockKind?: string;
}

export const selectedTextContext = writable<SelectedTextContext | null>(null);

/** Expanded change-folder node ids (UI state only). */
export const expandedNodes: Writable<Set<string>> = writable(new Set());

export function toggleNode(id: string): void {
  expandedNodes.update((set) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

export async function loadState(): Promise<void> {
  try {
    const state = await api.get<WorkspaceState>('/api/state');
    workspaceState.set(state);
    stateError.set(null);
  } catch (err) {
    stateError.set(err instanceof Error ? err.message : String(err));
  }
}

/** Re-fetch workspace state (same as loadState). */
export const refreshState = loadState;

/**
 * Cross-module navigation intent:
 * When set to a document path, the consuming component should switch to
 * the iwiki module and select that document, then clear the intent.
 */
export const pendingDocSelection = writable<string | null>(null);

export async function selectDocument(entry: RegistryEntry): Promise<void> {
  selectedDoc.set(entry);
  selectedTextContext.set(null);
  selectedDocContent.set(null);
  docLoading.set(true);
  try {
    const res = await api.get<DocumentResponse>(
      `/api/document?path=${encodeURIComponent(entry.path)}`,
    );
    selectedDocContent.set(res);
  } catch {
    selectedDocContent.set(null);
  } finally {
    docLoading.set(false);
  }
}
