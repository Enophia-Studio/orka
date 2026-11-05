import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DirEntry } from '../src/protocol';
import { editorBannerHtml, editorHeadHtml, editorStatusHtml, fileTreeHtml, lineDiff, viewSwitchHtml, type DirState, type TreeView } from '../webview/ide/files';

const dir = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, kind: 'dir', ...extra });
const file = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, kind: 'file', ...extra });

const view = (patch: Partial<TreeView> = {}): TreeView => ({
  dirs: new Map<string, DirState>([
    ['', { entries: [dir('src'), dir('node_modules', { ignored: true }), dir('shared', { link: true }), file('README.md'), file('a"<b>.txt')] }],
    ['src', { entries: [file('hello.ts'), file('new.ts')] }],
  ]),
  expanded: new Set(['src']),
  changes: new Map(),
  dirty: false,
  ...patch,
});

const rows = (html: string) => html.match(/<div class="tree-row[^>]*>/g) ?? [];

describe('Files tree', () => {
  it('lists folders and files as tree items with their level, path and state', () => {
    const html = fileTreeHtml(view());
    assert.deepEqual(
      rows(html).map((row) => /data-path="([^"]*)"/.exec(row)?.[1]),
      ['src', 'src/hello.ts', 'src/new.ts', 'node_modules', 'shared', 'README.md', 'a&quot;&lt;b&gt;.txt'],
    );
    assert.match(html, /role="treeitem" aria-level="1" aria-expanded="true" data-level="1" data-action="toggle-dir" data-path="src"/);
    assert.match(html, /role="treeitem" aria-level="2" aria-selected="false" data-level="2" data-action="open-file-node" data-path="src\/hello.ts"/);
    assert.match(html, /aria-expanded="false"[^>]*data-path="node_modules"/);
    assert.match(html, /class="tree-row dir ignored"/);
    assert.match(html, /data-path="shared"[^]*?class="tree-link"/, 'a link inside the folder is marked');
  });

  it('escapes names and paths', () => {
    const html = fileTreeHtml(view());
    assert.ok(!html.includes('a"<b>'), 'never raw');
    assert.ok(html.includes('<span class="tree-name">a&quot;&lt;b&gt;.txt</span>'));
  });

  it('gives Tab one row: the remembered one, else the first', () => {
    const tabbable = (html: string) => rows(html).filter((r) => r.includes('tabindex="0"')).map((r) => /data-path="([^"]*)"/.exec(r)?.[1]);
    assert.deepEqual(tabbable(fileTreeHtml(view({ focus: 'src/new.ts' }))), ['src/new.ts']);
    assert.deepEqual(tabbable(fileTreeHtml(view({ focus: 'gone.ts' }))), ['src']);
  });

  it("marks the open file, unsaved changes, the agent's changes and the user's edits", () => {
    const html = fileTreeHtml(
      view({
        open: 'src/hello.ts',
        dirty: true,
        changes: new Map([
          ['src/hello.ts', { status: 'modified' as const, userEdited: true as const }],
          ['src/new.ts', { status: 'added' as const }],
        ]),
      }),
    );
    const hello = html.split('<div class="tree-row').find((row) => row.includes('data-path="src/hello.ts"'))!;
    assert.match(hello, /^ file current" role="treeitem" aria-level="2" aria-selected="true"/);
    assert.match(hello, /dirty-dot/);
    assert.match(hello, /title="Edited by you"/);
    assert.match(hello, /<span class="badge modified"[^>]*>M<\/span>/);
    assert.match(html, /<span class="badge added"[^>]*>A<\/span>/);
  });

  it('shows folders being listed, gone, and cut short', () => {
    const loading = fileTreeHtml(view({ dirs: new Map([['', 'loading']]) }));
    assert.match(loading, /spinner/);
    const gone = fileTreeHtml(view({ dirs: new Map<string, DirState>([['', { entries: [dir('src')] }], ['src', { error: 'notFound' }]]) }));
    assert.match(gone, /tree-note muted" data-level="2">Not found</);
    const cut = fileTreeHtml(view({ dirs: new Map<string, DirState>([['', { entries: [file('a'), file('b')], truncated: true }]]) }));
    assert.match(cut, /Only the first 2 entries are shown\./);
  });
});

describe('editor pane', () => {
  const head = { path: 'src/<x>/hello.ts', loaded: true, dirty: true, readOnly: false, running: false, saving: false };

  it('offers Save only for unsaved changes, and says why not', () => {
    const save = (patch: Partial<typeof head>) => /<button class="btn small primary" data-action="save-file"([^>]*)>/.exec(editorHeadHtml({ ...head, ...patch }))?.[1] ?? '';
    assert.doesNotMatch(save({}), /disabled/);
    assert.match(save({ dirty: false }), /disabled title="No unsaved changes"/);
    assert.match(save({ running: true }), /disabled title="The Agent is working; save when it stops\."/);
    assert.match(save({ readOnly: true }), /disabled title="Read-only: mixed line endings"/);
    assert.doesNotMatch(editorHeadHtml({ ...head, loaded: false }), /save-file/, 'nothing to save before the file is in');
    assert.ok(editorHeadHtml(head).includes('src/&lt;x&gt;/'), 'the path is escaped');
    assert.match(editorHeadHtml(head), /data-action="close-editor"/);
  });

  it('shows the cursor, the language, the line endings and the encoding', () => {
    const status = editorStatusHtml({ line: 12, col: 4, selected: 30, language: 'C#', eol: 'crlf', bom: true, readOnly: false });
    for (const part of ['Ln 12, Col 4', '30 selected', 'C#', 'CRLF', 'UTF-8 with BOM']) assert.ok(status.includes(part), part);
    const plain = editorStatusHtml({ line: 1, col: 1, selected: 0, eol: 'mixed', bom: false, readOnly: true });
    for (const part of ['Plain text', 'Mixed line endings', 'UTF-8', 'Read-only']) assert.ok(plain.includes(part), part);
  });

  it('offers Reload, Compare and Keep mine when the file changed on disk', () => {
    const banner = editorBannerHtml({ kind: 'conflict', hash: 'a'.repeat(64) });
    for (const action of ['editor-reload', 'editor-compare', 'editor-overwrite']) assert.ok(banner.includes(`data-action="${action}"`), action);
    assert.match(editorBannerHtml({ kind: 'gone' }), /The file no longer exists\./);
    assert.ok(editorBannerHtml({ kind: 'notice', level: 'warning', text: '<b>' }).includes('&lt;b&gt;'));
    assert.equal(editorBannerHtml(undefined), '');
  });

  it("switches between the conversation and the open file in the title bar", () => {
    const html = viewSwitchHtml({ editorShown: true, path: 'src/hello.ts', dirty: true });
    assert.match(html, /data-action="show-chat" aria-pressed="false"/);
    assert.match(html, /data-action="show-editor" aria-pressed="true" title="src\/hello.ts"/);
    assert.match(html, /dirty-dot/);
  });

  it('compares the file on disk with the buffer, line by line', () => {
    const diff = lineDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nE\nf\nnew\ng\nh', { before: 'disk', after: 'editor' }).split('\n');
    assert.deepEqual(diff, ['--- disk', '+++ editor', '@@ -2,7 +2,8 @@', ' b', ' c', ' d', '+E', '-e', ' f', '+new', ' g', ' h']);
    assert.match(lineDiff('same', 'same', { before: 'disk', after: 'editor' }), /No differences\./);
  });
});
