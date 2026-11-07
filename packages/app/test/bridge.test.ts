// The page's side of scoped messages: what it names when it posts, and what it takes from the app.
import { pagePosted, pageStates } from './fakeVsCodeApi';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { flushUiState, forShownSession, post, saveUiState, setSessionId, shownSessionId, UI_STATE_SAVE_MS, uiState } from '../webview/core/bridge';

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

describe("the page's saved state", () => {
  it('saves once for a burst of keys, a moment later, with the newest text', async () => {
    pageStates.length = 0;
    let draft = '';
    for (const key of 'a message typed quickly') {
      draft += key;
      saveUiState({ draft });
    }
    assert.equal(uiState().draft, 'a message typed quickly', 'the page has it at once');
    assert.equal(pageStates.length, 0, 'no save on every key');
    saveUiState({ sidebarClosed: true });
    await new Promise((resolve) => setTimeout(resolve, UI_STATE_SAVE_MS + 50));
    assert.deepEqual(pageStates, [{ draft: 'a message typed quickly', sidebarClosed: true }]);
  });

  it('saves a change still waiting when the page goes away', () => {
    pageStates.length = 0;
    saveUiState({ draft: 'last keys' });
    flushUiState();
    assert.deepEqual(pageStates, [{ draft: 'last keys', sidebarClosed: true }]);
    flushUiState();
    assert.equal(pageStates.length, 1, 'nothing waits: nothing more is saved');
  });
});
