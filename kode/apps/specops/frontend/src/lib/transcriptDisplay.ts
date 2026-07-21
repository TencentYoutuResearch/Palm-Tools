import type { TranscriptEntry } from './types.ts';

export type TranscriptDisplayItem =
  | { kind: 'message'; entry: TranscriptEntry; key: string }
  | { kind: 'tool'; entry: TranscriptEntry; resultEntry: TranscriptEntry | undefined; key: string };

function toolCallId(entry: TranscriptEntry): string | null {
  const id = entry.tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function createTranscriptDisplayItems(entries: TranscriptEntry[]): TranscriptDisplayItem[] {
  const useIds = new Set<string>();
  const firstResults = new Map<string, TranscriptEntry>();

  for (const entry of entries) {
    const id = toolCallId(entry);
    if (!id) continue;

    if (entry.kind === 'tool_use') {
      useIds.add(id);
    } else if (entry.kind === 'tool_result' && !firstResults.has(id)) {
      firstResults.set(id, entry);
    }
  }

  const displayItems: TranscriptDisplayItem[] = [];
  const emittedUnpairedResults = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'tool_use') {
      const id = toolCallId(entry);
      displayItems.push({
        kind: 'tool',
        entry,
        resultEntry: id ? firstResults.get(id) : undefined,
        key: id ? `tool:${id}` : `tool-use:${index}`,
      });
      continue;
    }

    if (entry.kind === 'tool_result') {
      const id = toolCallId(entry);
      if (!id) {
        displayItems.push({ kind: 'tool', entry, resultEntry: undefined, key: `tool-result:${index}` });
        continue;
      }

      if (useIds.has(id)) continue;
      if (emittedUnpairedResults.has(id)) continue;

      emittedUnpairedResults.add(id);
      displayItems.push({ kind: 'tool', entry, resultEntry: undefined, key: `tool-result:${id}` });
      continue;
    }

    displayItems.push({ kind: 'message', entry, key: `message:${index}` });
  }

  return displayItems;
}
