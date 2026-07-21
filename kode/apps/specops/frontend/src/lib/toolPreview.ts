// Ported from apps/specops/src/server/public/tool-preview.js.
// Pure parser only — DOM building is handled by ToolCard.svelte using Svelte.
// The function name and semantics are kept identical so the existing unit test
// (tests/tool-preview-parser.test.ts) can be re-pointed at this module.

export type ParsedPreview =
  | { kind: 'json'; value: unknown }
  | { kind: 'kv'; lines: Array<{ indent?: string; key?: string; value?: string; raw?: string }> }
  | { kind: 'text'; value: string };

/**
 * Parse a tool preview string. Never throws — returns text fallback on any
 * unexpected input.
 */
export function parseToolPreview(preview: unknown): ParsedPreview {
  if (typeof preview !== 'string' || preview.length === 0) {
    return { kind: 'text', value: '' };
  }
  const trimmed = preview.trim();
  if (trimmed.length === 0) {
    return { kind: 'text', value: preview };
  }

  // 1. JSON? Only attempt when it looks structurally like JSON — leading
  //    { or [ — so we don't try (and reject) every free-text string.
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object') {
        return { kind: 'json', value };
      }
    } catch {
      // fall through
    }
  }

  // 2. Multi-line key:value form. Require >= 2 lines that each match
  //    `^\s*[\w.\-]+\s*:\s*` so we don't misclassify prose with a colon.
  const lines = preview.split(/\r?\n/);
  const kvLines: Array<{ indent?: string; key?: string; value?: string; raw?: string }> = [];
  let kvMatches = 0;
  for (const line of lines) {
    const m = line.match(/^(\s*)([\w.-]+)\s*:\s*(.*)$/);
    if (m) {
      kvMatches++;
      kvLines.push({ indent: m[1] || '', key: m[2] || '', value: m[3] || '' });
    } else {
      kvLines.push({ raw: line });
    }
  }
  if (kvMatches >= 2) {
    return { kind: 'kv', lines: kvLines };
  }

  return { kind: 'text', value: preview };
}
