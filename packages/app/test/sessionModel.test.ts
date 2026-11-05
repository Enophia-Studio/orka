// The composer's model menu: each session's own model, effort and Claude Code profile, copied
// from the settings when the session starts.
import { applyEvent, type ClaudeCodeProviderOptions, emptySession } from '@orka/core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
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
  providerFor(name: string, session?: SessionController): { options?: ClaudeCodeProviderOptions };
  runAccounts(session?: SessionController): string[];
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

  it('starts again from the settings when the main agent moves to another provider', async () => {
    const { controller, b } = await twoSessions(claudeCode({ 'gemini.thinkingLevel': 'medium' }));
    await controller.handleMessage({ type: 'setSessionModel', effort: 'max' });
    await controller.handleMessage({ type: 'setAgent', agent: 'main', provider: 'gemini', model: '' });
    assert.equal(b.choice.provider, 'gemini');
    assert.equal(b.choice.effort, 'medium');
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
