import { type ApprovalRequest, FileTaskStore } from '@orka/core';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import type { SessionController } from '../src/SessionController';
import { SHELL_CHOICES } from '../src/settings';
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

async function start(kind: 'vscode' | 'desktop', settings: Record<string, unknown> = {}, folders = [folderA, folderB]) {
  const shell = new FakeShell(kind, home, folders, settings);
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

/** The agent's turns for the agent processes started from now on (each process plays the script from its start). */
const script = (...turns: unknown[][]) => (process.env.FAKE_ACP_SCRIPT = JSON.stringify(turns));

/** Messages posted since `from` that name this session. */
const postedFor = (shell: FakeShell, sessionId: string, from = 0) => shell.posted.slice(from).filter((m) => 'sessionId' in m && m.sessionId === sessionId);

const said = (shell: FakeShell, session: SessionController, text: string) =>
  shell.posted.some((m) => m.type === 'event' && m.sessionId === session.id && m.event.type === 'assistant_delta' && m.event.text.includes(text));

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

describe('parallel sessions (desktop IDE layout)', () => {
  it('runs sessions of two folders at once and shows each without stopping the other', async () => {
    const log = path.join(home, 'acp.log');
    process.env.FAKE_ACP_LOG = log;
    const { shell, controller } = await start('desktop', { ...agentSettings, permissionMode: 'ask' });
    const a = controller.activeSession!;
    script([{ chunk: 'Alpha works.' }, { permission: { id: 'p1', title: 'Run a command', kind: 'execute' } }, { chunk: ' Alpha went on.' }, { stop: 'end_turn' }]);
    const sentA = controller.send('Task in alpha');
    await until(() => pendingOf(a).size === 1, "alpha's approval");
    const [approval] = pendingOf(a).keys();

    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    assert.notEqual(b.id, a.id);
    assert.equal(b.root, path.resolve(folderB));
    assert.ok(a.isRunning, 'alpha goes on in the background');
    assert.equal(shell.last('init')?.sessionId, b.id);
    const shownB = shell.posted.length;

    script([{ chunk: 'Beta works.' }, { hang: true }]);
    const sentB = controller.send('Task in beta');
    await until(() => said(shell, b, 'Beta works.'), 'beta to work');
    const live = shell.last('live')!;
    assert.equal(live.activeId, b.id);
    assert.deepEqual(
      live.sessions.map((s) => [s.id, s.state, s.title, s.approvals]),
      [
        [a.id, 'approval', 'Task in alpha', 1],
        [b.id, 'running', 'Task in beta', 0],
      ],
    );

    // Stopping beta leaves alpha waiting.
    await controller.handleMessage({ type: 'stop' });
    await sentB;
    assert.ok(!b.isRunning);
    assert.ok(a.isRunning);
    assert.equal(pendingOf(a).size, 1);

    // Alpha's approval, answered while beta is shown: alpha finishes in the background, silently.
    await controller.handleMessage({ type: 'approve', id: approval, approved: true, sessionId: a.id });
    await sentA;
    assert.deepEqual(postedFor(shell, a.id, shownB), [], 'nothing of alpha reached the page while beta was shown');
    assert.deepEqual(
      shell.last('live')!.sessions.map((s) => [s.id, s.state]),
      [
        [a.id, 'idle'],
        [b.id, 'idle'],
      ],
    );

    // Shown again: alpha's whole transcript, with what it did in the background.
    await controller.handleMessage({ type: 'switchSession', sessionId: a.id });
    assert.equal(controller.activeSession, a);
    assert.equal(shell.currentFolder()?.path, a.root);
    const init = shell.last('init')!;
    assert.equal(init.sessionId, a.id);
    assert.equal(init.taskId, a.taskId);
    assert.match(JSON.stringify(init.session.items), /Alpha works\. Alpha went on\./);
    assert.equal(init.config.folder, a.root);

    const prompts = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === 'prompt');
    assert.equal(new Set(prompts.map((e) => e.pid)).size, 2, 'one agent process per folder');
  });

  it('shows the running session of a folder instead of starting a second one there', async () => {
    script([{ chunk: 'Working.' }, { hang: true }]);
    const { shell, controller } = await start('desktop', agentSettings);
    const a = controller.activeSession!;
    const sent = controller.send('A long request');
    await until(() => said(shell, a, 'Working.'), 'the agent to work');
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    const task = a.taskId;

    await controller.handleMessage({ type: 'newTask', folder: folderA });
    assert.equal(controller.activeSession, a);
    assert.ok(a.isRunning, 'not stopped');
    assert.equal(a.taskId, task, 'the same task');
    assert.ok(shell.asked.some((q) => q.text.startsWith('A session is already running in alpha.')));
    assert.equal(shell.last('init')?.sessionId, a.id);
    assert.ok(b.isEmpty);

    // Its task in the list is shown as it is, not refused.
    const asked = shell.asked.length;
    await controller.handleMessage({ type: 'switchSession', sessionId: b.id });
    await controller.handleMessage({ type: 'openTask', id: task, folder: folderA });
    assert.equal(controller.activeSession, a);
    assert.equal(shell.asked.length, asked);

    controller.stop();
    await sent;
  });

  it('keeps eight sessions open: one more closes the least recently used idle one, its task saved', async () => {
    const folders = Array.from({ length: 9 }, (_, i) => path.join(home, 'work', `f${i}`));
    for (const folder of folders) mkdirSync(folder, { recursive: true });
    script([{ chunk: 'Working.' }, { hang: true }]);
    const { shell, controller } = await start('desktop', agentSettings, folders);
    const running = controller.activeSession!;
    const sent = controller.send('Still running');
    await until(() => said(shell, running, 'Working.'), 'the agent to work');

    script([{ chunk: 'Done.' }, { stop: 'end_turn' }]);
    await controller.handleMessage({ type: 'selectFolder', path: folders[1] });
    const done = controller.activeSession!;
    await controller.send('Finished task');
    for (const folder of folders.slice(2, 8)) await controller.handleMessage({ type: 'selectFolder', path: folder });
    assert.equal(shell.last('live')!.sessions.length, 8);

    await controller.handleMessage({ type: 'selectFolder', path: folders[8] });
    const live = shell.last('live')!;
    assert.equal(live.sessions.length, 8);
    assert.equal(live.activeId, controller.activeSession!.id);
    assert.ok(!live.sessions.some((s) => s.id === done.id), 'the least recently used idle session was closed');
    assert.ok(live.sessions.some((s) => s.id === running.id), 'the running one, though older, stays');
    assert.ok(running.isRunning);
    const store = new FileTaskStore(shell.storage(folders[1]).tasks);
    let tasks = await store.list();
    for (const end = Date.now() + 5000; !tasks.length && Date.now() < end; tasks = await store.list()) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      tasks.map((t) => [t.id, t.title]),
      [[done.taskId, 'Finished task']],
    );

    // Closing: only an idle session that is not shown.
    const idle = live.sessions.find((s) => s.folder === path.resolve(folders[2]))!;
    await controller.handleMessage({ type: 'closeSession', sessionId: running.id });
    await controller.handleMessage({ type: 'closeSession', sessionId: controller.activeSession!.id });
    await controller.handleMessage({ type: 'closeSession', sessionId: idle.id });
    assert.deepEqual(
      shell.last('live')!.sessions.map((s) => s.id),
      live.sessions.filter((s) => s.id !== idle.id).map((s) => s.id),
    );

    await controller.handleMessage({ type: 'stop', sessionId: running.id });
    await sent;
  });

  for (const [kind, settings] of [
    ['vscode', {}],
    ['desktop', { 'desktop.layout': 'classic' }],
  ] as const) {
    it(`keeps one session in ${kind === 'vscode' ? 'VS Code' : 'the classic layout'}: no folder change while it runs`, async () => {
      script([{ chunk: 'Working.' }, { hang: true }]);
      const { shell, controller } = await start(kind, { ...agentSettings, ...settings });
      const session = controller.activeSession!;
      const sent = controller.send('A long request');
      await until(() => said(shell, session, 'Working.'), 'the agent to work');
      await controller.handleMessage({ type: 'selectFolder', path: folderB });
      assert.ok(shell.asked.some((q) => q.text === 'Stop the agent before switching folders.'));
      assert.equal(controller.activeSession, session);
      assert.equal(shell.currentFolder()?.path, folderA);
      assert.equal(shell.last('live'), undefined, 'no session list');
      controller.stop();
      await sent;
      // Once it is idle, a folder change ends it.
      await controller.handleMessage({ type: 'selectFolder', path: folderB });
      assert.notEqual(controller.activeSession, session);
      await controller.handleMessage({ type: 'switchSession', sessionId: session.id });
      assert.equal(controller.activeSession!.root, path.resolve(folderB));
    });
  }

  it('gives idle sessions a new host when the shell setting changes; a running one goes on', async () => {
    const { shell, controller } = await start('desktop', { ...agentSettings, permissionMode: 'ask' });
    const a = controller.activeSession!;
    script([{ permission: { id: 'p1', title: 'Run a command', kind: 'execute' } }, { chunk: 'Alpha is done.' }, { stop: 'end_turn' }]);
    const sent = controller.send('Task in alpha');
    await until(() => pendingOf(a).size === 1, "alpha's approval");
    const [approval] = pendingOf(a).keys();
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;

    await shell.settings.update('shell', SHELL_CHOICES[1]);
    await until(() => controller.activeSession !== b, 'a new session in beta');
    assert.equal(controller.activeSession!.root, b.root);
    assert.equal(shell.last('init')?.sessionId, controller.activeSession!.id);
    assert.ok(a.isRunning);
    assert.deepEqual(
      shell.last('live')!.sessions.map((s) => s.id),
      [a.id, controller.activeSession!.id],
    );

    await controller.handleMessage({ type: 'approve', id: approval, approved: true, sessionId: a.id });
    await sent;
    await controller.handleMessage({ type: 'switchSession', sessionId: a.id });
    assert.match(JSON.stringify(shell.last('init')!.session.items), /Alpha is done\./);
  });

  it('rebuilds providers only once no session runs', async () => {
    script([{ chunk: 'Working.' }, { hang: true }]);
    const { shell, controller } = await start('desktop', agentSettings);
    const a = controller.activeSession!;
    const stale = () => (controller as unknown as { providersStale: boolean }).providersStale;
    const sentA = controller.send('A long request');
    await until(() => said(shell, a, 'Working.'), 'the agent to work');
    // Provider settings change while alpha runs: its providers stay until it ends.
    await shell.settings.update('claude.effort', 'low');
    await until(stale, 'the providers to wait');
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    script([{ chunk: 'Done.' }, { stop: 'end_turn' }]);
    await controller.send('A short request');
    assert.ok(stale(), 'beta ended, but alpha still runs');
    await controller.handleMessage({ type: 'stop', sessionId: a.id });
    await sentA;
    assert.ok(!stale());
  });

  it("keeps a folder's MCP trust with that folder", async () => {
    writeFileSync(path.join(folderA, '.mcp.json'), JSON.stringify({ mcpServers: { wa: { command: 'wa-server' } } }));
    const { shell, controller } = await start('desktop');
    const alpha = controller.activeSession!;
    await controller.handleMessage({ type: 'toggleMcpServer', name: 'wa', enabled: true });
    assert.equal(shell.stateFor!(folderA).get<{ allowed: boolean }>('orka.mcpTrust')?.allowed, true);
    assert.equal(shell.stateFor!(folderB).get('orka.mcpTrust'), undefined);
    assert.equal(shell.workspaceState.get('orka.mcpTrust'), undefined);
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    await until(() => shell.last('config')?.config.folder === path.resolve(folderB), "beta's settings view");
    assert.deepEqual(shell.last('config')!.config.mcp.servers, []);
    await controller.handleMessage({ type: 'switchSession', sessionId: alpha.id });
    await until(() => shell.last('config')?.config.mcp.servers.length === 1, "alpha's settings view");
    assert.equal(shell.last('config')!.config.mcp.servers[0].enabled, true);
  });
});

describe('approvals and permissions per session', () => {
  /** A request as an agent's tool call makes it (the host asks the session). */
  const request = (id: string, title: string, preview?: ApprovalRequest['preview']): ApprovalRequest => ({
    id,
    toolName: 'write_file',
    category: 'edit',
    risk: 'normal',
    title,
    preview,
  });
  const askingTurn = (text: string) => [{ permission: { id: 'p1', title: 'Run a command', kind: 'execute' } }, { chunk: text }, { stop: 'end_turn' }];

  it('keeps approvals and their previews apart when two sessions wait on the same call id', async () => {
    const { shell, controller } = await start('desktop');
    const a = controller.activeSession!;
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    const answerA = a.host.requestApproval(request('call_1', 'Edit a.txt', { path: path.join(folderA, 'a.txt'), before: 'a\n', after: 'A\n' }));
    const answerB = b.host.requestApproval(request('call_1', 'Edit a.txt', { path: path.join(folderB, 'a.txt'), before: 'b\n', after: 'B\n' }));
    assert.deepEqual([...shell.previews.keys()], [`${a.id}:call_1`, `${b.id}:call_1`]);

    // The diff of the approval shown, or of the session the page names.
    await controller.handleMessage({ type: 'previewApproval', id: 'call_1' });
    await controller.handleMessage({ type: 'previewApproval', id: 'call_1', sessionId: a.id });
    assert.deepEqual(shell.previewsOpened, [`${b.id}:call_1`, `${a.id}:call_1`]);

    await controller.handleMessage({ type: 'approve', id: 'call_1', approved: true });
    assert.equal((await answerB).approved, true);
    assert.equal(pendingOf(a).size, 1, "alpha's approval still waits");
    assert.deepEqual([...shell.previews.keys()], [`${a.id}:call_1`]);
    await controller.handleMessage({ type: 'approve', id: 'call_1', approved: false, sessionId: a.id });
    assert.equal((await answerA).approved, false);
    assert.equal(shell.previews.size, 0);
  });

  it('keeps "always allow" to the session that gave it', async () => {
    const { shell, controller } = await start('desktop', { ...agentSettings, permissionMode: 'ask' });
    const a = controller.activeSession!;
    script(askingTurn('First.'), askingTurn('Second.'));
    const first = controller.send('First request');
    await until(() => pendingOf(a).size === 1, 'the approval');
    await controller.handleMessage({ type: 'approve', id: [...pendingOf(a).keys()][0], approved: true, always: true });
    await first;
    const second = controller.send('Second request');
    await until(() => said(shell, a, 'Second.') || pendingOf(a).size > 0, 'the second turn');
    assert.equal(pendingOf(a).size, 0, 'alpha asks no more');
    await second;

    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    const sentB = controller.send('First request in beta');
    await until(() => pendingOf(b).size === 1, 'beta to ask');
    await controller.handleMessage({ type: 'approve', id: [...pendingOf(b).keys()][0], approved: false });
    await sentB;
  });

  it('passes the permission mode and rules to every session', async () => {
    const folderC = path.join(home, 'work', 'gamma');
    mkdirSync(folderC);
    const { shell, controller } = await start('desktop', {}, [folderA, folderB, folderC]);
    const a = controller.activeSession!;
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    await controller.handleMessage({ type: 'setMode', mode: 'autonomous' });
    await shell.settings.update('permissions.terminal', 'ask');
    const command = { category: 'command' as const, risk: 'normal' as const };
    const follows = (s: SessionController) => s.permissions.getMode() === 'autonomous' && s.permissions.decide(command) === 'ask';
    await until(() => follows(a) && follows(b), 'both sessions to follow');
    assert.equal(a.permissions.decide({ category: 'edit', risk: 'normal' }), 'allow');
    // A session opened later starts with them.
    await controller.handleMessage({ type: 'selectFolder', path: folderC });
    assert.ok(follows(controller.activeSession!));
  });

  it('tells about a background session that waits for approval once per burst, and shows it on request', async () => {
    const { shell, controller } = await start('desktop');
    const a = controller.activeSession!;
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    const notices = () => shell.asked.filter((q) => q.text.startsWith('A session in alpha needs your approval'));

    const first = a.host.requestApproval(request('c1', 'Edit one.txt'));
    const second = a.host.requestApproval(request('c2', 'Edit two.txt'));
    assert.deepEqual(
      notices().map((q) => [q.level, q.text, q.actions]),
      [['info', 'A session in alpha needs your approval: Edit one.txt', ['Show']]],
      'one notice for the burst',
    );
    const live = shell.last('live')!;
    assert.equal(live.activeId, b.id);
    assert.deepEqual(
      live.sessions.map((s) => [s.id, s.state, s.approvals]),
      [
        [a.id, 'approval', 2],
        [b.id, 'idle', 0],
      ],
    );

    // Both answered: the burst is over, and the next approval is told again. "Show" shows alpha.
    await controller.handleMessage({ type: 'approve', id: 'c1', approved: true, sessionId: a.id });
    await controller.handleMessage({ type: 'approve', id: 'c2', approved: true, sessionId: a.id });
    await Promise.all([first, second]);
    assert.deepEqual(
      shell.last('live')!.sessions.map((s) => s.state),
      ['idle', 'idle'],
    );
    shell.answer = 'Show';
    const third = a.host.requestApproval(request('c3', 'Edit three.txt'));
    await until(() => controller.activeSession === a, 'alpha to be shown');
    assert.equal(notices().length, 2);
    const init = shell.last('init')!;
    assert.equal(init.sessionId, a.id);
    assert.deepEqual(init.session.items, [], 'nothing was written into its transcript');
    await controller.handleMessage({ type: 'approve', id: 'c3', approved: true });
    assert.equal((await third).approved, true);
  });

  it("answers only the stopped session's approvals", async () => {
    const { shell, controller } = await start('desktop', { ...agentSettings, permissionMode: 'ask' });
    const a = controller.activeSession!;
    script(askingTurn('Alpha went on.'));
    const sentA = controller.send('Task in alpha');
    await until(() => pendingOf(a).size === 1, "alpha's approval");
    await controller.handleMessage({ type: 'selectFolder', path: folderB });
    const b = controller.activeSession!;
    script(askingTurn('Beta went on.'));
    const sentB = controller.send('Task in beta');
    await until(() => pendingOf(b).size === 1, "beta's approval");

    await controller.handleMessage({ type: 'stop', sessionId: a.id });
    await sentA;
    assert.equal(pendingOf(a).size, 0);
    assert.equal(pendingOf(b).size, 1, "beta's approval still waits");
    assert.ok(b.isRunning);
    assert.deepEqual(
      shell.last('live')!.sessions.map((s) => [s.id, s.state]),
      [
        [a.id, 'idle'],
        [b.id, 'approval'],
      ],
    );
    await controller.handleMessage({ type: 'approve', id: [...pendingOf(b).keys()][0], approved: true });
    await sentB;
    assert.ok(said(shell, b, 'Beta went on.'));
  });
});
