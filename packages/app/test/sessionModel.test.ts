// The composer's model menu: each session's own model, effort and Claude Code profile, copied
// from the settings when the session starts.
import { applyEvent, type ClaudeCodeProviderOptions, emptySession } from '@orka/core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import type { RunGate } from '../src/runGate';
import type { SessionController } from '../src/SessionController';
import { effortLevels, readChoice } from '../src/sessionModel';
import { FakeShell } from './fakeShell';

let home: string;
let folderA: string;
let folderB: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-model-menu-test-'));
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

// Claude Code as the main agent; its program is never started (a path that does not exist).
const claudeCode = (extra: Record<string, unknown> = {}) => ({
  provider: 'claude-code',
  'claudeCode.enabled': true,
  'claudeCode.path': path.join(tmpdir(), 'no-such-claude', 'claude.exe'),
  'claudeCode.effort': 'high',
  'supervisor.enabled': false,
  ...extra,
});

async function start(kind: 'vscode' | 'desktop', settings: Record<string, unknown>) {
  const shell = new FakeShell(kind, home, [folderA, folderB], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

/** Two open sessions (desktop): alpha, then beta, which is shown. */
async function twoSessions(settings: Record<string, unknown>) {
  const started = await start('desktop', settings);
  const a = started.controller.activeSession!;
  await started.controller.handleMessage({ type: 'selectFolder', path: folderB });
  const b = started.controller.activeSession!;
  assert.notEqual(a, b);
  return { ...started, a, b };
}

type Private = {
  providerFor(name: string, session?: SessionController): { id: string; options?: ClaudeCodeProviderOptions };
  runAccounts(session?: SessionController): string[];
  mainProvider(): string;
  sessionChoice(session: SessionController): SessionController['choice'];
  radarProvider(ref: string, model: string): { dispose?(): void };
  claudeCodeStatus: { state: string };
  gate: RunGate;
};
const internals = (controller: AppController) => controller as unknown as Private;
const options = (controller: AppController, session: SessionController, role = 'main') => internals(controller).providerFor(role, session).options ?? {};

describe('the model menu (per session)', () => {
  it('starts each session from the settings and changes only that session', async () => {
    const { controller, a, b } = await twoSessions(claudeCode());
    assert.equal(a.choice.effort, 'high');
    assert.equal(b.choice.effort, 'high');
    await controller.handleMessage({ type: 'setSessionModel', sessionId: a.id, effort: 'max', model: 'opus' });
    assert.equal(options(controller, a).effort, 'max');
    assert.equal(options(controller, a).model, 'opus');
    assert.equal(options(controller, b).effort, 'high');
    // Two efforts: two providers, so neither session's process is replaced by the other's.
    assert.notEqual(internals(controller).providerFor('main', a), internals(controller).providerFor('main', b));
    // A sub-agent set to "Same as main" follows the session's choice.
    assert.equal(options(controller, a, 'explorer').effort, 'max');
  });

  it('shows the session shown its own choice', async () => {
    const { shell, controller, a } = await twoSessions(claudeCode());
    await controller.handleMessage({ type: 'setSessionModel', effort: 'low' });
    const view = shell.last('config')!.config.sessionModel!;
    assert.equal(view.provider, 'claude-code');
    assert.equal(view.effort, 'low');
    assert.equal(view.defaultEffort, 'high');
    assert.deepEqual(view.efforts, effortLevels('claude-code'));
    assert.ok(view.differs);
    assert.equal(a.choice.effort, 'high', 'the message without a session id went to the session shown');
  });

  it('refuses values the provider does not take', async () => {
    const { controller, b } = await twoSessions(claudeCode());
    const before = { ...b.choice };
    await controller.handleMessage({ type: 'setSessionModel', effort: 'turbo' });
    await controller.handleMessage({ type: 'setSessionModel', profile: 'nobody' });
    await controller.handleMessage({ type: 'setSessionModel', model: 'bad model id; rm -rf' });
    assert.deepEqual(b.choice, before);
  });

  it('"Use as default" writes the settings and leaves other sessions alone', async () => {
    const { shell, controller, a, b } = await twoSessions(claudeCode());
    await controller.handleMessage({ type: 'setSessionModel', sessionId: b.id, effort: 'max', model: 'sonnet' });
    await controller.handleMessage({ type: 'useModelAsDefault', sessionId: b.id });
    assert.equal(shell.settings.data['claudeCode.effort'], 'max');
    assert.equal(shell.settings.data['claudeCode.model'], 'sonnet');
    assert.equal(a.choice.effort, 'high');
    assert.equal(options(controller, a).effort, 'high');
  });

  it('writes the effort setting of the provider in use', async () => {
    const { shell, controller } = await start('vscode', { provider: 'gemini', 'gemini.thinkingLevel': 'low', 'supervisor.enabled': false });
    await controller.handleMessage({ type: 'setSessionModel', effort: '' });
    await controller.handleMessage({ type: 'useModelAsDefault' });
    assert.equal(shell.settings.data['gemini.thinkingLevel'], '');
    assert.equal(shell.settings.data['claudeCode.effort'], undefined);
  });

  it('applies a change from the next request on', async () => {
    const { controller, b } = await twoSessions(claudeCode());
    await b.compact();
    assert.equal(b.runChoice?.effort, 'high');
    await controller.handleMessage({ type: 'setSessionModel', effort: 'low' });
    // The last request's choice holds until the next one starts.
    assert.equal(options(controller, b).effort, 'high');
    await b.compact();
    assert.equal(options(controller, b).effort, 'low');
  });

  it('runs each session on its own Claude Code profile', async () => {
    const work = path.join(home, '.claude-work');
    const { controller, a, b } = await twoSessions(claudeCode({ 'accounts.claudeProfiles': [{ id: 'work', name: 'Work', dir: work }] }));
    await controller.handleMessage({ type: 'setSessionModel', sessionId: a.id, profile: 'work' });
    assert.deepEqual(internals(controller).runAccounts(a), ['claude-code:work']);
    assert.deepEqual(internals(controller).runAccounts(b), ['claude-code:']);
    assert.equal(options(controller, a).configDir, work);
    assert.equal(options(controller, b).configDir, undefined);
  });

  it('keeps a task’s choice when the task is opened again', async () => {
    const { controller, b } = await twoSessions(claudeCode());
    const view = emptySession();
    applyEvent(view, { type: 'user_message', id: 'u1', text: 'Earlier' });
    const now = new Date().toISOString();
    await b.store.save({
      version: 1,
      id: 't-earlier',
      title: 'Earlier',
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Earlier' }] }],
      subagentProfiles: [],
      usageByAgent: [],
      view,
      modelChoice: { provider: 'claude-code', model: 'haiku', effort: 'low', profile: '' },
    });
    await b.open('t-earlier');
    assert.equal(b.choice.model, 'haiku');
    assert.equal(options(controller, b).effort, 'low');
  });

  it('starts from the settings when the main agent moves to another provider, and gets its own choice back when it returns', async () => {
    const { shell, controller, b } = await twoSessions(claudeCode({ 'gemini.thinkingLevel': 'medium' }));
    await controller.handleMessage({ type: 'setSessionModel', effort: 'max' });
    await shell.settings.update('provider', 'gemini');
    const choice = internals(controller).sessionChoice(b);
    assert.deepEqual([choice.provider, choice.effort], ['gemini', 'medium']);
    await shell.settings.update('provider', 'claude-code');
    assert.equal(options(controller, b).effort, 'max', 'a while on another provider does not lose it');
  });

  it('keeps a ready CLI as the main agent while it is checked again (CLI-first)', async () => {
    const { controller } = await start('desktop', { 'claudeCode.enabled': true, 'claudeCode.path': path.join(tmpdir(), 'no-such-claude', 'claude.exe'), 'supervisor.enabled': false });
    await controller.checkClaudeCode();
    const inner = internals(controller);
    inner.claudeCodeStatus = { state: 'ready' };
    assert.equal(inner.mainProvider(), 'claude-code');
    const check = controller.checkClaudeCode();
    assert.equal(inner.claudeCodeStatus.state, 'checking');
    assert.equal(inner.mainProvider(), 'claude-code', 'still the CLI while the check runs');
    await check;
    assert.equal(inner.mainProvider(), 'claude', 'a failed check moves it');
  });

  it('keeps a run under way on the provider it started with when the main agent changes meanwhile', async () => {
    const { controller, b } = await start('desktop', { 'claudeCode.enabled': true, 'claudeCode.path': path.join(tmpdir(), 'no-such-claude', 'claude.exe'), 'supervisor.enabled': false }).then(
      (s) => ({ ...s, b: s.controller.activeSession! }),
    );
    await controller.checkClaudeCode();
    const inner = internals(controller);
    inner.claudeCodeStatus = { state: 'ready' };
    b.runChoice = inner.sessionChoice(b);
    Object.defineProperty(b, 'isRunning', { get: () => true, configurable: true });
    inner.claudeCodeStatus = { state: 'not_found' };
    assert.equal(inner.mainProvider(), 'claude');
    assert.equal(inner.providerFor('main', b).id, 'claude-code', 'the run goes on as it started');
    assert.deepEqual(inner.runAccounts(b), ['claude-code:']);
    Object.defineProperty(b, 'isRunning', { get: () => false, configurable: true });
    assert.throws(() => inner.providerFor('main', b), /No API key set for Claude/, 'the next run is on the new main agent');
  });

  it('holds the Claude Code profile for a Radar analysis, and refuses one while another profile runs', async () => {
    const work = path.join(home, '.claude-work');
    const { controller, a } = await twoSessions(claudeCode({ 'accounts.claudeProfiles': [{ id: 'work', name: 'Work', dir: work }] }));
    const inner = internals(controller);
    const radar = inner.radarProvider('claude-code', '');
    assert.equal(inner.gate.profileInUse('claude-code'), '');
    assert.equal(inner.gate.acquire(a.id, folderA, ['claude-code:work']).ok, false, 'a session on another profile waits for it');
    radar.dispose?.();
    assert.equal(inner.gate.profileInUse('claude-code'), undefined);
    const run = inner.gate.acquire(a.id, folderA, ['claude-code:work']);
    assert.ok(run.ok);
    assert.throws(() => inner.radarProvider('claude-code', ''), /A session runs Claude Code \(Work\)|A session runs .*Work/);
    run.release();
  });
});

describe('readChoice', () => {
  it('drops what is malformed', () => {
    assert.equal(readChoice(undefined), undefined);
    assert.equal(readChoice({ model: 'x' }), undefined);
    assert.deepEqual(readChoice({ provider: 'claude', model: 3, effort: 'low', options: { 'ok-id': 'v1', 'bad\u0000': 'v', x: 4 } }), {
      provider: 'claude',
      model: '',
      effort: 'low',
      profile: '',
      options: { 'ok-id': 'v1' },
    });
  });
});

describe('the model menu for an agent CLI', () => {
  const agentSettings = {
    provider: 'agent:custom:fake',
    'agentClis.enabled': ['custom:fake'],
    'agentClis.custom': [{ name: 'Fake', command: process.execPath, args: [path.join(home ?? tmpdir(), 'never-started.mjs')] }],
    'supervisor.enabled': false,
  };
  const advertised = [
    { id: 'model', name: 'Model', category: 'model' as const, currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'pro', name: 'Pro' }] },
  ];
  type ViewOf = { sessionModelView(session: SessionController): { agentOptions?: typeof advertised } };

  it('takes only an option the session’s agent advertised, with a value it lists, from the next prompt on', async () => {
    const { controller, a, b } = await twoSessions(agentSettings);
    a.agentOptions = { agent: 'custom:fake', options: advertised };
    await controller.handleMessage({ type: 'setSessionModel', sessionId: a.id, option: { id: 'model', value: 'nope' } });
    await controller.handleMessage({ type: 'setSessionModel', sessionId: a.id, option: { id: 'mode', value: 'yolo' } });
    assert.equal(a.choice.options, undefined, 'unlisted values and unadvertised options are dropped');
    await controller.handleMessage({ type: 'setSessionModel', sessionId: a.id, option: { id: 'model', value: 'pro' } });
    assert.deepEqual(a.choice.options, { model: 'pro' });
    // The menu shows the pick; the other session's agent advertised nothing, so it takes none.
    const view = (controller as unknown as ViewOf).sessionModelView(a);
    assert.equal(view.agentOptions?.[0].currentValue, 'pro');
    await controller.handleMessage({ type: 'setSessionModel', sessionId: b.id, option: { id: 'model', value: 'pro' } });
    assert.equal(b.choice.options, undefined);
    // Options another agent advertised do not count for this one.
    b.agentOptions = { agent: 'codex', options: advertised };
    await controller.handleMessage({ type: 'setSessionModel', sessionId: b.id, option: { id: 'model', value: 'pro' } });
    assert.equal(b.choice.options, undefined);
  });
});
