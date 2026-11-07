// Review mode of the Changes panel: the agent's changes one part at a time, file by file. Keep (k)
// and Revert (r) use the panel's own Keep and Revert part actions, so the app's rules hold (a part
// that touches lines the user edited is never undone); n and p step, c comments on the part. The
// comments become a message in the message box for the user to send, never sent on their own.
// A new file or a deleted one is one part: Keep and Revert act on the whole file.
import type { FileChange } from '@orka/core';
import { t, tn } from '@orka/core/src/i18n';
import type { HunkView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';
import { type Highlighter, hunkBodyHtml } from './hunks';

export type ReviewAction = 'kept' | 'reverted' | 'left';

export interface ReviewFile {
  path: string;
  relPath: string;
  status: FileChange['status'];
  added?: number;
  removed?: number;
}

export interface ReviewState {
  files: ReviewFile[];
  /** Where the review is: a file, and a part of it. */
  file: number;
  hunk: number;
  /** Each modified file's parts, once the app sent them (undefined while asked for). */
  hunks: Map<string, HunkView[] | undefined>;
  /** Each modified file's number of parts, also those past the ones the app sends. */
  totals: Map<string, number>;
  /** What happened to each part acted on ("left": the app kept it as it was, e.g. it touches your edits). */
  outcome: Array<{ relPath: string; header: string; action: ReviewAction }>;
  /**
   * A Keep or Revert sent for a part, until the file's parts come back; or a Revert of a whole
   * file, until the app says whether it reverted it.
   */
  pending?: { path: string; relPath: string; header: string; action: 'kept' | 'reverted'; count: number; whole?: boolean };
  comments: Array<{ relPath: string; header: string; text: string }>;
  commenting: boolean;
  /** Past the last part: the summary shows. */
  done: boolean;
}

export function startReview(changes: readonly FileChange[]): ReviewState {
  return {
    files: changes.map((c) => ({ path: c.absPath, relPath: c.relPath, status: c.status, added: c.added, removed: c.removed })),
    file: 0,
    hunk: 0,
    hunks: new Map(),
    totals: new Map(),
    outcome: [],
    comments: [],
    commenting: false,
    done: !changes.length,
  };
}

/** A modified file's parts; a new or deleted file is one part. undefined while they are asked for. */
function parts(state: ReviewState, file: ReviewFile): number | undefined {
  if (file.status !== 'modified') return 1;
  return state.hunks.get(file.path)?.length;
}

/** The modified file whose parts the page must ask for now (the one under review), if any. */
export function hunksToFetch(state: ReviewState): string | undefined {
  const file = state.files[state.file];
  return !state.done && file?.status === 'modified' && !state.hunks.has(file.path) ? file.path : undefined;
}

/** The file and part under review. */
export function currentPart(state: ReviewState): { file: ReviewFile; hunk?: HunkView; index: number; total?: number } | undefined {
  const file = state.files[state.file];
  if (state.done || !file) return undefined;
  return { file, hunk: state.hunks.get(file.path)?.[state.hunk], index: state.hunk, total: parts(state, file) };
}

/** Step to the next part (n) or the previous one (p), across files; past the last one the summary shows. */
export function step(state: ReviewState, direction: 1 | -1): void {
  state.commenting = false;
  if (state.done) {
    if (direction === -1 && state.files.length) {
      state.done = false;
      state.file = state.files.length - 1;
      state.hunk = lastPart(state);
    }
    return;
  }
  const total = parts(state, state.files[state.file]!) ?? 1;
  if (direction === 1) {
    if (state.hunk + 1 < total) state.hunk++;
    else nextFile(state);
  } else if (state.hunk > 0) state.hunk--;
  else if (state.file > 0) {
    state.file--;
    state.hunk = lastPart(state);
  }
}

/** The last part of the file under review; while its parts are unknown, a mark the parts clamp to when they come. */
function lastPart(state: ReviewState): number {
  const total = parts(state, state.files[state.file]!);
  return total === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, total - 1);
}

function nextFile(state: ReviewState): void {
  state.hunk = 0;
  for (state.file++; state.file < state.files.length; state.file++) {
    // A file with no parts left (all decided, or it left the list) is passed over.
    if (parts(state, state.files[state.file]!) !== 0) return;
  }
  state.done = true;
}

/**
 * Keep or revert the part under review: what the page must post, or undefined when there is
 * nothing to act on. A whole file is kept at once; its Revert waits for the app's answer (it may
 * do nothing: another session works nearby, or the user edited the file and cancels). A part
 * waits for the file's parts to come back.
 */
export function decide(
  state: ReviewState,
  action: 'kept' | 'reverted',
):
  | { type: 'keepHunk' | 'revertHunk'; path: string; index: number; header: string }
  | { type: 'acceptChange' | 'revertChange'; path: string }
  | undefined {
  const part = currentPart(state);
  if (!part || state.pending) return undefined;
  if (part.file.status !== 'modified') {
    if (action === 'reverted') {
      state.pending = { path: part.file.path, relPath: part.file.relPath, header: '', action, count: 1, whole: true };
      return { type: 'revertChange', path: part.file.path };
    }
    state.outcome.push({ relPath: part.file.relPath, header: '', action });
    nextFile(state);
    return { type: 'acceptChange', path: part.file.path };
  }
  if (!part.hunk) return undefined;
  const count = state.totals.get(part.file.path) ?? part.total ?? 0;
  state.pending = { path: part.file.path, relPath: part.file.relPath, header: part.hunk.header, action, count };
  return { type: action === 'kept' ? 'keepHunk' : 'revertHunk', path: part.file.path, index: part.index, header: part.hunk.header };
}

/** The app's answer to a whole file's Revert: reverted, or left as it was. The review then moves on. */
export function receiveRevert(state: ReviewState, path: string, reverted: boolean): void {
  const pending = state.pending;
  if (!pending?.whole || pending.path !== path) return;
  state.pending = undefined;
  state.outcome.push({ relPath: pending.relPath, header: '', action: reverted ? 'reverted' : 'left' });
  if (!state.done && state.files[state.file]?.path === path) nextFile(state);
}

/**
 * A file's parts from the app (`total`: all of them, also past the ones sent). A pending decision
 * counts when the file lost a part; otherwise the app left it as it was. The position stays on the
 * same index, which is now the next part.
 */
export function receiveHunks(state: ReviewState, path: string, hunks: HunkView[], total = hunks.length): void {
  if (!state.files.some((f) => f.path === path)) return;
  state.hunks.set(path, hunks);
  state.totals.set(path, total);
  const pending = state.pending;
  if (pending?.path === path && !pending.whole) {
    state.pending = undefined;
    const applied = total < pending.count;
    state.outcome.push({ relPath: pending.relPath, header: pending.header, action: applied ? pending.action : 'left' });
    // A part that stayed is passed: the user decided, the app could not.
    if (!applied) step(state, 1);
  }
  const file = state.files[state.file];
  if (!state.done && file?.path === path && state.hunk >= hunks.length) {
    if (hunks.length && state.hunk > 0 && !pending) state.hunk = hunks.length - 1;
    else nextFile(state);
  }
}

/** A file that left the Changes list (all kept or reverted elsewhere) has no parts left. */
export function syncFiles(state: ReviewState, changes: readonly FileChange[]): void {
  for (const file of state.files) if (file.status === 'modified' && !changes.some((c) => c.absPath === file.path)) state.hunks.set(file.path, []);
  const file = state.files[state.file];
  if (!state.done && file && parts(state, file) === 0) nextFile(state);
}

export function addComment(state: ReviewState, text: string): boolean {
  const part = currentPart(state);
  const clean = text.trim().slice(0, 4000);
  if (!part || !clean) return false;
  state.comments.push({ relPath: part.file.relPath, header: part.hunk?.header ?? '', text: clean });
  state.commenting = false;
  return true;
}

export function counts(state: ReviewState): Record<ReviewAction, number> {
  const out: Record<ReviewAction, number> = { kept: 0, reverted: 0, left: 0 };
  for (const o of state.outcome) out[o.action]++;
  return out;
}

/** The review as a message to the agent: each comment with its file and part, then what was kept and reverted. */
export function feedbackText(state: ReviewState): string {
  const c = counts(state);
  const lines = [t('Feedback on your changes:')];
  for (const comment of state.comments) lines.push(`- ${comment.relPath}${comment.header ? ` (${comment.header})` : ''}: ${comment.text}`);
  const reverted = state.outcome.filter((o) => o.action === 'reverted');
  if (reverted.length) lines.push(t('I reverted: {parts}.', { parts: reverted.map((o) => (o.header ? `${o.relPath} (${o.header})` : o.relPath)).join(', ') }));
  if (c.kept) lines.push(tn('I kept {n} part.', 'I kept {n} parts.', c.kept));
  return lines.join('\n');
}

function summaryHtml(state: ReviewState): string {
  const c = counts(state);
  const item = (label: string, n: number, cls: string) => `<li class="${cls}"><strong>${n}</strong> ${escapeHtml(label)}</li>`;
  return `<div class="review-summary">
    <strong>${escapeHtml(t('Review finished'))}</strong>
    <ul class="review-counts">
      ${item(t('kept'), c.kept, 'kept')}${item(t('reverted'), c.reverted, 'reverted')}${c.left ? item(t('left as they were'), c.left, 'left') : ''}${item(tn('comment', 'comments', state.comments.length), state.comments.length, 'comments')}
    </ul>
    ${
      c.left
        ? `<p class="muted small">${escapeHtml(t('Parts that touch lines you edited, or that changed in the meantime, stay as they are.'))}</p>`
        : ''
    }
    ${
      state.comments.length
        ? `<ul class="review-comments">${state.comments
            .map((cm) => `<li><span class="mono small">${escapeHtml(cm.relPath)}${cm.header ? ` ${escapeHtml(cm.header)}` : ''}</span><br>${escapeHtml(cm.text)}</li>`)
            .join('')}</ul>`
        : ''
    }
  </div>`;
}

const KEY = (k: string) => `<kbd>${escapeHtml(k)}</kbd>`;

/** The review in the Changes panel. `running`: the agent works, so nothing is reverted until it stops. */
export function reviewHtml(state: ReviewState, options: { highlight?: Highlighter; running?: boolean } = {}): string {
  const part = currentPart(state);
  const position = state.files.length ? Math.min(state.file + 1, state.files.length) : 0;
  const head = `<div class="panel-head review-head">
      <strong>${escapeHtml(t('Review'))}</strong>
      <span class="muted">${escapeHtml(state.done ? t('Summary') : t('File {n} of {total}', { n: position, total: state.files.length }))}</span>
      <span class="spacer"></span>
      ${state.comments.length && !state.done ? `<button class="link" data-action="review-feedback" title="${attr(t('Put feedback in the message box'))}">${escapeHtml(t('To message box'))}</button>` : ''}
      <button class="icon-btn" data-action="review-close" aria-label="${attr(t('Close review'))}" title="${attr(t('Close review (Esc)'))}">${icon('x')}</button>
    </div>`;
  if (!part) {
    return `<div class="review" tabindex="-1" aria-label="${attr(t('Review'))}">${head}${summaryHtml(state)}
      <div class="key-row wrap">
        ${state.comments.length ? `<button class="btn primary" data-action="review-feedback">${escapeHtml(t('Put feedback in the message box'))}</button>` : ''}
        <button class="btn" data-action="review-close">${escapeHtml(t('Close'))}</button>
      </div></div>`;
  }
  const { file, hunk, index, total } = part;
  const whole = file.status !== 'modified';
  const busy = !!state.pending;
  const body = whole
    ? `<div class="review-whole muted">${escapeHtml(file.status === 'added' ? t('New file') : t('Deleted file'))}${
        file.added ? ` <span class="stat add">+${Number(file.added) || 0}</span>` : ''
      }${file.removed ? ` <span class="stat del">−${Number(file.removed) || 0}</span>` : ''}
        <button class="link" data-action="diff" data-path="${attr(file.path)}">${escapeHtml(t('Show diff'))}</button></div>`
    : hunk
      ? `<div class="hunk"><div class="hunk-head"><span class="mono muted">${escapeHtml(hunk.header)}</span></div>${hunkBodyHtml(file.relPath, hunk, options.highlight)}</div>`
      : `<div class="hunks"><span class="spinner small"></span></div>`;
  const partLabel = whole ? t('Whole file') : total === undefined ? '' : t('Part {n} of {total}', { n: Math.min(index + 1, total), total });
  const revertTitle = options.running ? t('Revert waits until the agent stops.') : whole ? t('Undo the whole file') : t('Undo only this part of the change');
  const comments = state.comments.filter((c) => c.relPath === file.relPath && c.header === (hunk?.header ?? ''));
  return `<div class="review" tabindex="-1" aria-label="${attr(t('Review'))}">${head}
    <div class="review-file"><span class="badge ${attr(file.status)}">${escapeHtml({ added: 'A', modified: 'M', deleted: 'D' }[file.status] ?? '')}</span>
      <button class="file mono" data-action="diff" data-path="${attr(file.path)}" title="${attr(t('Show diff'))}">${escapeHtml(file.relPath)}</button>
      <span class="spacer"></span><span class="muted small">${escapeHtml(partLabel)}</span></div>
    ${body}
    ${comments.map((c) => `<div class="review-comment">${icon('edit')}<span>${escapeHtml(c.text)}</span></div>`).join('')}
    ${
      state.commenting
        ? `<div class="review-comment-box"><textarea id="review-comment" rows="3" placeholder="${attr(t('What should the agent change here?'))}" aria-label="${attr(t('Comment on this part'))}"></textarea>
          <div class="key-row wrap"><button class="btn primary" data-action="review-comment-save">${escapeHtml(t('Add comment'))}</button>
          <button class="btn" data-action="review-comment-cancel">${escapeHtml(t('Cancel'))}</button><span class="muted small">${escapeHtml(t('Ctrl+Enter adds it'))}</span></div></div>`
        : ''
    }
    <div class="review-actions">
      <button class="btn" data-action="review-prev" title="${attr(t('Previous part (p)'))}"${state.file === 0 && index === 0 ? ' disabled' : ''}>${icon('back')}${KEY('p')}</button>
      <button class="btn primary" data-action="review-keep" title="${attr(whole ? t('Keep the whole file') : t('Keep this change'))}"${busy ? ' disabled' : ''}>${icon('check')}${escapeHtml(t('Keep'))} ${KEY('k')}</button>
      <button class="btn" data-action="review-revert" title="${attr(revertTitle)}"${busy || options.running ? ' disabled' : ''}>${icon('undo')}${escapeHtml(t('Revert'))} ${KEY('r')}</button>
      <button class="btn" data-action="review-comment" title="${attr(t('Comment on this part (c)'))}">${icon('edit')}${escapeHtml(t('Comment'))} ${KEY('c')}</button>
      <button class="btn" data-action="review-next" title="${attr(t('Next part (n)'))}">${KEY('n')}${icon('forward')}</button>
    </div>
  </div>`;
}
