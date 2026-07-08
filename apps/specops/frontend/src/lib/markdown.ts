import { marked } from 'marked';

// Configure marked once for our rendering context.
marked.setOptions({
  gfm: true,
  breaks: false,
});

export interface RenderedMarkdown {
  html: string;
}

export function renderMarkdown(source: string): RenderedMarkdown {
  // marked.parse can return string | Promise<string> under async mode.
  // We use sync, so cast.
  const html = marked.parse(source, { async: false }) as string;
  return { html };
}
