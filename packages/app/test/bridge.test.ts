// The page's side of scoped messages: what it names when it posts, and what it takes from the app.
import { pagePosted } from './fakeVsCodeApi';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { forShownSession, post, setSessionId, shownSessionId } from '../webview/core/bridge';

describe('page and sessions', () => {
  beforeEach(() => {
    pagePosted.length = 0;
    setSessionId(undefined);
  });

  it('names the session shown on its session messages only', () => {
    post({ type: 'revertAll' });
    assert.deepEqual(pagePosted.pop(), { type: 'revertAll' }, 'no session known yet: the app takes the one it shows');
    setSessionId('s-1');
    assert.equal(shownSessionId(), 's-1');
    post({ type: 'revertAll' });
    post({ type: 'saveFile', path: 'a.txt', text: 'x', baseHash: 'h' });
    post({ type: 'approve', id: 'p1', approved: true });
    post({ type: 'setMode', mode: 'ask' });
    post({ type: 'newTask' });
    assert.deepEqual(pagePosted, [
      { type: 'revertAll', sessionId: 's-1' },
      { type: 'saveFile', path: 'a.txt', text: 'x', baseHash: 'h', sessionId: 's-1' },
      { type: 'approve', id: 'p1', approved: true, sessionId: 's-1' },
      { type: 'setMode', mode: 'ask' },
      { type: 'newTask' },
    ]);
  });

  it('keeps the session a message names itself (Stop on another open session)', () => {
    setSessionId('s-1');
    post({ type: 'stop', sessionId: 's-2' });
    post({ type: 'stop' });
    post({ type: 'switchSession', sessionId: 's-2' });
    assert.deepEqual(pagePosted, [
      { type: 'stop', sessionId: 's-2' },
      { type: 'stop', sessionId: 's-1' },
      { type: 'switchSession', sessionId: 's-2' },
    ]);
  });

  it("drops the app's messages for a session it does not show", () => {
    assert.ok(forShownSession({ sessionId: 's-2' }), 'no session known yet (a reload): taken, the next init replaces it all');
    setSessionId('s-1');
    assert.ok(forShownSession({ sessionId: 's-1' }));
    assert.ok(forShownSession({}), 'app-wide messages');
    assert.ok(!forShownSession({ sessionId: 's-2' }));
    assert.ok(!forShownSession({ sessionId: 42 }));
    // A value that is not a string never names a session.
    setSessionId(7 as unknown as string);
    assert.equal(shownSessionId(), undefined);
  });
});
