import type { TaskSummary } from '@orka/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LiveSessionView } from '../src/protocol';
import { approvalsBadgeHtml, newSessionMenuHtml, sessionListHtml, sessionMenuHtml, type SidebarView } from '../webview/ide/sidebar';

const task = (id: string, title: string): TaskSummary => ({ id, title, createdAt: '2026-10-30T10:00:00Z', updatedAt: new Date().toISOString(), requests: 1 });

const live = (id: string, folder: string, taskId: string, state: LiveSessionView['state'] = 'idle', title = ''): LiveSessionView => ({
  id,
  folder,
  name: folder.split('/').pop()!,
  taskId,
  title,
  state,
  approvals: state === 'approval' ? 1 : 0,
});

const view = (patch: Partial<SidebarView> = {}): SidebarView => ({
  groups: [
    { folder: 'D:/work/alpha', name: 'alpha', tasks: [task('a1', 'Add a lobby'), task('a2', 'Fix the <img src=x onerror=alert(1)> bug')] },
    { folder: 'D:/work/beta', name: 'beta', tasks: [task('b1', 'Write tests')] },
  ],
  organizer: { groups: [], assigned: {}, hidden: [] },
  collapsed: new Set(),
  showHidden: false,
  live: [live('s-a', 'D:/work/alpha', 'a1')],
  activeId: 's-a',
  draftTitle: '',
  query: '',
  ...patch,
});

/** The row (its whole <div class="side-item…">) whose open button has this task id. */
const rowOf = (html: string, taskId: string) => html.split('<div class="side-item').find((r) => r.includes(`data-id="${taskId}"`)) ?? '';

describe('session list', () => {
  it('marks the open task and escapes what tasks are called', () => {
    const html = sessionListHtml(view());
    assert.match(html, /class="side-item current"[^]*?data-id="a1"/);
    assert.ok(!html.includes('<img'), 'titles are escaped');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.equal((html.match(/data-action="open-session"/g) ?? []).length, 3);
  });

  it('shows the open task as a draft until it is saved, with its run state', () => {
    const html = sessionListHtml(view({ live: [live('s-a', 'D:/work/alpha', 'new-1', 'running')], draftTitle: 'Make the menu calmer' }));
    assert.match(html, /side-item current draft running/);
    assert.ok(html.includes('Make the menu calmer'));
    assert.ok(html.includes('run-dot'));
  });

  it('filters by title, case-insensitively, and says when nothing matches', () => {
    const html = sessionListHtml(view({ query: 'TESTS' }));
    assert.ok(html.includes('Write tests'));
    assert.ok(!html.includes('Add a lobby'));
    assert.ok(!html.includes('>alpha<'), 'a folder without a match is left out');
    assert.match(sessionListHtml(view({ query: 'nothing like this' })), /No session matches\./);
  });

  it("lists the user's groups first, takes their sessions out of the folders, and hides hidden ones", () => {
    const organizer = { groups: [{ id: 'g-1', name: 'Release <work>' }], assigned: { b1: 'g-1' }, hidden: ['a2'] };
    const html = sessionListHtml(view({ organizer }));
    assert.ok(html.indexOf('Release &lt;work&gt;') < html.indexOf('>alpha<'), 'the group comes first, escaped');
    assert.equal((html.match(/data-id="b1"/g) ?? []).length, 2, 'b1 once (its open button and its menu button), under the group');
    assert.ok(html.includes('<span class="side-meta">beta</span>'), 'a grouped session names its folder');
    assert.ok(!html.includes('data-id="a2"'), 'a hidden session is left out');
    assert.match(html, /1 hidden session/);
    assert.ok(sessionListHtml(view({ organizer, showHidden: true })).includes('data-id="a2"'), 'shown on request');
  });

  it('folds a section but shows every match while searching', () => {
    const folded = sessionListHtml(view({ collapsed: new Set(['folder:D:/work/beta']) }));
    assert.ok(!folded.includes('Write tests'));
    assert.match(folded, /side-group folded/);
    assert.ok(sessionListHtml(view({ collapsed: new Set(['folder:D:/work/beta']), query: 'tests' })).includes('Write tests'));
  });

  it('asks for a folder when there is none', () => {
    assert.match(sessionListHtml(view({ groups: [], live: [], activeId: undefined })), /Open a folder to start a session\./);
  });
});

describe('open sessions in the list', () => {
  const two = (betaState: LiveSessionView['state'], alphaState: LiveSessionView['state'] = 'idle') =>
    view({ live: [live('s-a', 'D:/work/alpha', 'a1', alphaState), live('s-b', 'D:/work/beta', 'b1', betaState)] });

  it('marks each open session; only the one shown is current, the others switch to theirs', () => {
    const html = sessionListHtml(two('running', 'running'));
    const alpha = rowOf(html, 'a1');
    const beta = rowOf(html, 'b1');
    assert.match(alpha, /^ current running"/);
    assert.ok(alpha.includes('aria-current="true"') && alpha.includes('data-action="open-session"'));
    assert.match(beta, /^ running"/, 'running in the background, not current');
    assert.ok(beta.includes('run-dot'));
    assert.ok(!beta.includes('aria-current'));
    assert.ok(beta.includes('data-action="switch-session" data-session="s-b"'));
    assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
    assert.ok(!rowOf(html, 'a2').includes('data-session'), 'a task that is not open opens as before');
  });

  it('marks a session that waits for an approval', () => {
    const beta = rowOf(sessionListHtml(two('approval')), 'b1');
    assert.match(beta, /^ needs-approval"/);
    assert.ok(beta.includes('aria-label="Needs approval"'));
    assert.ok(!beta.includes('run-dot'));
    assert.ok(beta.includes('data-session="s-b" data-state="approval"'), 'its … menu knows it runs');
  });

  it('shows an unsaved open session of each folder as a draft at the top', () => {
    const html = sessionListHtml(
      view({
        live: [live('s-a', 'D:/work/alpha', 'new-a', 'running'), live('s-b', 'D:/work/beta', 'new-b', 'approval', 'Port the <b>menu</b>')],
        draftTitle: 'Make the lobby calmer',
      }),
    );
    const drafts = html.split('<div class="side-item').filter((r) => r.includes(' draft'));
    assert.equal(drafts.length, 2);
    assert.match(drafts[0], /^ current draft running"/);
    assert.ok(drafts[0].includes('Make the lobby calmer'), "the shown session's title comes from the page");
    assert.match(drafts[1], /^ draft needs-approval"/);
    assert.ok(drafts[1].includes('data-action="switch-session" data-session="s-b"'));
    assert.ok(drafts[1].includes('Port the &lt;b&gt;menu&lt;/b&gt;') && !html.includes('<b>'), 'titles are escaped');
    assert.ok(drafts[1].includes('data-draft="true"'));
    assert.ok(html.indexOf('Port the') < html.indexOf('Write tests'), 'at the top of its folder');
    // A background draft with no request yet.
    assert.ok(sessionListHtml(view({ live: [live('s-a', 'D:/work/alpha', 'a1'), live('s-b', 'D:/work/beta', 'new-b')] })).includes('>New session<'));
  });

  it('escapes session ids', () => {
    const html = sessionListHtml(view({ live: [live('s-a', 'D:/work/alpha', 'a1'), live('s-"b"><img src=x>', 'D:/work/beta', 'b1')] }));
    assert.ok(html.includes('data-session="s-&quot;b&quot;&gt;&lt;img src=x&gt;"'));
    assert.ok(!html.includes('<img'));
  });

  it('counts the other sessions that wait for an approval, not the one shown', () => {
    const sessions = [live('s-a', 'D:/work/alpha', 'a1', 'approval'), live('s-b', 'D:/work/beta', 'b1', 'approval'), live('s-c', 'D:/work/gamma', 'c1', 'approval')];
    assert.equal(approvalsBadgeHtml('head', sessions.slice(0, 1), 's-a'), '', 'the shown session asks in its own transcript');
    const head = approvalsBadgeHtml('head', sessions, 's-a');
    assert.ok(head.includes('aria-label="2 sessions need approval"'));
    assert.ok(head.includes('data-action="switch-session" data-session="s-b"'), 'a click shows the first');
    assert.ok(head.includes('>2</span>'));
    assert.ok(approvalsBadgeHtml('rail', sessions.slice(0, 2), 's-a').includes('aria-label="1 session needs approval"'));
    assert.equal(approvalsBadgeHtml('head', [live('s-b', 'D:/work/beta', 'b1', 'running')], 's-a'), '');
  });

  it('offers Stop for a running background session and Close for an idle one', () => {
    const organizer = { groups: [], assigned: {}, hidden: [] };
    const running = sessionMenuHtml('b1', 'D:/work/beta', organizer, { id: 's-b', running: true, draft: false });
    assert.ok(running.includes('data-action="stop-session"') && running.includes('data-session="s-b"'));
    assert.ok(!running.includes('close-session'));
    assert.ok(running.includes('data-action="delete-session"'), 'the task keeps its other actions');
    const idle = sessionMenuHtml('b1', 'D:/work/beta', organizer, { id: 's-b', running: false, draft: false });
    assert.ok(idle.includes('data-action="close-session"') && idle.includes('Close (keeps it in the list)'));
    const draft = sessionMenuHtml('new-b', 'D:/work/beta', organizer, { id: 's-b', running: false, draft: true });
    assert.ok(draft.includes('close-session') && !draft.includes('delete-session'), 'an unsaved task offers nothing else');
    const closed = sessionMenuHtml('a2', 'D:/work/alpha', organizer);
    assert.ok(!closed.includes('stop-session') && !closed.includes('close-session'), 'a task that is not open has neither');
  });
});

describe('New session folder choice', () => {
  const recent = [
    { name: 'alpha', path: 'D:/work/alpha' },
    { name: 'beta <b>', path: 'D:/work/beta' },
  ];
  const items = (html: string) => [...html.matchAll(/data-action="(new-session-[a-z]+)"(?: data-folder="([^"]*)")?/g)].map((m) => m[2] ?? m[1]);

  it('lists the recent folders with the current one ticked, then Other folder…', () => {
    const html = newSessionMenuHtml(recent, 'D:/work/beta/', []);
    assert.deepEqual(items(html), ['D:/work/alpha', 'D:/work/beta', 'new-session-other']);
    assert.match(html, /aria-checked="true" data-action="new-session-in" data-folder="D:\/work\/beta"/);
    assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
    assert.ok(html.includes('beta &lt;b&gt;') && !html.includes('<b>'), 'names are escaped');
  });

  it('adds a current folder that is not a recent one, and says which folder runs a session', () => {
    const html = newSessionMenuHtml(recent, 'E:/game', [live('s-a', 'D:/work/alpha', 'a1', 'running')]);
    assert.deepEqual(items(html), ['E:/game', 'D:/work/alpha', 'D:/work/beta', 'new-session-other']);
    assert.match(html, /data-folder="D:\/work\/alpha"[^>]*>.*?<span class="menu-hint">Running<\/span>/);
    assert.equal((html.match(/menu-hint/g) ?? []).length, 1);
  });

  it('offers only Other folder… without any folder', () => {
    assert.deepEqual(items(newSessionMenuHtml([], undefined, [])), ['new-session-other']);
  });
});
