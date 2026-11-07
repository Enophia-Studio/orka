// Review mode of the Changes panel: stepping, Keep and Revert through the app, comments into the message box.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileChange } from '@orka/core';
import type { HunkView } from '../src/protocol';
import {
  addComment,
  counts,
  currentPart,
  decide,
  feedbackText,
  hunksToFetch,
  receiveHunks,
  reviewHtml,
  startReview,
  step,
  syncFiles,
} from '../webview/features/review';

const change = (relPath: string, status: FileChange['status']): FileChange =>
  ({ absPath: `/w/${relPath}`, relPath, status, added: 3, removed: 1 }) as FileChange;
const hunk = (header: string, text = 'x'): HunkView => ({ header, lines: [{ type: '+', text }], hidden: 0 });

describe('review mode', () => {
  it('steps file by file and part by part; Keep and Revert go through the app and count only what it did', () => {
    const state = startReview([change('src/a.ts', 'modified'), change('src/new.ts', 'added'), change('src/c.ts', 'modified')]);
    assert.equal(hunksToFetch(state), '/w/src/a.ts');
    state.hunks.set('/w/src/a.ts', undefined);
    assert.equal(hunksToFetch(state), undefined, 'asked once');
    receiveHunks(state, '/w/src/a.ts', [hunk('@@ -1 +1 @@'), hunk('@@ -9 +9 @@')]);
    assert.equal(currentPart(state)?.hunk?.header, '@@ -1 +1 @@');
    assert.equal(currentPart(state)?.total, 2);

    // k: the first part is kept; nothing else can be decided until the app answers.
    assert.deepEqual(decide(state, 'kept'), { type: 'keepHunk', path: '/w/src/a.ts', index: 0, header: '@@ -1 +1 @@' });
    assert.equal(decide(state, 'reverted'), undefined);
    receiveHunks(state, '/w/src/a.ts', [hunk('@@ -9 +9 @@')]);
    assert.equal(currentPart(state)?.hunk?.header, '@@ -9 +9 @@', 'the same place is now the next part');

    // r: the app leaves the part alone (it touches the user's edits): counted as left, and the review moves on.
    assert.deepEqual(decide(state, 'reverted'), { type: 'revertHunk', path: '/w/src/a.ts', index: 0, header: '@@ -9 +9 @@' });
    receiveHunks(state, '/w/src/a.ts', [hunk('@@ -9 +9 @@')]);
    assert.equal(currentPart(state)?.file.relPath, 'src/new.ts');
    assert.equal(currentPart(state)?.total, 1, 'a new file is one part');

    // A new file is kept as a whole.
    assert.deepEqual(decide(state, 'kept'), { type: 'acceptChange', path: '/w/src/new.ts' });
    assert.equal(hunksToFetch(state), '/w/src/c.ts');
    receiveHunks(state, '/w/src/c.ts', [hunk('@@ -4 +4 @@')]);
    assert.ok(addComment(state, '  Use a constant for the 4 here.  '));
    assert.equal(addComment(state, '   '), false, 'an empty comment is not added');
    step(state, 1);
    assert.equal(state.done, true);
    assert.deepEqual(counts(state), { kept: 2, reverted: 0, left: 1 });

    // p from the summary goes back to the last part.
    step(state, -1);
    assert.equal(currentPart(state)?.hunk?.header, '@@ -4 +4 @@');
  });

  it('a reverted part counts, and stepping back into a file whose parts are not known yet lands on its last part', () => {
    const state = startReview([change('a.ts', 'modified'), change('b.ts', 'modified')]);
    receiveHunks(state, '/w/a.ts', [hunk('@@ a1 @@'), hunk('@@ a2 @@')]);
    step(state, 1);
    step(state, 1);
    assert.equal(currentPart(state)?.file.relPath, 'b.ts');
    receiveHunks(state, '/w/b.ts', [hunk('@@ b1 @@')]);
    decide(state, 'reverted');
    receiveHunks(state, '/w/b.ts', []);
    assert.equal(state.done, true);
    assert.deepEqual(counts(state), { kept: 0, reverted: 1, left: 0 });
    assert.match(feedbackText(state), /I reverted: b\.ts \(@@ b1 @@\)\./);

    const back = startReview([change('a.ts', 'modified'), change('b.ts', 'modified')]);
    receiveHunks(back, '/w/a.ts', [hunk('@@ a1 @@')]);
    step(back, 1);
    receiveHunks(back, '/w/b.ts', [hunk('@@ b1 @@')]);
    back.hunks.delete('/w/a.ts');
    step(back, -1);
    assert.equal(currentPart(back)?.hunk, undefined, 'waiting for the parts');
    receiveHunks(back, '/w/a.ts', [hunk('@@ a1 @@'), hunk('@@ a2 @@'), hunk('@@ a3 @@')]);
    assert.equal(currentPart(back)?.hunk?.header, '@@ a3 @@');
  });

  it('passes over files that left the Changes list', () => {
    const state = startReview([change('a.ts', 'modified'), change('b.ts', 'modified')]);
    syncFiles(state, [change('b.ts', 'modified')]);
    assert.equal(currentPart(state)?.file.relPath, 'b.ts');
    syncFiles(state, []);
    assert.equal(state.done, true);
  });

  it('puts the comments and decisions into a message for the agent', () => {
    const state = startReview([change('src/a.ts', 'modified')]);
    receiveHunks(state, '/w/src/a.ts', [hunk('@@ -1 +1 @@'), hunk('@@ -5 +5 @@')]);
    addComment(state, 'Rename this to readyCount.');
    decide(state, 'kept');
    receiveHunks(state, '/w/src/a.ts', [hunk('@@ -5 +5 @@')]);
    assert.equal(
      feedbackText(state),
      ['Feedback on your changes:', '- src/a.ts (@@ -1 +1 @@): Rename this to readyCount.', 'I kept 1 part.'].join('\n'),
    );
  });

  it('renders escaped, shows where it is, and waits with Revert while the agent works', () => {
    const state = startReview([change('src/<b>x</b>.ts', 'modified')]);
    receiveHunks(state, '/w/src/<b>x</b>.ts', [hunk('@@ -1 +1 @@', '<script>alert(1)</script>'), hunk('@@ -2 +2 @@')]);
    addComment(state, '<img src=x onerror=alert(1)>');
    const html = reviewHtml(state, { running: true });
    assert.ok(!html.includes('<script>') && !html.includes('<b>x</b>') && !html.includes('<img src=x'));
    assert.match(html, /File 1 of 1/);
    assert.match(html, /Part 1 of 2/);
    assert.match(html, /data-action="review-revert" title="Revert waits until the agent stops\." disabled/);
    assert.match(html, /data-action="review-keep"[^>]*>/);
    assert.ok(!/data-action="review-keep"[^>]*disabled/.test(html));
    assert.match(html, /Put feedback in the message box/);
    step(state, 1);
    step(state, 1);
    const summary = reviewHtml(state);
    assert.match(summary, /Review finished/);
    assert.match(summary, /<strong>0<\/strong> kept/);
    assert.match(summary, /<strong>1<\/strong> comment/);
  });
});
