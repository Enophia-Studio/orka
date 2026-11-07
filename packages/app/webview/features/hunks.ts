// The parts (hunks) of a changed file in the Changes panel, with their Keep and Revert part buttons.
// In the desktop app the code is syntax-highlighted by the editor bundle's highlighter; without it
// (VS Code, the classic layout) every line is plain escaped text, exactly as before.
import type { FileChange } from '@orka/core';
import { t } from '@orka/core/src/i18n';
import type { HunkView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

/** window.orkaEditor.highlightLines: escaped HTML per line, or undefined to leave the lines plain. */
export type Highlighter = (path: string, lines: string[]) => string[] | undefined;

export interface HunksOptions {
  highlight?: Highlighter;
  /** Put each hunk's header on its buttons, so the app can tell a part that moved on since (desktop only). */
  withHeader?: boolean;
}

/** Highlighted lines by file, hunk header and text: the Changes panel re-renders on every change event. */
const cache = new Map<string, Array<string | undefined>>();
const MAX_CACHED = 200;

export function hunksHtml(change: Pick<FileChange, 'absPath' | 'relPath'>, hunks: HunkView[] | undefined, options: HunksOptions = {}): string {
  if (!hunks) return `<div class="hunks"><span class="spinner small"></span></div>`;
  if (!hunks.length) return `<div class="hunks muted small">${escapeHtml(t('No differences.'))}</div>`;
  return `<div class="hunks">${hunks
    .map((h, i) => {
      const header = options.withHeader ? ` data-header="${attr(h.header)}"` : '';
      return `<div class="hunk">
      <div class="hunk-head"><span class="mono muted">${escapeHtml(h.header)}</span><span class="spacer"></span>
        <button class="link" data-action="keep-hunk" data-path="${attr(change.absPath)}" data-index="${i}"${header} title="${attr(t('Keep this change'))}">${icon('check')}${escapeHtml(t('Keep'))}</button>
        <button class="link" data-action="revert-hunk" data-path="${attr(change.absPath)}" data-index="${i}"${header} title="${attr(t('Undo only this part of the change'))}">${icon('undo')}${escapeHtml(t('Revert part'))}</button></div>
      ${hunkBodyHtml(change.relPath, h, options.highlight)}
    </div>`;
    })
    .join('')}</div>`;
}

/** A hunk's lines: + and - lines marked, highlighted when a highlighter is given, escaped otherwise. */
export function hunkBodyHtml(relPath: string, h: HunkView, highlight?: Highlighter): string {
  const code = highlight ? highlighted(relPath, h, highlight) : [];
  return `<pre class="hunk-body mono">${h.lines
    .map((l, j) => `<span class="hl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}">${escapeHtml(l.type)}${code[j] ?? escapeHtml(l.text)}</span>`)
    .join('\n')}${h.hidden ? `\n<span class="muted">${escapeHtml(t('… {n} more lines', { n: h.hidden }))}</span>` : ''}</pre>`;
}

/**
 * Each line of a hunk as highlighted HTML (undefined: plain). The old side (context and removed
 * lines) and the new side (context and added lines) are each parsed as one piece of code, so a
 * line is coloured in the context it had; context lines take the new side's colours.
 */
function highlighted(path: string, hunk: HunkView, highlight: Highlighter): Array<string | undefined> {
  const key = `${path}\n${hunk.header}\n${hunk.lines.map((l) => l.type + l.text).join('\n')}`;
  const known = cache.get(key);
  if (known) return known;
  const out: Array<string | undefined> = new Array(hunk.lines.length).fill(undefined);
  const side = (keep: (type: HunkView['lines'][number]['type']) => boolean) => {
    const index = hunk.lines.flatMap((l, j) => (keep(l.type) ? [j] : []));
    if (!index.length) return;
    let html: string[] | undefined;
    try {
      html = highlight(path, index.map((j) => hunk.lines[j]!.text));
    } catch {
      return;
    }
    // Anything but one string per line leaves the side plain.
    if (!Array.isArray(html) || html.length !== index.length || html.some((s) => typeof s !== 'string')) return;
    index.forEach((j, k) => (out[j] = html![k]));
  };
  side((type) => type !== '+');
  side((type) => type !== '-');
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, out);
  return out;
}
