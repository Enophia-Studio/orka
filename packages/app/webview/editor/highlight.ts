// Highlighting a few lines of code outside an editor (the hunks in Changes): the grammar parses
// them once, and every text run comes out escaped, inside <span class="tok-…"> and nothing else.
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { languageFor } from './languages';

/** More lines than a hunk shows are left plain. */
export const MAX_HIGHLIGHT_LINES = 80;

export function highlightLines(path: string, lines: string[]): string[] | undefined {
  if (!Array.isArray(lines) || lines.length > MAX_HIGHLIGHT_LINES || lines.some((line) => typeof line !== 'string')) return undefined;
  const entry = languageFor(path);
  if (!entry) return undefined;
  const code = lines.join('\n');
  const out = [''];
  try {
    const tree = entry.language.parser.parse(code);
    highlightCode(
      code,
      tree,
      classHighlighter,
      (text, classes) => {
        const escaped = escapeHtml(text);
        // classHighlighter's names are letters and dashes; anything else is dropped, never put into markup.
        const safe = classes.replace(/[^\w -]/g, '').trim();
        out[out.length - 1] += safe ? `<span class="${safe}">${escaped}</span>` : escaped;
      },
      () => out.push(''),
    );
  } catch {
    return undefined;
  }
  // A line that held a line break of its own would shift the rest: plain text then.
  return out.length === lines.length ? out : undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
