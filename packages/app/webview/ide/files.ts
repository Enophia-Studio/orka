// The desktop app's Files tab and editor pane: HTML for the folder tree, the editor's head, banner
// and status line, and the Chat | file switch in the title bar. Paths are workspace-relative with
// forward slashes, exactly as the app reports them; every name and path is escaped.
import type { FileChange } from '@orka/core';
import { t } from '@orka/core/src/i18n';
import type { DirEntry, Eol, FileReason, SaveRefusal } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

/** A folder of the tree as the app listed it (or is listing it). */
export type DirState = { entries: DirEntry[]; truncated?: boolean } | { error: 'outside' | 'notFound' } | 'loading';

export interface TreeView {
  /** Listed folders by path ('' is the folder itself). */
  dirs: ReadonlyMap<string, DirState>;
  expanded: ReadonlySet<string>;
  /** The task's changed files, by path. */
  changes: ReadonlyMap<string, Pick<FileChange, 'status' | 'userEdited'>>;
  /** The file open in the editor, and whether it has unsaved changes. */
  open?: string;
  dirty: boolean;
  /** The row that takes Tab focus; the first row when it is not shown. */
  focus?: string;
}

/** A changed file's path as the tree and the editor name it. */
export function changePath(change: Pick<FileChange, 'relPath'>): string {
  return change.relPath.replace(/\\/g, '/');
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The tree: a flat list of rows with their level, as ARIA's tree pattern allows. */
export function fileTreeHtml(v: TreeView): string {
  const rows: string[] = [];
  let focusShown = false;
  const tabindex = (path: string) => {
    if (path !== v.focus) return '-1';
    focusShown = true;
    return '0';
  };
  const badge = { added: 'A', modified: 'M', deleted: 'D' } as const;
  const badgeTitle = { added: t('Added by the agent'), modified: t('Changed by the agent'), deleted: t('Deleted by the agent') } as const;

  const walk = (dir: string, level: number) => {
    const state = v.dirs.get(dir);
    if (!state || state === 'loading') {
      rows.push(`<div class="tree-note" data-level="${level}"><span class="spinner small"></span><span class="muted">${escapeHtml(t('Loading…'))}</span></div>`);
      return;
    }
    if ('error' in state) {
      rows.push(`<div class="tree-note muted" data-level="${level}">${escapeHtml(state.error === 'outside' ? t('Outside the folder') : t('Not found'))}</div>`);
      return;
    }
    if (!state.entries.length && level === 1) rows.push(`<div class="tree-note muted" data-level="${level}">${escapeHtml(t('This folder is empty.'))}</div>`);
    for (const entry of state.entries) {
      const path = join(dir, entry.name);
      const link = entry.link ? `<span class="tree-link" title="${attr(t('A link to a place inside the folder'))}">${icon('handoff')}</span>` : '';
      if (entry.kind === 'dir') {
        const open = v.expanded.has(path);
        rows.push(
          `<div class="tree-row dir${entry.ignored ? ' ignored' : ''}" role="treeitem" aria-level="${level}" aria-expanded="${open}" data-level="${level}" data-action="toggle-dir" data-path="${attr(path)}" tabindex="${tabindex(path)}"${
            entry.ignored ? ` title="${attr(t('A dependency or build folder'))}"` : ''
          }>${icon('chevron', 'tree-chevron')}${icon('folder')}<span class="tree-name">${escapeHtml(entry.name)}</span>${link}</div>`,
        );
        if (open) walk(path, level + 1);
        continue;
      }
      const change = v.changes.get(path);
      const current = path === v.open;
      const marks =
        (current && v.dirty ? `<span class="dirty-dot" title="${attr(t('Unsaved changes'))}"></span>` : '') +
        (change?.userEdited ? `<span class="tree-mark" title="${attr(t('Edited by you'))}">${icon('edit')}</span>` : '') +
        (change ? `<span class="badge ${attr(change.status)}" title="${attr(badgeTitle[change.status])}">${badge[change.status]}</span>` : '');
      rows.push(
        `<div class="tree-row file${current ? ' current' : ''}" role="treeitem" aria-level="${level}" aria-selected="${current}" data-level="${level}" data-action="open-file-node" data-path="${attr(path)}" tabindex="${tabindex(path)}"><span class="tree-chevron-space"></span>${icon('read')}<span class="tree-name">${escapeHtml(entry.name)}</span>${link}${marks}</div>`,
      );
    }
    if (state.truncated) {
      rows.push(`<div class="tree-note muted" data-level="${level}">${escapeHtml(t('Only the first {n} entries are shown.', { n: state.entries.length }))}</div>`);
    }
  };
  walk('', 1);
  // Tab reaches the tree on its first row when the remembered one is gone.
  if (!focusShown) {
    const first = rows.findIndex((row) => row.includes('role="treeitem"'));
    if (first >= 0) rows[first] = rows[first].replace('tabindex="-1"', 'tabindex="0"');
  }
  return rows.join('');
}

/** Rows are indented by their level; the page's CSP blocks style attributes, so it is set through the CSSOM. */
export function indentTree(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-level]').forEach((row) => row.style.setProperty('--level', String(Number(row.dataset.level) || 1)));
}

/** The Files tab's content: its head (the folder, Refresh) and the tree. */
export function filesPanelHtml(folderName: string, tree: string): string {
  return `<div class="panel-head"><strong>${escapeHtml(t('Files'))}</strong><span class="muted ellipsis" title="${attr(folderName)}">${escapeHtml(folderName)}</span><span class="spacer"></span>
      <button class="icon-btn" data-action="refresh-files" aria-label="${attr(t('Refresh'))}" title="${attr(t('Refresh'))}">${icon('refresh')}</button></div>
    <div class="file-tree" role="tree" aria-label="${attr(t('Files'))}">${tree}</div>`;
}

/** Files in the session list's footer and in its rail. */
export function filesEntryHtml(where: 'list' | 'rail'): string {
  const label = t('Files');
  const title = `${label} (Ctrl+Shift+E)`;
  return where === 'rail'
    ? `<button class="icon-btn" data-action="open-files" aria-label="${attr(label)}" title="${attr(title)}">${icon('files')}</button>`
    : `<button class="side-link" data-action="open-files" title="${attr(title)}">${icon('files')}<span>${escapeHtml(label)}</span></button>`;
}

/** The title bar's switch between the conversation and the open file. */
export function viewSwitchHtml(v: { editorShown: boolean; path: string; dirty: boolean }): string {
  const name = v.path.split('/').pop() ?? v.path;
  return `<div class="view-switch" role="group" aria-label="${attr(t('Show'))}">
      <button class="${v.editorShown ? '' : 'on'}" data-action="show-chat" aria-pressed="${!v.editorShown}">${escapeHtml(t('Chat'))}</button>
      <button class="${v.editorShown ? 'on' : ''}" data-action="show-editor" aria-pressed="${v.editorShown}" title="${attr(v.path)}">${icon('read')}<span class="ellipsis">${escapeHtml(name)}</span>${
        v.dirty ? `<span class="dirty-dot" title="${attr(t('Unsaved changes'))}"></span>` : ''
      }</button></div>`;
}

export interface EditorHeadView {
  path: string;
  /** The file's text is in the editor (not loading, not refused). */
  loaded: boolean;
  dirty: boolean;
  readOnly: boolean;
  /** An agent works: saving waits until it stops. */
  running: boolean;
  saving: boolean;
  /** Text is selected: Send selection is offered. */
  hasSelection: boolean;
}

export function editorHeadHtml(v: EditorHeadView): string {
  const slash = v.path.lastIndexOf('/');
  const dir = slash >= 0 ? v.path.slice(0, slash + 1) : '';
  const name = v.path.slice(slash + 1);
  const why = !v.loaded
    ? ''
    : v.readOnly
      ? t('Read-only: mixed line endings')
      : v.running
        ? t('The Agent is working; save when it stops.')
        : v.saving
          ? t('Saving…')
          : !v.dirty
            ? t('No unsaved changes')
            : '';
  const save = v.loaded
    ? `<button class="btn small primary" data-action="save-file"${why ? ' disabled' : ''} title="${attr(why || `${t('Save')} (Ctrl+S)`)}">${escapeHtml(t('Save'))}</button>`
    : '';
  return `<div class="editor-path" title="${attr(v.path)}"><span class="muted ellipsis">${escapeHtml(dir)}</span><strong>${escapeHtml(name)}</strong>${
    v.dirty ? `<span class="dirty-dot" title="${attr(t('Unsaved changes'))}"></span>` : ''
  }</div>
    <span class="spacer"></span>
    ${
      v.loaded
        ? `<button class="btn small" data-action="send-selection"${v.hasSelection ? '' : ' disabled'} title="${attr(`${t('Send selection to Agent')} (Ctrl+L)`)}">${icon('send')}${escapeHtml(t('Send selection to Agent'))}</button>
    <button class="icon-btn" data-action="attach-open-file" aria-label="${attr(t('Attach file'))}" title="${attr(t('Attach file'))}">${icon('plus')}</button>`
        : ''
    }
    ${save}
    <button class="icon-btn" data-action="open-external-file" aria-label="${attr(t('Open in system app'))}" title="${attr(t('Open in system app'))}">${icon('handoff')}</button>
    <button class="icon-btn" data-action="close-editor" aria-label="${attr(t('Close the file'))}" title="${attr(t('Close the file'))}">${icon('x')}</button>`;
}

export interface EditorStatusView {
  line: number;
  col: number;
  selected: number;
  /** Undefined: plain text. */
  language?: string;
  eol: Eol;
  bom: boolean;
  readOnly: boolean;
  /** A short note that comes and goes ("Saved", "Updated on disk"). */
  note?: string;
}

export function editorStatusHtml(v: EditorStatusView): string {
  const item = (text: string, cls = '') => `<span class="${cls}">${escapeHtml(text)}</span>`;
  return [
    item(t('Ln {l}, Col {c}', { l: Number(v.line) || 1, c: Number(v.col) || 1 })),
    v.selected ? item(t('{n} selected', { n: Number(v.selected) || 0 })) : '',
    `<span class="spacer"></span>`,
    v.note ? item(v.note, 'editor-note') : '',
    item(v.language ?? t('Plain text')),
    item(v.eol === 'crlf' ? 'CRLF' : v.eol === 'mixed' ? t('Mixed line endings') : 'LF'),
    item(v.bom ? t('UTF-8 with BOM') : 'UTF-8'),
    v.readOnly ? item(t('Read-only'), 'warn') : '',
  ].join('');
}

export type EditorBanner =
  /** The file changed on disk while the buffer has unsaved changes (or a save found it changed). */
  | { kind: 'conflict'; hash: string; text?: string }
  | { kind: 'gone' }
  | { kind: 'notice'; level: 'info' | 'warning'; text: string };

export function editorBannerHtml(banner: EditorBanner | undefined): string {
  if (!banner) return '';
  const button = (action: string, label: string, primary = false) => `<button class="btn small${primary ? ' primary' : ''}" data-action="${action}">${escapeHtml(label)}</button>`;
  switch (banner.kind) {
    case 'conflict':
      return `<div class="banner warn" role="alert">${icon('warn')}<span class="grow"><strong>${escapeHtml(t('Changed on disk'))}</strong> ${escapeHtml(
        t('The file changed on disk after you opened it. Reload it, compare the two, or keep your version.'),
      )}</span>${button('editor-reload', t('Reload'))}${button('editor-compare', t('Compare'))}${button('editor-overwrite', t('Keep mine'), true)}</div>`;
    case 'gone':
      return `<div class="banner warn" role="alert">${icon('warn')}<span class="grow">${escapeHtml(t('The file no longer exists.'))}</span>${button('close-editor', t('Close the file'))}</div>`;
    case 'notice':
      return `<div class="banner ${banner.level === 'warning' ? 'warn' : 'info'}" role="status">${icon(banner.level === 'warning' ? 'warn' : 'info')}<span class="grow">${escapeHtml(banner.text)}</span>
        <button class="icon-btn" data-action="dismiss-editor-banner" aria-label="${attr(t('Close'))}" title="${attr(t('Close'))}">${icon('x')}</button></div>`;
  }
}

/** Why a file did not open. */
export function fileReasonText(reason: FileReason): string {
  switch (reason) {
    case 'outside':
      return t('Outside the folder');
    case 'notFound':
      return t('The file no longer exists.');
    case 'notFile':
      return t('Not a file');
    case 'tooLarge':
      return t('Too large to open (over 2 MB)');
    case 'binary':
      return t('Binary file');
    case 'encoding':
      return t('Not UTF-8');
    case 'unreadable':
      return t('The system did not let Orka read the file. Another program may hold it locked.');
  }
}

/** Why a save was refused (a conflict and a missing file get banners of their own). */
export function saveRefusalText(reason: SaveRefusal | 'running'): string {
  switch (reason) {
    case 'running':
      return t('The Agent is working; save when it stops.');
    case 'conflict':
      return t('Changed on disk');
    case 'gone':
      return t('The file no longer exists.');
    case 'tooLarge':
      return t('Too large to save (over 2 MB).');
    case 'outside':
      return t('Outside the folder');
    case 'readOnly':
      return t('Read-only: mixed line endings');
    case 'invalid':
      return t('The save was not valid and nothing was written.');
    case 'unwritable':
      return t('The system did not let Orka write the file. Another program may hold it locked.');
  }
}

/** Above this many lines in the part that differs, Compare shows it as removed and added instead of matching lines. */
const MAX_DIFF_CELLS = 1_000_000;

/**
 * A unified diff of two texts for Compare: one hunk around the part that differs, with three
 * lines of context.
 */
export function lineDiff(before: string, after: string, labels: { before: string; after: string }): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = [`--- ${labels.before}`, `+++ ${labels.after}`];
  if (start === a.length && start === b.length) return [...head, t('No differences.')].join('\n');
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const body: string[] = [];
  if (midA.length * midB.length <= MAX_DIFF_CELLS) {
    // Longest common subsequence of the lines that differ.
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        body.push(` ${midA[i++]}`);
        j++;
      } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) body.push(`+${midB[j++]}`);
      else body.push(`-${midA[i++]}`);
    }
  } else {
    body.push(...midA.map((line) => `-${line}`), ...midB.map((line) => `+${line}`));
  }
  const before3 = a.slice(Math.max(0, start - 3), start).map((line) => ` ${line}`);
  const after3 = a.slice(a.length - end, Math.min(a.length, a.length - end + 3)).map((line) => ` ${line}`);
  const from = start - before3.length;
  const header = `@@ -${from + 1},${before3.length + midA.length + after3.length} +${from + 1},${before3.length + midB.length + after3.length} @@`;
  return [...head, header, ...before3, ...body, ...after3].join('\n');
}
