import { FileTaskStore } from '@orka/core';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import type { SessionController } from '../src/SessionController';
import { FakeShell } from './fakeShell';

let home: string;
let folderA: string;
let folderB: string;
let controllers: AppController[] = [];

// The core's fake ACP agent, run with this Node as a custom agent.
const fakeAgent = path.resolve(__dirname, '..', '..', '..', 'core', 'test', 'fixtures', 'fake-acp.mjs');
const agentSettings = {
  provider: 'agent:custom:fake',
  'agentClis.enabled': ['custom:fake'],
  'agentClis.custom': [{ name: 'Fake', command: process.execPath, args: [fakeAgent] }],
  'supervisor.enabled': false,
};

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-session-test-'));
  folderA = path.join(home, 'work', 'alpha');
  folderB = path.join(home, 'work', 'beta');
  for (const dir of [folderA, folderB, path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  delete process.env.FAKE_ACP_SCRIPT;
  delete process.env.FAKE_ACP_LOG;
  rmSync(home, { recursive: true, force: true });
});

async function start(kind: 'vscode' | 'desktop', settings: Record<string, unknown> = {}) {
  const shell = new FakeShell(kind, home, [folderA, folderB], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pendingOf = (session: SessionController) => (session as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals;

describe('sessions', () => {
  it('ends the session when VS Code changes the folder: task saved, approval answered, a new empty task', async () => {
    const log = path.join(home, 'acp.log');
    process.env.FAKE_ACP_LOG = log;
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([
      [{ chunk: 'Editing.' }, { permission: { id: 'p1', title: 'Edit a.txt', kind: 'edit', locations: [{ path: path.join(folderA, 'a.txt') }] } }, { stop: 'end_turn' }],
    ]);
    const { shell, controller } = await start('vscode', { ...agentSettings, permissionMode: 'ask' });
    const first = controller.activeSession!;
    const firstTask = first.taskId;
    const sent = controller.send('Edit a.txt please');
    await until(() => pendingOf(first).size === 1, 'the approval');

    // VS Code reports the change itself (a workspace folder removed or switched).
    await shell.selectFolder(folderB);
    const second = controller.activeSession!;
    assert.notEqual(second.id, first.id);
    assert.equal(second.root, path.resolve(folderB));
    assert.ok(second.isEmpty);
    assert.notEqual(second.taskId, firstTask);
    const init = shell.last('init')!;
    assert.deepEqual([init.taskId, init.session.items], [second.taskId, []]);
    assert.equal(init.config.folder, path.resolve(folderB));

    assert.equal(pendingOf(first).size, 0, 'the open approval was answered');
    await sent;
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('"permission_answer"'), 'the agent to get its answer');
    // The old session saves its task as it goes, without holding up the new one.
    const store = new FileTaskStore(shell.storage(folderA).tasks);
    let tasks = await store.list();
    for (const end = Date.now() + 5000; !tasks.length && Date.now() < end; tasks = await store.list()) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      tasks.map((t) => [t.id, t.title]),
      [[firstTask, 'Edit a.txt please']],
      'the task of the old folder was saved',
    );
  });

  for (const kind of ['vscode', 'desktop'] as const) {
    it(`names its session on everything it posts, and takes messages for it (${kind})`, async () => {
      process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Done.' }, { directWrite: { path: 'b.txt', content: 'agent\n' } }, { stop: 'end_turn' }]]);
      writeFileSync(path.join(folderA, 'b.txt'), 'before\n');
      const { shell, controller } = await start(kind, agentSettings);
      const session = controller.activeSession!;
      const init = shell.last('init')!;
      assert.equal(init.sessionId, session.id);
      // With the page's sessionId, and without one (the session shown).
      await controller.handleMessage({ type: 'send', text: 'Change b.txt', sessionId: session.id });
      await until(() => shell.posted.some((m) => m.type === 'event' && m.event.type === 'changes' && m.event.changes.length > 0), 'the change');
      await controller.handleMessage({ type: 'getHunks', path: path.join(folderA, 'b.txt') });
      const events = shell.posted.filter((m) => m.type === 'event');
      assert.ok(events.some((m) => m.type === 'event' && m.event.type === 'assistant_end'));
      assert.deepEqual([...new Set(events.map((m) => m.type === 'event' && m.sessionId))], [session.id], 'every event names the session');
      assert.equal(shell.last('hunks')?.sessionId, session.id);
      assert.equal(shell.last('hunks')?.hunks.length, 1);
    });
  }

  it('does nothing with a message for a session that is gone', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ permission: { id: 'p1', title: 'Run a command', kind: 'execute' } }, { stop: 'end_turn' }]]);
    writeFileSync(path.join(folderA, 'mine.txt'), 'mine\n');
    const { shell, controller } = await start('desktop', { ...agentSettings, permissionMode: 'ask' });
    const session = controller.activeSession!;
    // A change of the agent's that Revert All would undo.
    writeFileSync(path.join(folderA, 'a.txt'), 'agent\n');
    session.orchestrator.changes.recordOriginal(path.join(folderA, 'a.txt'), 'before\n');
    const sent = controller.send('Run something');
    await until(() => pendingOf(session).size === 1, 'the approval');
    const [approval] = pendingOf(session).keys();
    const asked = shell.asked.length;
    const posted = shell.posted.length;
    shell.answer = 'Revert All';
    for (const sessionId of ['s-gone', 42 as unknown as string]) {
      await controller.handleMessage({ type: 'approve', id: approval, approved: true, sessionId });
      await controller.handleMessage({ type: 'saveFile', path: 'mine.txt', text: 'changed\n', baseHash: 'x', sessionId });
      await controller.handleMessage({ type: 'revertAll', sessionId });
      await controller.handleMessage({ type: 'stop', sessionId });
    }
    assert.equal(pendingOf(session).size, 1, 'the approval still waits');
    assert.ok(session.isRunning);
    assert.equal(shell.asked.length, asked, 'nothing was asked');
    assert.ok(!shell.posted.slice(posted).some((m) => m.type === 'fileSaved' || m.type === 'saveRefused'), 'nothing was answered');
    assert.equal(readFileSync(path.join(folderA, 'mine.txt'), 'utf8'), 'mine\n');
    assert.equal(readFileSync(path.join(folderA, 'a.txt'), 'utf8'), 'agent\n');
    // The session shown takes it with its own id.
    await controller.handleMessage({ type: 'approve', id: approval, approved: false, sessionId: session.id });
    await sent;
    assert.equal(pendingOf(session).size, 0);
  });

  it('saves the open task when the app closes', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Working.' }, { hang: true }]]);
    const { shell, controller } = await start('desktop', agentSettings);
    const session = controller.activeSession!;
    const sent = controller.send('A long request');
    await until(() => shell.posted.some((m) => m.type === 'event' && m.event.type === 'assistant_delta'), 'the agent to work');
    controllers = controllers.filter((c) => c !== controller);
    await controller.dispose();
    await sent;
    const tasks = await new FileTaskStore(shell.storage(folderA).tasks).list();
    assert.deepEqual(
      tasks.map((t) => [t.id, t.title]),
      [[session.taskId, 'A long request']],
    );
  });
});
