import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { t } from '@orka/core/src/i18n';
import type { HunkView } from '../src/protocol';
import { attr, escapeHtml, icon } from '../webview/core/dom';
import { hunksHtml, type Highlighter } from '../webview/features/hunks';

const change = { absPath: 'C:\\work\\src\\a<b>.ts', relPath: 'src\\a<b>.ts' };
const hunks: HunkView[] = [
  {
    header: '@@ -1,3 +1,3 @@',
    lines: [
      { type: ' ', text: 'const a = 1;' },
      { type: '-', text: 'const b = "<old>" & 2;' },
      { type: '+', text: 'const b = "<new>" & 3;' },
      { type: ' ', text: 'export { a, b };' },
    ],
    hidden: 0,
  },
  { header: '@@ -9 +9,2 @@', lines: [{ type: '+', text: 'x();' }], hidden: 4 },
];

/** The Changes panel's hunks as 0.4 built them, before highlighting existed. */
function before(hunks: HunkView[] | undefined): string {
  if (!hunks) return `<div class="hunks"><span class="spinner small"></span></div>`;
  if (!hunks.length) return `<div class="hunks muted small">${escapeHtml(t('No differences.'))}</div>`;
  return `<div class="hunks">${hunks
    .map(
      (h, i) => `<div class="hunk">
      <div class="hunk-head"><span class="mono muted">${escapeHtml(h.header)}</span><span class="spacer"></span>
        <button class="link" data-action="keep-hunk" data-path="${attr(change.absPath)}" data-index="${i}" title="${attr(t('Keep this change'))}">${icon('check')}${escapeHtml(t('Keep'))}</button>
        <button class="link" data-action="revert-hunk" data-path="${attr(change.absPath)}" data-index="${i}" title="${attr(t('Undo only this part of the change'))}">${icon('undo')}${escapeHtml(t('Revert part'))}</button></div>
      <pre class="hunk-body mono">${h.lines.map((l) => `<span class="hl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}">${escapeHtml(l.type)}${escapeHtml(l.text)}</span>`).join('\n')}${
        h.hidden ? `\n<span class="muted">${escapeHtml(t('… {n} more lines', { n: h.hidden }))}</span>` : ''
      }</pre>
    </div>`,
    )
    .join('')}</div>`;
}

/** Tags every line with its side and position, escaping like the editor bundle does. */
function stub(calls: string[][]): Highlighter {
  return (_path, lines) => {
    calls.push(lines);
    return lines.map((line, i) => `<span class="tok-x" data-n="${i}">${escapeHtml(line)}</span>`);
  };
}

const bodies = (html: string) => [...html.matchAll(/<span class="hl ([a-z]*)">([^\n]*?)<\/span>(?=\n|<\/pre>)/g)].map((m) => [m[1], m[2]]);

describe('Changes hunks', () => {
  it('without a highlighter is byte-identical to the plain hunks', () => {
    for (const list of [undefined, [], hunks]) assert.equal(hunksHtml(change, list), before(list));
  });

  it('highlights the old and the new side separately and keeps the line classes and buttons', () => {
    const calls: string[][] = [];
    const html = hunksHtml({ ...change, relPath: 'src/x.ts' }, [hunks[0]!], { highlight: stub(calls), withHeader: true });
    assert.deepEqual(calls, [
      ['const a = 1;', 'const b = "<old>" & 2;', 'export { a, b };'],
      ['const a = 1;', 'const b = "<new>" & 3;', 'export { a, b };'],
    ]);
    assert.deepEqual(bodies(html), [
      ['', ' <span class="tok-x" data-n="0">const a = 1;</span>'],
      ['del', '-<span class="tok-x" data-n="1">const b = &quot;&lt;old&gt;&quot; &amp; 2;</span>'],
      ['add', '+<span class="tok-x" data-n="1">const b = &quot;&lt;new&gt;&quot; &amp; 3;</span>'],
      ['', ' <span class="tok-x" data-n="2">export { a, b };</span>'],
    ]);
    assert.match(html, /data-action="keep-hunk" data-path="[^"]+" data-index="0" data-header="@@ -1,3 \+1,3 @@"/);
    assert.match(html, /data-action="revert-hunk" data-path="[^"]+" data-index="0" data-header="@@ -1,3 \+1,3 @@"/);
    assert.ok(!html.includes('style='));
  });

  it('leaves a side plain when the highlighter declines it or answers with the wrong shape', () => {
    const code = { ...change, relPath: 'src/y.ts' };
    const none = hunksHtml(code, hunks, { highlight: () => undefined });
    assert.equal(none, before(hunks));
    const short = hunksHtml(code, [{ ...hunks[0]!, header: '@@ -2 +2 @@' }], { highlight: (_p, lines) => lines.slice(1) });
    assert.ok(!short.includes('tok-'), 'one string per line, or nothing');
    const throws = hunksHtml(code, [{ ...hunks[0]!, header: '@@ -3 +3 @@' }], {
      highlight: () => {
        throw new Error('parse');
      },
    });
    assert.ok(throws.includes('&quot;&lt;new&gt;&quot;'));
  });

  it('parses a hunk once while its text stays the same', () => {
    const calls: string[][] = [];
    const code = { ...change, relPath: 'src/z.ts' };
    hunksHtml(code, [hunks[1]!], { highlight: stub(calls) });
    hunksHtml(code, [hunks[1]!], { highlight: stub(calls) });
    assert.equal(calls.length, 1, 'only the new side has lines');
    hunksHtml(code, [{ ...hunks[1]!, lines: [{ type: '+', text: 'y();' }] }], { highlight: stub(calls) });
    assert.equal(calls.length, 2, 'the same header with other text is parsed again');
  });

  it('puts no header on the buttons unless asked', () => {
    assert.ok(!hunksHtml(change, hunks, { highlight: stub([]) }).includes('data-header'));
  });
});
