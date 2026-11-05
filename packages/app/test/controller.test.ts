import { applyEvent, customAgentEntry, emptySession, FileTaskStore, hunkHeader, type Orchestrator, programPath, VERSION } from '@orka/core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import { FakeShell } from './fakeShell';

let home: string;
let folderA: string;
let folderB: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-app-test-'));
  folderA = path.join(home, 'work', 'alpha');
  folderB = path.join(home, 'work', 'beta');
  for (const dir of [folderA, folderB, path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

async function start(kind: 'vscode' | 'desktop', settings: Record<string, unknown> = {}) {
  const shell = new FakeShell(kind, home, [folderA, folderB], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

/** A saved task in a folder's history, as the app writes it. */
async function saveTask(shell: FakeShell, folder: string, id: string, title: string) {
  const view = emptySession();
  applyEvent(view, { type: 'user_message', id: 'u1', text: title });
  const now = new Date().toISOString();
  await new FileTaskStore(shell.storage(folder).tasks).save({
    version: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `<context>\n</context>\n${title}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ],
    subagentProfiles: [],
    usageByAgent: [],
    view,
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('desktop session list', () => {
  it('lists the tasks of every recent folder, with the task open now', async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    await controller.handleMessage({ type: 'listSessions' });
    const sessions = shell.last('sessions');
    assert.ok(sessions, 'sessions were posted');
    assert.deepEqual(
      sessions.groups.map((g) => [g.name, g.tasks.map((t) => t.id)]),
      [
        ['alpha', []],
        ['beta', ['task-b1']],
      ],
    );
    assert.equal(sessions.taskId, shell.last('init')?.taskId, 'the open (unsaved) task is named');
  });

  it('is not sent to VS Code or to the classic desktop layout', async () => {
    for (const [kind, settings] of [['vscode', {}], ['desktop', { 'desktop.layout': 'classic' }]] as const) {
      const { shell, controller } = await start(kind, settings);
      await controller.handleMessage({ type: 'listSessions' });
      assert.equal(shell.last('sessions'), undefined, kind);
    }
  });

  it('opens a task of another recent folder by switching to that folder first', async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    await controller.handleMessage({ type: 'openTask', id: 'task-b1', folder: folderB });
    assert.equal(shell.currentFolder()?.path, folderB);
    const init = shell.last('init');
    assert.equal(init?.taskId, 'task-b1');
    assert.equal(init?.config.folder, path.resolve(folderB));
    assert.equal(init?.session.items[0]?.kind, 'user');
  });

  it('never switches to a folder that is not a recent one', async () => {
    const { shell, controller } = await start('desktop');
    // Only a task opened or started shows: config updates from the start may still arrive.
    const shown = () => shell.posted.filter((m) => m.type === 'init' || m.type === 'sessions').length;
    const before = shown();
    await controller.handleMessage({ type: 'openTask', id: 'task-x', folder: path.join(home, 'elsewhere') });
    await controller.handleMessage({ type: 'newTask', folder: path.join(home, 'elsewhere') });
    assert.equal(shell.currentFolder()?.path, folderA);
    assert.equal(shown(), before, 'nothing happened');
  });

  it('starts a new session in another recent folder', async () => {
    const { shell, controller } = await start('desktop');
    await controller.handleMessage({ type: 'newTask', folder: folderB });
    assert.equal(shell.currentFolder()?.path, folderB);
  });

  it("deletes a task from another folder's history after asking", async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    await controller.handleMessage({ type: 'deleteTask', id: 'task-b1', folder: folderB });
    assert.equal((await new FileTaskStore(shell.storage(folderB).tasks).list()).length, 1, 'kept: the user did not confirm');
    shell.answer = 'Delete';
    await controller.handleMessage({ type: 'deleteTask', id: 'task-b1', folder: folderB });
    assert.deepEqual(await new FileTaskStore(shell.storage(folderB).tasks).list(), []);
    assert.equal(shell.currentFolder()?.path, folderA, 'the open folder stays');
    assert.deepEqual(shell.last('sessions')?.groups[1].tasks, []);
  });
});

describe('session groups', () => {
  it('creates, fills, renames and removes groups, and hides sessions', async () => {
    const { shell, controller } = await start('desktop');
    await saveTask(shell, folderB, 'task-b1', 'Fix the beta build');
    // A name is asked in a dialog: the fake shell answers none, so nothing is created.
    await controller.handleMessage({ type: 'organizeSessions', op: 'createGroup', taskId: 'task-b1' });
    assert.deepEqual(shell.globalState.get('orka.sessionOrganizer'), undefined);

    shell.input = async () => 'Release work';
    await controller.handleMessage({ type: 'organizeSessions', op: 'createGroup', taskId: 'task-b1' });
    let organizer = shell.last('sessions')!.organizer;
    assert.equal(organizer.groups.length, 1);
    const id = organizer.groups[0].id;
    assert.deepEqual([organizer.groups[0].name, organizer.assigned['task-b1']], ['Release work', id]);

    shell.input = async () => '  Shipping  ';
    await controller.handleMessage({ type: 'organizeSessions', op: 'renameGroup', groupId: id });
    await controller.handleMessage({ type: 'organizeSessions', op: 'hide', taskId: 'task-b1', hidden: true });
    organizer = shell.last('sessions')!.organizer;
    assert.equal(organizer.groups[0].name, 'Shipping');
    assert.deepEqual(organizer.hidden, ['task-b1']);

    // Unknown groups and malformed ids from the UI change nothing.
    await controller.handleMessage({ type: 'organizeSessions', op: 'moveToGroup', taskId: 'task-b1', groupId: 'g-nope' });
    await controller.handleMessage({ type: 'organizeSessions', op: 'hide', taskId: '../etc', hidden: true });
    organizer = shell.last('sessions')!.organizer;
    assert.equal(organizer.assigned['task-b1'], id, 'still in its group');
    assert.deepEqual(organizer.hidden, ['task-b1']);

    await controller.handleMessage({ type: 'organizeSessions', op: 'moveToGroup', taskId: 'task-b1' });
    assert.equal(shell.last('sessions')!.organizer.assigned['task-b1'], undefined, 'taken out of the group');
    await controller.handleMessage({ type: 'organizeSessions', op: 'moveToGroup', taskId: 'task-b1', groupId: id });
    await controller.handleMessage({ type: 'organizeSessions', op: 'deleteGroup', groupId: id });
    organizer = shell.last('sessions')!.organizer;
    assert.deepEqual([organizer.groups, organizer.assigned], [[], {}], 'its sessions go back to their folders');

    // Deleting the session clears it from the hidden list.
    shell.answer = 'Delete';
    await controller.handleMessage({ type: 'deleteTask', id: 'task-b1', folder: folderB });
    assert.deepEqual(shell.last('sessions')!.organizer.hidden, []);
  });
});

describe('agent CLIs', () => {
  // The core's fake ACP agent, run with this Node as a custom agent.
  const fakeAgent = path.resolve(__dirname, '..', '..', '..', 'core', 'test', 'fixtures', 'fake-acp.mjs');
  const agentSettings = {
    provider: 'agent:custom:fake',
    'agentClis.enabled': ['custom:fake'],
    'agentClis.custom': [{ name: 'Fake', command: process.execPath, args: [fakeAgent] }],
    'supervisor.enabled': false,
  };

  afterEach(() => {
    delete process.env.FAKE_ACP_SCRIPT;
  });

  it('runs a task with an agent CLI as the main agent, and its own file writes join Changes', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Hello from the agent.' }, { directWrite: { path: 'agent.txt', content: 'made by the agent\n' } }, { stop: 'end_turn' }]]);
    const { shell, controller } = await start('desktop', agentSettings);
    const main = shell.last('init')!.config.main;
    assert.equal(main.effective.provider, 'agent:custom:fake');
    await controller.send('Say hello and write a file');
    const events = shell.posted.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    assert.ok(
      events.some((e) => e.type === 'assistant_end' && e.text.includes('Hello from the agent.')),
      'the reply is shown',
    );
    // The change list is published once its line counts are read, just after the run.
    await until(
      () => shell.posted.some((m) => m.type === 'event' && m.event.type === 'changes' && m.event.changes.some((c) => c.relPath === 'agent.txt')),
      'the file the agent wrote itself in Changes',
    );
    assert.equal(readFileSync(path.join(folderA, 'agent.txt'), 'utf8'), 'made by the agent\n');
  });

  it('offers agent CLIs to the main agent only', async () => {
    const { shell, controller } = await start('desktop', { ...agentSettings, provider: 'claude' });
    await controller.handleMessage({ type: 'setAgent', agent: 'supervisor', provider: 'agent:custom:fake', model: '' });
    assert.equal(shell.settings.isSet('supervisor.provider'), false);
    await controller.handleMessage({ type: 'setAgent', agent: 'main', provider: 'agent:custom:fake', model: '' });
    assert.equal(shell.settings.get('provider', ''), 'agent:custom:fake');
    // A provider ref for an agent that is not turned on is never used.
    await shell.settings.update('agentClis.enabled', []);
    await tick();
    assert.notEqual(shell.last('config')!.config.main.effective.provider, 'agent:custom:fake');
  });

  it('a new task during a request stops it, keeps it in its own task, and starts empty', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Working on it.' }, { hang: true, afterCancel: ' Stopping now.' }]]);
    const { shell, controller } = await start('desktop', agentSettings);
    const sent = controller.send('First request');
    await until(() => shell.posted.some((m) => m.type === 'event' && m.event.type === 'assistant_delta'), 'the agent to start answering');
    // Two clicks: the second one waits for the first instead of starting yet another task.
    await Promise.all([controller.newTask(), controller.newTask()]);
    await sent;
    const store = new FileTaskStore(shell.storage(folderA).tasks);
    const tasks = await store.list();
    assert.equal(tasks.length, 1, 'the stopped request was saved as its own task');
    assert.match(tasks[0].title, /First request/);
    // The turn ended before the task was saved, so its answer (also what came after the stop) is in it.
    const saved = JSON.stringify((await store.load(tasks[0].id))?.messages);
    assert.match(saved, /Working on it\. Stopping now\./);
    const events = shell.posted.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    const resets = events.flatMap((e, i) => (e.type === 'reset' ? [i] : []));
    assert.equal(resets.length, 1, 'one new task');
    assert.ok(!events.slice(resets[0]).some((e) => e.type === 'assistant_delta' || e.type === 'assistant_end'), 'nothing of the old turn reaches the new task');
  });

  it('opens the sign-in by its full path in the home folder, and shows it', async () => {
    const { shell, controller } = await start('vscode', { 'agentClis.paths': { gemini: process.execPath } });
    await controller.handleMessage({ type: 'loginAgentCli', id: 'gemini' });
    assert.equal(shell.terminals.length, 1);
    const [terminal] = shell.terminals;
    assert.equal(terminal.cwd, homedir(), 'never in the open project, where a planted program could stand in');
    assert.deepEqual(terminal.command, { file: process.execPath, args: [] }, 'the program the user set, not "gemini" from PATH');
    assert.equal(terminal.shown, true);
  });

  it('says which program is missing when a sign-in needs another one', async () => {
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    process.env.PATH = path.join(home, 'empty-bin');
    if (process.platform === 'win32') process.env.Path = process.env.PATH;
    try {
      const { shell, controller } = await start('desktop');
      await controller.handleMessage({ type: 'loginAgentCli', id: 'codex' });
      assert.equal(shell.terminals.length, 0);
      const notice = shell.posted.flatMap((m) => (m.type === 'event' && m.event.type === 'notice' ? [m.event] : [])).at(-1);
      assert.match(notice?.message ?? '', /codex was not found.*npm install -g @openai\/codex/);
    } finally {
      process.env.PATH = saved.PATH;
      if (process.platform === 'win32') process.env.Path = saved.Path;
    }
  });

  it('keeps a custom agent with a long name usable', async () => {
    const name = 'Experimental in-house ACP agent for the monorepo';
    const id = customAgentEntry({ name, command: process.execPath }).id;
    assert.ok(id.length <= 'custom:'.length + 40, id);
    const { shell } = await start('desktop', {
      provider: `agent:${id}`,
      'agentClis.enabled': [id],
      'agentClis.custom': [{ name, command: process.execPath, args: [fakeAgent] }],
    });
    const config = shell.last('init')!.config;
    assert.equal(config.agentClis.find((a) => a.id === id)?.enabled, true);
    assert.equal(config.main.effective.provider, `agent:${id}`);
  });

  it('runs without the Supervisor, and says so once, when no model provider works next to the agent', async () => {
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'One.' }, { stop: 'end_turn' }], [{ chunk: 'Two.' }, { stop: 'end_turn' }]]);
      const { shell, controller } = await start('desktop', { ...agentSettings, 'supervisor.enabled': true });
      await controller.send('First');
      await controller.send('Second');
      const events = shell.posted.flatMap((m) => (m.type === 'event' ? [m.event] : []));
      assert.equal(events.filter((e) => e.type === 'notice' && e.message.startsWith('No Supervisor')).length, 1);
      assert.ok(!JSON.stringify(events).includes('No API key'), 'the Supervisor did not try a provider without a key');
      assert.ok(events.some((e) => e.type === 'assistant_end' && e.text.includes('Two.')));
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });
});

describe('desktop appearance settings', () => {
  it('are offered and saved only in the desktop app', async () => {
    const vscode = await start('vscode');
    await vscode.controller.handleMessage({ type: 'setSetting', key: 'desktop.theme', value: 'dark' });
    assert.equal(vscode.shell.settings.isSet('desktop.theme'), false);
    assert.equal(vscode.shell.last('init')?.config.ui, undefined);

    const desktop = await start('desktop');
    assert.deepEqual(desktop.shell.last('init')?.config.ui, { layout: 'ide', theme: 'system' });
    await desktop.controller.handleMessage({ type: 'setSetting', key: 'desktop.theme', value: 'dark' });
    await desktop.controller.handleMessage({ type: 'setSetting', key: 'desktop.layout', value: 'sideways' });
    assert.equal(desktop.shell.settings.get('desktop.theme', ''), 'dark');
    assert.equal(desktop.shell.settings.isSet('desktop.layout'), false, 'invalid values are refused');
    await tick();
    assert.deepEqual(desktop.shell.last('config')?.config.ui, { layout: 'ide', theme: 'dark' });
  });
});

describe('Orka update check', () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  let tag = 'v99.0.0';

  beforeEach(() => {
    delete process.env.ORKA_NO_UPDATE_CHECK;
    requests = 0;
    tag = 'v99.0.0';
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false }), { status: 200, headers: { etag: '"abc"' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('tells about a newer release once and opens its page on request', async () => {
    const { shell, controller } = await start('desktop');
    await tick();
    assert.equal(requests, 1, 'checked at start');
    const notice = shell.asked.find((a) => a.text.startsWith('Orka 99.0.0 is available'));
    assert.ok(notice, 'the user was told');
    assert.deepEqual(notice.actions, ['Download']);
    const url = 'https://github.com/Enophia-Studio/orka/releases/tag/v99.0.0';
    assert.deepEqual(shell.last('config')?.config.app.update, { version: '99.0.0', url });

    // Within a day nothing is asked again; a check on request is, without telling twice.
    await controller.checkAppUpdate();
    assert.equal(requests, 1);
    shell.answer = 'Download';
    await controller.handleMessage({ type: 'checkAppUpdate' });
    await tick();
    assert.equal(requests, 2);
    assert.deepEqual(shell.opened, [url]);
    await controller.handleMessage({ type: 'openRelease' });
    assert.deepEqual(shell.opened, [url, url]);
  });

  it('says so when Orka is up to date, and stays quiet in the background', async () => {
    tag = `v${VERSION}`;
    const { shell, controller } = await start('desktop');
    await tick();
    assert.equal(requests, 1);
    assert.equal(shell.asked.length, 0);
    await controller.handleMessage({ type: 'checkAppUpdate' });
    assert.ok(shell.asked.some((a) => a.text === `Orka is up to date (${VERSION}).`));
    assert.equal(shell.last('config')?.config.app.update, undefined);
  });

  it('says when a check got no answer instead of claiming Orka is up to date', async () => {
    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const { shell, controller } = await start('desktop');
    await tick();
    assert.equal(shell.last('config')?.config.app.error, 'GitHub answered 403');
    assert.equal(shell.asked.length, 0, 'a background failure is not announced');
    await controller.handleMessage({ type: 'checkAppUpdate' });
    assert.ok(shell.asked.some((a) => a.text === 'Could not check for a new Orka version: GitHub answered 403'));
    // The next answer clears it.
    tag = `v${VERSION}`;
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 })) as typeof fetch;
    await controller.handleMessage({ type: 'checkAppUpdate' });
    assert.equal(shell.last('config')?.config.app.error, undefined);
  });

  it('can be turned off', async () => {
    await start('vscode', { 'updates.check': false });
    process.env.ORKA_NO_UPDATE_CHECK = '1';
    await start('desktop');
    await tick();
    assert.equal(requests, 0);
  });

  it('never opens a page it did not build itself', async () => {
    const { shell, controller } = await start('desktop', { 'updates.check': false });
    await shell.globalState.update('orka.appUpdate', { checkedAt: Date.now(), latest: '99.0.0', url: 'https://evil.example/orka.exe' });
    await controller.handleMessage({ type: 'openRelease' });
    assert.deepEqual(shell.opened, []);
  });
});

describe('desktop Files and editor', () => {
  const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  const sessionOf = (controller: AppController) => controller.activeSession!;
  const orchestratorOf = (controller: AppController): Orchestrator => sessionOf(controller).orchestrator;
  const notesOf = (controller: AppController) => (orchestratorOf(controller) as unknown as { notes: string[] }).notes;
  const notices = (shell: FakeShell) => shell.posted.flatMap((m) => (m.type === 'event' && m.event.type === 'notice' ? [m.event.message] : []));
  const fakeAgent = path.resolve(__dirname, '..', '..', '..', 'core', 'test', 'fixtures', 'fake-acp.mjs');
  const agentSettings = {
    provider: 'agent:custom:fake',
    'agentClis.enabled': ['custom:fake'],
    'agentClis.custom': [{ name: 'Fake', command: process.execPath, args: [fakeAgent] }],
    'supervisor.enabled': false,
  };
  const lines = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

  afterEach(() => {
    delete process.env.FAKE_ACP_SCRIPT;
  });

  /** A file the agent changed from `original` to `current` (as the change tracker sees it). */
  function agentChanged(controller: AppController, rel: string, original: string, current: string): string {
    const abs = path.join(folderA, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, current);
    orchestratorOf(controller).changes.recordOriginal(abs, original);
    return abs;
  }

  /** Save through the editor's message, with the hash of what is on disk now. */
  async function save(controller: AppController, rel: string, text: string) {
    await controller.handleMessage({ type: 'saveFile', path: rel, text, baseHash: sha(readFileSync(path.join(folderA, rel))) });
  }

  it('lists folders, reads files and saves them for the editor', async () => {
    const { shell, controller } = await start('desktop');
    mkdirSync(path.join(folderA, 'src'));
    writeFileSync(path.join(folderA, 'src', 'hello.ts'), 'one\r\ntwo\r\n');
    await controller.handleMessage({ type: 'listDir', path: '' });
    assert.deepEqual(shell.last('dirEntries'), { type: 'dirEntries', path: '', entries: [{ name: 'src', kind: 'dir' }] });
    await controller.handleMessage({ type: 'listDir', path: '../beta' });
    assert.deepEqual(shell.last('dirEntries'), { type: 'dirEntries', path: '../beta', error: 'outside' });
    await controller.handleMessage({ type: 'readFile', path: 'src/hello.ts' });
    const hash = sha('one\r\ntwo\r\n');
    assert.deepEqual(shell.last('fileContent'), { type: 'fileContent', path: 'src/hello.ts', ok: true, text: 'one\ntwo\n', hash, size: 10, eol: 'crlf', bom: false });
    await controller.handleMessage({ type: 'readFile', path: 'src/hello.ts', knownHash: hash });
    assert.deepEqual(shell.last('fileContent'), { type: 'fileContent', path: 'src/hello.ts', ok: true, unchanged: true, hash });
    await controller.handleMessage({ type: 'readFile', path: 'src/missing.ts' });
    assert.deepEqual(shell.last('fileContent'), { type: 'fileContent', path: 'src/missing.ts', ok: false, reason: 'notFound' });
    await controller.handleMessage({ type: 'saveFile', path: 'src/hello.ts', text: 'one\ntwo\nthree\n', baseHash: hash });
    assert.equal(readFileSync(path.join(folderA, 'src', 'hello.ts'), 'utf8'), 'one\r\ntwo\r\nthree\r\n');
    assert.deepEqual(shell.last('fileSaved'), { type: 'fileSaved', path: 'src/hello.ts', hash: sha('one\r\ntwo\r\nthree\r\n') });
    assert.ok(notesOf(controller).some((n) => n.includes('The user edited src/hello.ts by hand')));
    // The page's old hash no longer matches what is on disk.
    await controller.handleMessage({ type: 'saveFile', path: 'src/hello.ts', text: 'other\n', baseHash: hash });
    assert.deepEqual(shell.last('saveRefused'), { type: 'saveRefused', path: 'src/hello.ts', reason: 'conflict', hash: sha('one\r\ntwo\r\nthree\r\n') });
  });

  it('refuses to save while the agent works or a hand-off is open', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Working.' }, { hang: true }]]);
    const { shell, controller } = await start('desktop', agentSettings);
    writeFileSync(path.join(folderA, 'a.txt'), 'before\n');
    const sent = controller.send('Do something');
    await until(() => orchestratorOf(controller).isRunning && shell.posted.some((m) => m.type === 'event' && m.event.type === 'assistant_delta'), 'the agent to work');
    await save(controller, 'a.txt', 'mine\n');
    assert.deepEqual(shell.last('saveRefused'), { type: 'saveRefused', path: 'a.txt', reason: 'running' });
    controller.stop();
    await sent;
    (sessionOf(controller) as unknown as { handoff?: unknown }).handoff = { session: {}, terminal: { show: () => undefined } };
    await save(controller, 'a.txt', 'mine\n');
    assert.equal(shell.posted.filter((m) => m.type === 'saveRefused' && m.reason === 'running').length, 2);
    assert.equal(readFileSync(path.join(folderA, 'a.txt'), 'utf8'), 'before\n');
    (sessionOf(controller) as unknown as { handoff?: unknown }).handoff = undefined;
  });

  it('refuses to save while a hand-off starts and until a closed one is collected', async () => {
    const { shell, controller } = await start('desktop');
    writeFileSync(path.join(folderA, 'a.txt'), 'before\n');
    const inner = sessionOf(controller) as unknown as { handoff?: unknown; handoffBusy: number; collectHandoff(ended: boolean): Promise<void> };
    // Between the snapshot and the open terminal.
    inner.handoffBusy = 1;
    await save(controller, 'a.txt', 'mine\n');
    assert.equal(shell.last('saveRefused')?.reason, 'running');
    inner.handoffBusy = 0;
    // The terminal closed; its changes are still being read.
    let finish!: (changed: unknown[]) => void;
    inner.handoff = { session: { agent: { label: 'Other' }, collect: () => new Promise((resolve) => (finish = resolve)) }, terminal: { show: () => undefined } };
    const collecting = inner.collectHandoff(true);
    assert.equal(inner.handoff, undefined);
    await save(controller, 'a.txt', 'mine\n');
    assert.equal(shell.posted.filter((m) => m.type === 'saveRefused').length, 2);
    assert.equal(readFileSync(path.join(folderA, 'a.txt'), 'utf8'), 'before\n');
    finish([]);
    await collecting;
    await save(controller, 'a.txt', 'mine\n');
    assert.equal(readFileSync(path.join(folderA, 'a.txt'), 'utf8'), 'mine\n');
  });

  it("protects a save made through another path to a file the agent changed", async () => {
    const { controller } = await start('desktop');
    mkdirSync(path.join(folderA, 'src'));
    symlinkSync(path.join(folderA, 'src'), path.join(folderA, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
    // The agent wrote lib/a.txt; the user saves the same file as src/a.txt.
    const viaLink = agentChanged(controller, 'lib/a.txt', 'original\n', 'agent\n');
    await save(controller, 'src/a.txt', 'agent\nand mine\n');
    assert.equal(orchestratorOf(controller).changes.isUserEdited(viaLink), true);
    assert.deepEqual(await orchestratorOf(controller).changes.revertAll(), []);
    assert.equal(readFileSync(path.join(folderA, 'src', 'a.txt'), 'utf8'), 'agent\nand mine\n');
  });

  it('opens only documents and media with the system app', async () => {
    const { shell, controller } = await start('desktop');
    for (const name of ['photo.png', 'notes.md', 'tools/setup.py', 'run.pyw', 'help.chm', 'x.settingcontent-ms', 'build', 'a.exe', 'page.html']) {
      mkdirSync(path.dirname(path.join(folderA, name)), { recursive: true });
      writeFileSync(path.join(folderA, name), 'x');
    }
    // On macOS and Linux a file marked executable is refused whatever its name.
    writeFileSync(path.join(folderA, 'script.txt'), 'x');
    const unix = process.platform !== 'win32';
    if (unix) chmodSync(path.join(folderA, 'script.txt'), 0o755);
    for (const name of ['photo.png', 'notes.md', 'tools/setup.py', 'run.pyw', 'help.chm', 'x.settingcontent-ms', 'build', 'a.exe', 'page.html', 'script.txt']) {
      await controller.handleMessage({ type: 'openExternalFile', path: name });
    }
    assert.deepEqual(shell.openedFiles.map((f) => path.basename(f)), ['photo.png', 'notes.md', ...(unix ? [] : ['script.txt'])]);
    assert.equal(shell.asked.filter((a) => a.text.startsWith('Orka opens only documents')).length, unix ? 8 : 7);
  });

  it("marks a saved file as the user's, so Revert All keeps it and says so", async () => {
    const { shell, controller } = await start('desktop');
    agentChanged(controller, 'mine.txt', 'original\n', 'agent\n');
    const other = agentChanged(controller, 'other.txt', 'original\n', 'agent\n');
    await save(controller, 'mine.txt', 'agent\nand mine\n');
    const changes = await orchestratorOf(controller).changes.list();
    assert.equal(changes.find((c) => c.relPath === 'mine.txt')?.userEdited, true);
    shell.answer = 'Revert All';
    await controller.handleMessage({ type: 'revertAll' });
    assert.match(shell.asked.at(-1)!.text, /Revert the 1 AI-changed file\? 1 file you edited after the agent stays as it is\./);
    assert.equal(readFileSync(path.join(folderA, 'mine.txt'), 'utf8'), 'agent\nand mine\n');
    assert.equal(readFileSync(other, 'utf8'), 'original\n');
    assert.ok(notices(shell).includes('Kept 1 file(s) you edited: mine.txt. Revert their parts in Changes.'));
    assert.ok(notesOf(controller).some((n) => n.includes('these files: other.txt.')));
  });

  it("undoes only the agent's part of a file the user edited, never the user's lines", async (t) => {
    if (!programPath('git')) return t.skip('needs git');
    const { shell, controller } = await start('desktop');
    const abs = agentChanged(controller, 'f.txt', lines(12), lines(12, { 2: 'agent line' }));
    await save(controller, 'f.txt', lines(12, { 2: 'agent line', 10: 'my line' }));
    shell.answer = undefined;
    await controller.handleMessage({ type: 'revertChange', path: abs });
    assert.match(shell.asked.at(-1)!.text, /You edited f\.txt after the agent\./);
    assert.deepEqual(shell.asked.at(-1)!.actions, ["Undo only the agent's part"], 'nothing offers to throw the edit away');
    assert.equal(readFileSync(abs, 'utf8'), lines(12, { 2: 'agent line', 10: 'my line' }), 'cancelled: nothing changed');
    shell.answer = "Undo only the agent's part";
    await controller.handleMessage({ type: 'revertChange', path: abs });
    assert.equal(readFileSync(abs, 'utf8'), lines(12, { 10: 'my line' }));
    // Edits on the same lines cannot be told apart: nothing is written.
    const both = agentChanged(controller, 'g.txt', lines(5), lines(5, { 3: 'agent' }));
    await save(controller, 'g.txt', lines(5, { 3: 'agent and me' }));
    await controller.handleMessage({ type: 'revertChange', path: both });
    assert.equal(readFileSync(both, 'utf8'), lines(5, { 3: 'agent and me' }));
    assert.match(notices(shell).at(-1)!, /Could not separate your edits from the agent's in g\.txt/);
  });

  it('leaves a hunk alone when the page showed another one, or when it has lines the user edited', async () => {
    const { shell, controller } = await start('desktop');
    const abs = agentChanged(controller, 'h.txt', lines(20), lines(20, { 2: 'agent A', 18: 'agent B' }));
    assert.equal((await orchestratorOf(controller).changes.hunks(abs)).length, 2);
    await controller.handleMessage({ type: 'revertHunk', path: abs, index: 0, header: '@@ -1,1 +1,1 @@' });
    assert.equal(readFileSync(abs, 'utf8'), lines(20, { 2: 'agent A', 18: 'agent B' }), 'a stale header writes nothing');
    assert.match(shell.asked.at(-1)!.text, /no longer exists/);
    await controller.handleMessage({ type: 'keepHunk', path: abs, index: 0, header: '@@ -1,1 +1,1 @@' });
    assert.equal((await orchestratorOf(controller).changes.hunks(abs)).length, 2, 'a stale header keeps nothing');
    await save(controller, 'h.txt', lines(20, { 2: 'agent A', 3: 'mine', 18: 'agent B' }));
    const [first, second] = await orchestratorOf(controller).changes.hunks(abs);
    await controller.handleMessage({ type: 'revertHunk', path: abs, index: 0, header: hunkHeader(first) });
    assert.equal(shell.asked.at(-1)!.text, 'This part includes lines you edited; it was left as is.');
    await controller.handleMessage({ type: 'revertHunk', path: abs, index: 1, header: hunkHeader(second) });
    assert.equal(readFileSync(abs, 'utf8'), lines(20, { 2: 'agent A', 3: 'mine' }));
  });

  it('sends the editor selection as the context of the request, checked', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Ok.' }, { stop: 'end_turn' }], [{ chunk: 'Ok.' }, { stop: 'end_turn' }]]);
    const { shell, controller } = await start('desktop', agentSettings);
    writeFileSync(path.join(folderA, 'hello.ts'), 'a\nb\nc\n');
    writeFileSync(path.join(folderA, '.env'), 'TOKEN=x\n');
    const orchestrator = orchestratorOf(controller);
    const lastPrompt = () => JSON.stringify(orchestrator.history.filter((m) => m.role === 'user').at(-1));
    await controller.send('Explain', [], [], [], { file: 'hello.ts', selection: { startLine: 2, endLine: 3, text: 'b\nc' } });
    assert.match(lastPrompt(), /Active file: hello\.ts/);
    assert.match(lastPrompt(), /Selected lines 2-3:\\n```\\nb\\nc\\n```/);
    assert.equal((orchestrator as unknown as { secretFile?: string }).secretFile, undefined);

    const before = orchestrator.history.length;
    for (const editor of [
      { file: '../beta/x.ts' },
      { file: 'missing.ts' },
      { file: 'hello.ts', selection: { startLine: 0, endLine: 1, text: 'a' } },
      { file: 'hello.ts', selection: { startLine: 3, endLine: 2, text: 'a' } },
      { file: 'hello.ts', selection: { startLine: 1.5, endLine: 2, text: 'a' } },
      { file: 'hello.ts', selection: { startLine: 1, endLine: 2, text: 42 } },
    ]) {
      await controller.send('Explain', [], [], [], editor as never);
    }
    assert.equal(orchestrator.history.length, before, 'nothing was sent');
    assert.equal(notices(shell).filter((n) => n.startsWith('Not sent: the selection from the editor')).length, 6);

    // A secret-looking file the user selected makes web access ask first, as an agent's read would.
    await controller.send('Explain', [], [], [], { file: '.env', selection: { startLine: 1, endLine: 1, text: 'TOKEN=x' } });
    assert.equal((orchestrator as unknown as { secretFile?: string }).secretFile, '.env');
  });

  it('does not attach a file through a link that leaves the folder', async () => {
    process.env.FAKE_ACP_SCRIPT = JSON.stringify([[{ chunk: 'Ok.' }, { stop: 'end_turn' }]]);
    const { controller } = await start('desktop', agentSettings);
    writeFileSync(path.join(folderB, 'secret.txt'), 'outside content\n');
    symlinkSync(folderB, path.join(folderA, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(folderA, 'inside.txt'), 'inside content\n');
    await controller.send('Look', ['out/secret.txt', 'inside.txt']);
    const prompt = JSON.stringify(orchestratorOf(controller).history.filter((m) => m.role === 'user').at(-1));
    assert.match(prompt, /<attached_file path=\\"inside\.txt\\">\\ninside content/);
    assert.doesNotMatch(prompt, /outside content/);
  });

  it('ignores the Files messages in VS Code', async () => {
    const { shell, controller } = await start('vscode');
    writeFileSync(path.join(folderA, 'a.txt'), 'before\n');
    await controller.handleMessage({ type: 'listDir', path: '' });
    await controller.handleMessage({ type: 'readFile', path: 'a.txt' });
    await controller.handleMessage({ type: 'saveFile', path: 'a.txt', text: 'mine\n', baseHash: sha('before\n') });
    await controller.handleMessage({ type: 'openExternalFile', path: 'a.txt' });
    assert.ok(!shell.posted.some((m) => ['dirEntries', 'fileContent', 'fileSaved', 'saveRefused'].includes(m.type)));
    assert.equal(readFileSync(path.join(folderA, 'a.txt'), 'utf8'), 'before\n');
  });
});
