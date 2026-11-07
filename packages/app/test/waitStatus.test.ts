import type { TaskSummary, ToolCallView, WaitStatus } from '@orka/core';
import { setLocale } from '@orka/core/src/i18n';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { LiveSessionView } from '../src/protocol';
import { sessionListHtml, type SidebarView } from '../webview/ide/sidebar';
import { cancelToolButton, errorSummary } from '../webview/features/toolCard';
import { tickWaits, waitHtml } from '../webview/features/wait';

const task = (id: string, title: string): TaskSummary => ({ id, title, createdAt: '2026-11-07T10:00:00Z', updatedAt: new Date().toISOString(), requests: 1 });

const live = (id: string, taskId: string, state: LiveSessionView['state'], wait?: WaitStatus): LiveSessionView => ({
  id,
  folder: 'D:/work/alpha',
  name: 'alpha',
  taskId,
  title: '',
  state,
  approvals: state === 'approval' ? 1 : 0,
  ...(wait ? { wait } : {}),
});

const view = (sessions: LiveSessionView[], activeId?: string): SidebarView => ({
  groups: [{ folder: 'D:/work/alpha', name: 'alpha', tasks: [task('a1', 'Add a lobby'), task('a2', 'Write tests')] }],
  organizer: { groups: [], assigned: {}, hidden: [] },
  collapsed: new Set(),
  showHidden: false,
  live: sessions,
  activeId,
  draftTitle: '',
  query: '',
});

const call = (patch: Partial<ToolCallView>): ToolCallView => ({ id: 'c1', name: 'run_command', title: 'Run: npm test', category: 'command', risk: 'normal', status: 'running', ...patch });

afterEach(() => setLocale('en'));

describe('wait reasons in the session list', () => {
  it('says why a running session waits, escaped, and nothing for an idle one', () => {
    setLocale('en');
    const html = sessionListHtml(
      view([live('s-1', 'a1', 'running', { reason: 'tool', tool: 'mcp__<b>x</b>__run' }), live('s-2', 'a2', 'idle', { reason: 'thinking' })]),
    );
    const row = html.split('<div class="side-item').find((r) => r.includes('data-id="a1"')) ?? '';
    assert.match(row, /class="side-meta side-wait"/);
    assert.ok(row.includes('Running &lt;b&gt;x&lt;/b&gt; · run'), row);
    assert.ok(!html.includes('<b>'), 'tool names are escaped, also inside data-wait');
    const idle = html.split('<div class="side-item').find((r) => r.includes('data-id="a2"')) ?? '';
    assert.ok(!idle.includes('side-wait'));
  });

  it('marks an approval, also on a new session\'s draft row, in Turkish', () => {
    setLocale('tr');
    const html = sessionListHtml(view([live('s-1', 'new-1', 'approval', { reason: 'approval' })]));
    assert.ok(html.includes('Onayın bekleniyor'), html);
  });
});

describe('retry countdown', () => {
  it('ticks in place and stops once the wait is over', () => {
    setLocale('en');
    const now = Date.now();
    const wait: WaitStatus = { reason: 'retrying', until: now + 3_000, attempt: 1, max: 3 };
    const html = waitHtml(wait, 'phase-label');
    const encoded = /data-wait="([^"]*)"/.exec(html)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const node = { dataset: { wait: encoded }, textContent: '' };
    const root = { querySelectorAll: () => [node] } as unknown as ParentNode;
    assert.equal(tickWaits(root, now), true);
    assert.equal(node.textContent, 'Retrying in 3s (attempt 1/3)');
    assert.equal(tickWaits(root, now + 1_200), true);
    assert.equal(node.textContent, 'Retrying in 2s (attempt 1/3)');
    assert.equal(tickWaits(root, now + 3_000), false, 'no more ticks');
    assert.equal(node.textContent, 'Retrying in 0s (attempt 1/3)');
    // A broken attribute is skipped.
    const broken = { dataset: { wait: '{' }, textContent: 'x' };
    assert.equal(tickWaits({ querySelectorAll: () => [broken] } as unknown as ParentNode, now), false);
    assert.equal(broken.textContent, 'x');
  });
});

describe('tool cards', () => {
  it('show a failed call\'s reason in one short line', () => {
    setLocale('en');
    assert.equal(errorSummary(call({ status: 'done', output: 'ok' })), '');
    assert.equal(errorSummary(call({ status: 'error', output: '\nExit code: 1\nlong log' })), 'Exit code: 1');
    const long = errorSummary(call({ status: 'error', output: 'x'.repeat(500) }));
    assert.equal(long.length, 140);
    assert.ok(long.endsWith('…'));
    assert.equal(errorSummary(call({ status: 'cancelled', output: 'Cancelled by the user: …' })), 'Cancelled');
    assert.equal(errorSummary(call({ status: 'denied', output: 'Declined: not now' })), 'Declined: not now');
  });

  it('offer Stop only on a running call that can be stopped alone', () => {
    setLocale('en');
    assert.equal(cancelToolButton(call({ cancellable: undefined })), '');
    assert.equal(cancelToolButton(call({ status: 'done', cancellable: true })), '');
    const button = cancelToolButton(call({ id: 'c"1', cancellable: true }));
    assert.match(button, /data-action="cancel-tool"/);
    assert.ok(button.includes('data-id="c&quot;1"'), 'the id is escaped');
    assert.ok(button.includes('aria-label="Stop this tool"'));
  });
});
