import { writable, get } from 'svelte/store';
import { api } from '../api';
import type { HistoryCommit } from '../types';

export const commits = writable<HistoryCommit[]>([]);
export const commitsLoading = writable<boolean>(false);
export const commitsError = writable<string | null>(null);

export const selectedCommit = writable<HistoryCommit | null>(null);
export const commitDiff = writable<string>('');
export const diffLoading = writable<boolean>(false);

export async function loadHistory(docPath: string): Promise<void> {
  commits.set([]);
  commitsError.set(null);
  commitsLoading.set(true);
  try {
    const res = await api.get<{ commits: HistoryCommit[]; warning?: string }>(
      `/api/document/history?path=${encodeURIComponent(docPath)}`,
    );
    commits.set(res.commits ?? []);
    if (res.warning) commitsError.set(res.warning);
  } catch (err) {
    commitsError.set(err instanceof Error ? err.message : String(err));
  } finally {
    commitsLoading.set(false);
  }
}

export async function loadDiff(docPath: string, hash: string): Promise<void> {
  diffLoading.set(true);
  commitDiff.set('');
  try {
    const res = await api.get<{ hash: string; diff: string; warning?: string }>(
      `/api/document/diff?path=${encodeURIComponent(docPath)}&hash=${encodeURIComponent(hash)}`,
    );
    commitDiff.set(res.diff ?? '');
    if (res.warning && get(commitsError) === null) commitsError.set(res.warning);
  } catch (err) {
    commitsError.set(err instanceof Error ? err.message : String(err));
  } finally {
    diffLoading.set(false);
  }
}

export function selectCommit(c: HistoryCommit | null): void {
  selectedCommit.set(c);
  commitDiff.set('');
}
