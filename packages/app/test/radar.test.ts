// The desktop app's Radar through the shared controller: a fake shell, a fake fetch for the feeds,
// fake timers, and a local OpenAI-compatible server that answers each analysis stage with JSON.
import { defaultSources, HostPacer, setLocale, validateReport } from '@orka/core';
import { TR } from '@orka/core/src/i18n/tr';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import type { ProviderView, RadarReportView, RadarView } from '../src/protocol';
import type { RadarHooks, RadarTimers } from '../src/radar';
import { DESKTOP_SETTINGS, RADAR_SETTINGS, readSettings, USER_LEVEL_SETTINGS, WEBVIEW_SETTINGS } from '../src/settings';
import { appendToDraft } from '../webview/core/format';
import { radarBadge, radarLabel, radarPanelHtml, radarSettingsCard } from '../webview/features/radar';
import { radarEntryHtml } from '../webview/ide/sidebar';
import { FakeShell, MemorySettings } from './fakeShell';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'core', 'test', 'fixtures', 'radar');
const NOW = () => new Date('2026-10-30T00:00:00Z');
const SOURCE = {
  id: 'agent-cli',
  vendor: 'Example',
  product: 'Agent CLI',
  kind: 'atom',
  url: 'https://github.com/example/agent-cli/releases.atom',
  allowHosts: ['github.com'],
  minIntervalHours: 6,
  maxBytes: 2_000_000,
  enabled: true,
};
const BROKEN = { ...SOURCE, id: 'other-ide', vendor: 'Other', product: 'Other IDE', url: 'https://other.example/changelog.atom', allowHosts: ['other.example'] };

let home: string;
let folder: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-radar-test-'));
  folder = path.join(home, 'work', 'alpha');
  for (const dir of [folder, path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

/** Timers that run only when the test says so. */
class FakeTimers implements RadarTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  set(callback: () => void, ms: number): number {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Run every timer set so far; returns their delays. */
  fire(): number[] {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const timer of due) timer.callback();
    return due.map((timer) => timer.ms);
  }
}

interface FakeFetch {
  impl: typeof fetch;
  requests: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }>;
}

/** The fixture feed for the example source, 404 for anything else; `hang` answers nothing until the request is aborted. */
function fakeFetch(hang = false): FakeFetch {
  const requests: FakeFetch['requests'] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    requests.push({ url: String(input), headers: new Headers(init?.headers), signal });
    if (hang) {
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (String(input) !== SOURCE.url) return new Response('not here', { status: 404 });
    return new Response(readFileSync(path.join(FIXTURES, 'github-releases.atom'), 'utf8'), { status: 200 });
  }) as typeof fetch;
  return { impl, requests };
}

// ------------------------------------------------------------------ a model server

const STAGES: Array<[string, string]> = [
  ['You read public release notes', 'summarize'],
  ['You compare changes', 'map'],
  ['You group', 'cluster'],
  ['You compare how', 'compare'],
  ['You decide', 'decide'],
];
const changeIds = (text: string) => [...text.matchAll(/^- id: (\S+) \|/gm)].map((m) => m[1]);

/** Valid answers for every stage, built from the prompt the way a well-behaved model would (as the core's tests do). */
function stageReply(stage: string, prompt: string): string {
  switch (stage) {
    case 'summarize': {
      const who = /^Product: (.+)$/m.exec(prompt)![1];
      return JSON.stringify({ items: [{ title: 'Background agents', summary: `${who} lets agents keep running while the user does something else.`, kind: 'feature', relevance: 3, tags: ['agents', 'sessions'] }] });
    }
    case 'map':
      return JSON.stringify({ mappings: changeIds(prompt).map((id) => ({ id, match: 'gap', featureIds: [] })) });
    case 'cluster':
      return JSON.stringify({ clusters: [{ key: 'new:background-agents', title: 'Background agents', itemIds: changeIds(prompt) }] });
    case 'compare': {
      const vendors = /^Vendors: (.+)$/m.exec(prompt)![1].split(', ');
      return JSON.stringify({ approaches: vendors.map((v) => ({ vendor: v, approach: `${v} runs agents in the background.` })), assessment: 'The notes do not say how changes are reviewed.', confidence: 'medium' });
    }
    default:
      return JSON.stringify({
        decision: 'gap',
        priority: 'P2',
        effort: 'M',
        fitsPrinciples: true,
        rationale: 'Orka runs one task at a time in the foreground.',
        proposal: {
          title: 'Background tasks',
          problem: 'Users wait for a task to finish before they can start another one.',
          acceptanceCriteria: ['A task can keep running while another session is open', 'Approvals of a background task show a badge'],
          areas: ['agents', 'sessions'],
        },
      });
  }
}

const model: { server?: http.Server; baseUrl: string; requests: Array<{ stage: string; system: string; prompt: string }> } = { baseUrl: '', requests: [] };

before(async () => {
  model.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0].content;
      const prompt = body.messages[1].content;
      const stage = STAGES.find(([prefix]) => system.startsWith(prefix))?.[1] ?? 'unknown';
      model.requests.push({ stage, system, prompt });
      const chunk = (choices: unknown[], extra = {}) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices, ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        chunk([{ index: 0, delta: { role: 'assistant', content: stageReply(stage, prompt) }, finish_reason: null }]) +
          chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
          chunk([], { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) => model.server!.listen(0, '127.0.0.1', resolve));
  model.baseUrl = `http://127.0.0.1:${(model.server!.address() as { port: number }).port}/v1`;
});

after(() => model.server?.close());
beforeEach(() => (model.requests = []));

/** The user's own OpenAI-compatible endpoint, pointing at the server above. */
const localProvider = () => ({ customProviders: [{ id: 'local', label: 'Local', baseUrl: model.baseUrl, requiresKey: false, models: ['fake-1'], defaultModel: 'fake-1' }] });

// ------------------------------------------------------------------ helpers

async function start(settings: Record<string, unknown> = {}, hooks: Partial<RadarHooks> = {}, kind: 'desktop' | 'vscode' = 'desktop') {
  const shell = new FakeShell(kind, home, [folder], settings);
  // The endpoint's model list counts as fresh: no background request to it.
  await shell.globalState.update('orka.modelCache', { 'custom:local': { at: Date.now(), models: ['fake-1'] } });
  const timers = new FakeTimers();
  const feed = fakeFetch();
  const controller = new AppController(shell, { radar: { fetchImpl: feed.impl, now: NOW, timers, sources: [SOURCE], pacer: new HostPacer(0), ...hooks } });
  controllers.push(controller);
  await controller.initialize();
  const view = () => shell.last('radar')?.radar as RadarView;
  return { shell, controller, timers, feed, view };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Radar turned on in the settings file: the first poll is planned 30 s after the start; run it. */
async function polled(settings: Record<string, unknown> = {}, hooks: Partial<RadarHooks> = {}) {
  const started = await start({ 'radar.enabled': true, ...localProvider(), ...settings }, hooks);
  assert.deepEqual(started.timers.fire(), [30_000], 'the first poll waits until the window is open');
  await until(() => started.view().pending === 1 && !started.view().polling, 'the poll');
  return started;
}

/** ... and analyze what it found. */
async function analyzed(settings: Record<string, unknown> = {}) {
  const started = await polled({ 'radar.provider': 'custom:local', ...settings });
  await started.controller.handleMessage({ type: 'radar', action: 'analyze' });
  const report = started.shell.last('radarReport')?.report as RadarReportView;
  assert.ok(report, 'the report was posted');
  return { ...started, report };
}

// ------------------------------------------------------------------ tests

describe('Radar (desktop)', () => {
  it('is off by default: it fetches nothing, plans nothing, and names every host it would contact', async () => {
    const { shell, controller, timers, feed, view } = await start({}, { sources: undefined });
    assert.equal(view().enabled, false);
    const expected = [...new Set(defaultSources().flatMap((s) => s.allowHosts))].sort();
    assert.deepEqual(view().hosts.map((h) => h.host).sort(), expected, 'the hosts of the preset, from the sources');
    assert.ok(view().hosts.find((h) => h.host === 'raw.githubusercontent.com')?.products.includes('Claude Code'));
    assert.equal(timers.pending.size, 0, 'no poll is planned');
    // Nothing a click on a stale page could start works while it is off.
    await controller.handleMessage({ type: 'radar', action: 'poll' });
    await controller.handleMessage({ type: 'radar', action: 'analyze' });
    timers.fire();
    await tick();
    assert.equal(feed.requests.length, 0, 'no request at all');
    assert.equal(existsSync(path.join(home, 'radar')), false, 'not even its folder');
    assert.equal(shell.last('radarReport')?.report, undefined);
  });

  it("reads its settings from the user's own settings only", () => {
    const values = { 'radar.enabled': true, 'radar.provider': 'openai', 'radar.model': 'gpt-6-sol', 'radar.autoAnalyze': true };
    const folderScoped = Object.assign(new MemorySettings({ ...values }), { scopeOf: () => 'workspace' as const });
    assert.deepEqual(readSettings(folderScoped).radar, { enabled: false, provider: '', model: '', autoAnalyze: false }, "a folder's settings cannot turn it on or pick its provider");
    const userScoped = Object.assign(new MemorySettings({ ...values }), { scopeOf: () => 'user' as const });
    assert.deepEqual(readSettings(userScoped).radar, { enabled: true, provider: 'openai', model: 'gpt-6-sol', autoAnalyze: true });
    // Only a real true turns it on; an agent CLI or Claude Code is never its provider.
    const odd = readSettings(new MemorySettings({ 'radar.enabled': 'true', 'radar.autoAnalyze': 1, 'radar.provider': 'claude-code', 'claudeCode.enabled': true }));
    assert.deepEqual([odd.radar.enabled, odd.radar.autoAnalyze, odd.radar.provider], [false, false, '']);
    assert.equal(readSettings(new MemorySettings({ 'radar.provider': 'agent:gemini', 'agentClis.enabled': ['gemini'] })).radar.provider, '');
    for (const key of RADAR_SETTINGS) assert.ok(USER_LEVEL_SETTINGS.has(key) && DESKTOP_SETTINGS.has(key) && WEBVIEW_SETTINGS[key], key);
  });

  it('exists only in the desktop app', async () => {
    const { shell, controller } = await start({}, {}, 'vscode');
    await controller.handleMessage({ type: 'ready' });
    for (const [key, value] of [
      ['radar.enabled', true],
      ['radar.autoAnalyze', true],
    ] as const)
      await controller.handleMessage({ type: 'setSetting', key, value });
    assert.equal(shell.settings.isSet('radar.enabled'), false);
    assert.ok(!shell.posted.some((m) => m.type === 'radar' || m.type === 'radarReport'));
  });

  it('turned on, it checks right away, then every hour; a poll makes no model call and shows what waits', async () => {
    const { shell, controller, timers, feed, view } = await start(localProvider(), { sources: [SOURCE, BROKEN] });
    await controller.handleMessage({ type: 'setSetting', key: 'radar.enabled', value: 'true' });
    assert.equal(shell.settings.isSet('radar.enabled'), false, 'only a real true turns it on');
    await controller.handleMessage({ type: 'setSetting', key: 'radar.enabled', value: true });
    await until(() => timers.pending.size === 1, 'the poll to be planned');
    assert.deepEqual(timers.fire(), [0], 'turned on by a click: right away');
    await until(() => view().pending === 1 && !view().polling, 'the pending count');
    assert.deepEqual(
      feed.requests.map((r) => r.url),
      [SOURCE.url, BROKEN.url],
    );
    for (const request of feed.requests) {
      assert.deepEqual([...request.headers.keys()].sort(), ['accept', 'user-agent'], 'nothing but the engine headers');
      assert.match(request.headers.get('user-agent') ?? '', /^OrkaRadar\/\S+ \(\+https:\/\/github\.com\//);
    }
    const v = view();
    assert.equal(v.lastPollAt, NOW().toISOString());
    assert.deepEqual(
      v.sources.map((s) => [s.id, s.host, s.lastStatus, s.lastError]),
      [
        ['agent-cli', 'github.com', 'baseline', undefined],
        ['other-ide', 'other.example', 'error', 'The server answered 404.'],
      ],
    );
    assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [3_600_000], 'the next look in an hour');
    assert.equal(model.requests.length, 0, 'never a model call while polling');
    assert.ok(existsSync(path.join(home, 'radar', 'state.json')), 'its state lives in <orka home>/radar');

    // An hour later each source keeps its own interval: nothing is due, nothing is fetched.
    timers.fire();
    await until(() => timers.pending.size === 1, 'the next poll to be planned');
    assert.equal(feed.requests.length, 2);
  });

  it('analyzes on request with its own provider, counts the calls and keeps one report', async () => {
    const { shell, view, report } = await analyzed();
    assert.equal(model.requests.length, 5, 'summarize, map, cluster, compare, decide');
    assert.deepEqual(report.stats, { entries: 1, calls: 5, inputTokens: 500, outputTokens: 50, left: 0 });
    assert.deepEqual(report.provider, { id: 'custom:local', model: 'fake-1' });
    const [cluster] = report.clusters;
    assert.deepEqual([cluster.title, cluster.vendors, cluster.decision?.decision, cluster.decision?.priority, cluster.decision?.effort, cluster.canStart], [
      'Background agents',
      ['Example'],
      'gap',
      'P2',
      'M',
      true,
    ]);
    assert.deepEqual(
      cluster.items.map((i) => [i.match, i.url]),
      [['gap', 'https://github.com/example/agent-cli/releases/tag/v1.4.0']],
    );
    // The panel saw the run: its stages, and the calls counted against the cap.
    const runs = shell.posted.flatMap((m) => (m.type === 'radar' && m.radar.analysis ? [m.radar.analysis] : []));
    assert.ok(runs.some((r) => r.stage === 'decide'));
    assert.deepEqual([Math.max(...runs.map((r) => r.calls)), runs[0].maxCalls], [5, 100]);
    assert.deepEqual([view().pending, view().analysis, view().error], [0, undefined, undefined]);
    assert.ok(model.requests.every((r) => !/\n\nLanguage: /.test(r.system)), 'English UI: English prompts');
    // Saved beside the state, and valid when read back.
    const saved = JSON.parse(readFileSync(path.join(home, 'radar', 'report.json'), 'utf8'));
    assert.ok(validateReport(saved).report);
  });

  it('writes in the UI language, and follows the main agent when nothing is chosen for it', async () => {
    const { view, report } = await analyzed({ language: 'tr', provider: 'custom:local', 'radar.provider': undefined });
    assert.deepEqual([view().model?.provider, view().model?.inherited], ['custom:local', true]);
    assert.ok(report.clusters.length);
    for (const request of model.requests) {
      if (request.stage === 'map') assert.doesNotMatch(request.system, /Language: /);
      else assert.match(request.system, /\n\nLanguage: write .+ in Turkish\./, request.stage);
    }
  });

  it('"Start a session" puts the proposal in the message box of a new session and sends nothing', async () => {
    const { shell, controller, report } = await analyzed();
    const asked = model.requests.length;
    const resetsBefore = shell.posted.filter((m) => m.type === 'event' && m.event.type === 'reset').length;
    await controller.handleMessage({ type: 'radarStartSession', cluster: 'no-such-cluster' });
    assert.equal(shell.last('setInput'), undefined);

    await controller.handleMessage({ type: 'radarStartSession', cluster: report.clusters[0].key });
    const text = shell.last('setInput')?.text ?? '';
    assert.equal(shell.last('setInput')?.append, true, 'a draft the user typed stays: the proposal goes after it');
    assert.match(text, /^Implement this feature in Orka: Background tasks$/m);
    assert.match(text, /^1\. A task can keep running while another session is open$/m);
    assert.doesNotMatch(text, /keep working in the|\/tasks|Orka runs one task at a time/, 'no release-note text, no rationale');
    const resets = shell.posted.flatMap((m, i) => (m.type === 'event' && m.event.type === 'reset' ? [i] : []));
    assert.equal(resets.length, resetsBefore + 1, 'a new session');
    assert.ok(resets.at(-1)! < shell.posted.findIndex((m) => m.type === 'setInput'), 'then the text');
    await tick();
    assert.ok(!shell.posted.some((m) => m.type === 'event' && (m.event.type === 'run_started' || m.event.type === 'user_message')), 'nothing was sent');
    assert.equal(model.requests.length, asked, 'no model call');
  });

  it('opens only https links that are in the report', async () => {
    const { shell, controller, report } = await analyzed();
    const url = report.clusters[0].items[0].url!;
    for (const bad of ['https://evil.example/collect', 'javascript:alert(1)', 'http://github.com/example/agent-cli/releases/tag/v1.4.0'])
      await controller.handleMessage({ type: 'radarOpenLink', url: bad });
    assert.deepEqual(shell.opened, []);
    await controller.handleMessage({ type: 'radarOpenLink', url });
    assert.deepEqual(shell.opened, [url]);
  });

  it('never runs on an agent CLI or Claude Code', async () => {
    const fakeAgent = path.resolve(__dirname, '..', '..', '..', 'core', 'test', 'fixtures', 'fake-acp.mjs');
    const { shell, controller, view } = await polled({
      provider: 'claude-code',
      'claudeCode.enabled': true,
      // No real Claude Code is looked for: the check fails at once.
      'claudeCode.path': path.join(home, 'no-claude.exe'),
      'agentClis.enabled': ['custom:fake'],
      'agentClis.custom': [{ name: 'Fake', command: process.execPath, args: [fakeAgent] }],
    });
    for (const value of ['claude-code', 'agent:custom:fake', 'custom:nope'])
      await controller.handleMessage({ type: 'setSetting', key: 'radar.provider', value });
    assert.equal(shell.settings.isSet('radar.provider'), false, 'the picker values are refused');
    // The main agent runs on Claude Code: Radar does not follow it there.
    assert.deepEqual([view().model, view().modelProblem], [undefined, 'Pick a provider and model for Radar.']);
    // A hand-edited settings file is not trusted either (and the local endpoint shows it would work).
    const settled = async (change: () => Promise<void>) => {
      const seen = shell.posted.length;
      await change();
      await until(() => shell.posted.slice(seen).some((m) => m.type === 'radar'), 'the next state');
    };
    await settled(() => shell.settings.update('radar.provider', 'custom:local'));
    assert.equal(view().model?.provider, 'custom:local');
    for (const value of ['claude-code', 'agent:custom:fake']) {
      await settled(() => shell.settings.update('radar.provider', value));
      assert.equal(view().model, undefined, value);
    }
    await settled(() => shell.settings.update('provider', 'agent:custom:fake'));
    assert.equal(view().model, undefined, 'nor an agent CLI as the main agent');
    await controller.handleMessage({ type: 'radar', action: 'analyze' });
    assert.equal(model.requests.length, 0);
    assert.deepEqual([view().pending, view().error], [1, 'Pick a provider and model for Radar.']);
  });

  it('turned off, it stops the timer and the poll that runs', async () => {
    const hanging = fakeFetch(true);
    const { controller, timers, view } = await start({ 'radar.enabled': true }, { fetchImpl: hanging.impl });
    timers.fire();
    await until(() => hanging.requests.length === 1 && view().polling, 'the poll to start');
    await controller.handleMessage({ type: 'setSetting', key: 'radar.enabled', value: false });
    await until(() => !view().polling, 'the poll to stop');
    assert.equal(hanging.requests[0].signal?.aborted, true, 'the request was cancelled');
    assert.equal(view().enabled, false);
    assert.equal(timers.pending.size, 0, 'nothing is planned');
    timers.fire();
    await controller.handleMessage({ type: 'radar', action: 'poll' });
    assert.equal(hanging.requests.length, 1);

    // What is waiting is not analyzed while it is off either.
    const on = await polled({ 'radar.provider': 'custom:local' });
    await on.controller.handleMessage({ type: 'setSetting', key: 'radar.enabled', value: false });
    await until(() => !on.view().enabled, 'Radar to be off');
    await on.controller.handleMessage({ type: 'radar', action: 'analyze' });
    assert.deepEqual([model.requests.length, on.view().pending], [0, 1]);
  });

  it('"Other…" sets the model of a chosen provider that has no default model', async () => {
    // No model list to load either (a list it loads would fill in its default model).
    const bare = { id: 'bare', label: 'Bare', baseUrl: 'http://127.0.0.1:9/v1', requiresKey: false };
    const { shell, controller, view } = await start({ 'radar.enabled': true, customProviders: [bare], 'radar.provider': 'custom:bare' });
    assert.deepEqual([view().model, view().modelProblem], [undefined, 'Pick a model for Bare (Settings > Providers).']);
    shell.inputAnswer = 'fake-1';
    await controller.handleMessage({ type: 'customModel', agent: 'radar' });
    assert.deepEqual(
      shell.inputs.map((i) => [i.title, i.value]),
      [['Model for Radar (Bare)', '']],
    );
    await until(() => view().model?.model === 'fake-1', 'the model');
    assert.deepEqual([shell.settings.data['radar.provider'], view().model?.provider, view().modelProblem], ['custom:bare', 'custom:bare', undefined]);

    // Following the main agent, the model picked goes with the main agent's provider.
    const main = await start({ 'radar.enabled': true, ...localProvider(), provider: 'custom:local' });
    main.shell.inputAnswer = 'fake-2';
    await main.controller.handleMessage({ type: 'customModel', agent: 'radar' });
    assert.deepEqual([main.shell.settings.data['radar.provider'], main.shell.settings.data['radar.model']], ['custom:local', 'fake-2']);
    // Never for a provider Radar cannot run on.
    const cli = await start({ 'radar.enabled': true, provider: 'claude-code', 'claudeCode.enabled': true, 'claudeCode.path': path.join(home, 'no-claude.exe') });
    cli.shell.inputAnswer = 'opus';
    await cli.controller.handleMessage({ type: 'customModel', agent: 'radar' });
    assert.deepEqual([cli.shell.inputs.length, cli.shell.settings.isSet('radar.model')], [0, false]);
  });

  it('two windows share its files: only the one with the lock polls and analyzes, the other shows its report and takes over when it quits', async () => {
    const first = await polled({ 'radar.provider': 'custom:local' });
    const second = await start({ 'radar.enabled': true, ...localProvider(), 'radar.provider': 'custom:local' });
    assert.deepEqual([first.view().elsewhere, second.view().elsewhere], [undefined, true]);
    assert.deepEqual(
      [...second.timers.pending.values()].map((t) => t.ms),
      [60_000],
      'no poll planned, only a look at what the other window writes',
    );
    assert.equal(second.view().pending, 1, 'it reads the shared queue');
    // Nothing it is asked to do touches the feeds, the model or the queue.
    for (const action of ['poll', 'analyze', 'retry'] as const) await second.controller.handleMessage({ type: 'radar', action });
    assert.deepEqual([second.feed.requests.length, model.requests.length, second.view().analysis], [0, 0, undefined]);
    const panel = radarPanelHtml(second.view(), undefined, { providers: [], modelOptions: () => '' });
    assert.match(panel, /Another Orka window runs Radar/);
    assert.doesNotMatch(panel, /data-action="radar-poll"/, 'nothing to check from here');
    assert.match(panel, /data-action="radar-analyze" disabled/);

    await first.controller.handleMessage({ type: 'radar', action: 'analyze' });
    assert.equal(model.requests.length, 5);
    assert.equal(second.shell.last('radarReport')?.report, undefined);
    second.timers.fire();
    await until(() => second.shell.last('radarReport')?.report?.clusters[0]?.title === 'Background agents', "the other window's report");
    await until(() => second.view().pending === 0, 'the shared queue');

    // The first window quits: the second one takes over on its next look and checks the feeds then.
    await first.controller.dispose();
    controllers = controllers.filter((c) => c !== first.controller);
    assert.equal(existsSync(path.join(home, 'radar', 'lock')), false, 'the lock went with it');
    second.timers.fire();
    await until(() => second.view().elsewhere === undefined && second.timers.pending.size === 1, 'the take-over');
    assert.deepEqual(
      [...second.timers.pending.values()].map((t) => t.ms),
      [0],
    );
  });

  it('takes over a lock left behind, respects a live one, and gives its own up when turned off', async () => {
    const lock = path.join(home, 'radar', 'lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    const other = (holder: object) => JSON.stringify({ token: 'other-window', ...holder });
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (const [content, why, old] of [
      [other({ pid: gone, at: new Date().toISOString() }), 'its process is gone', false],
      [other({ pid: process.pid, at: '2026-01-01T00:00:00.000Z' }), 'nobody refreshed it for hours (the pid may be another program now)', false],
      ['', 'its writer stopped before filling it, a while ago', true],
    ] as const) {
      writeFileSync(lock, content);
      if (old) utimesSync(lock, hourAgo, hourAgo);
      const taken = await start({ 'radar.enabled': true });
      assert.equal(taken.view().elsewhere, undefined, why);
      assert.deepEqual([...taken.timers.pending.values()].map((t) => t.ms), [30_000], why);
      assert.doesNotMatch(readFileSync(lock, 'utf8'), /other-window/, why);
      await taken.controller.dispose();
      controllers = controllers.filter((c) => c !== taken.controller);
      assert.equal(existsSync(lock), false, 'given up when the app quits');
    }

    for (const content of [other({ pid: process.pid, at: new Date().toISOString() }), '']) {
      writeFileSync(lock, content);
      const follower = await start({ 'radar.enabled': true });
      assert.equal(follower.view().elsewhere, true, content || 'a lock being written right now');
      // Turning it off here leaves the other window's lock alone.
      await follower.controller.handleMessage({ type: 'setSetting', key: 'radar.enabled', value: false });
      await until(() => !follower.view().enabled, 'Radar to be off');
      assert.equal(follower.view().elsewhere, undefined);
      assert.equal(readFileSync(lock, 'utf8'), content);
    }

    rmSync(lock);
    const owner = await start({ 'radar.enabled': true });
    assert.ok(existsSync(lock));
    await owner.controller.handleMessage({ type: 'setSetting', key: 'radar.enabled', value: false });
    await until(() => !existsSync(lock), 'the lock to go');
  });

  it('saves its report on top of one another window wrote meanwhile, never over it', async () => {
    const first = await analyzed();
    const file = path.join(home, 'radar', 'report.json');
    const ours = first.report.clusters.map((c) => c.key);
    // Another window's report on another feature.
    const theirs = JSON.parse(readFileSync(file, 'utf8'));
    const item = { ...theirs.items[0], id: 'ffffffffffffffff-1', title: 'Plan mode' };
    const { key: _key, decision: _decision, comparison: _comparison, ...cluster } = theirs.clusters[0];
    Object.assign(theirs, { items: [item], clusters: [{ ...cluster, key: 'plan-mode', title: 'Plan mode', itemIds: [item.id] }] });
    assert.ok(validateReport(theirs).report, 'a valid report');
    await first.controller.dispose();
    controllers = controllers.filter((c) => c !== first.controller);

    // This window starts with the report above; the queue starts over, so the entry is new again.
    rmSync(path.join(home, 'radar', 'state.json'));
    const second = await polled({ 'radar.provider': 'custom:local' });
    writeFileSync(file, JSON.stringify(theirs));
    await second.controller.handleMessage({ type: 'radar', action: 'analyze' });
    const saved = validateReport(JSON.parse(readFileSync(file, 'utf8'))).report;
    assert.deepEqual(saved?.clusters.map((c) => c.key).sort(), [...ours, 'plan-mode'].sort());
    assert.deepEqual(second.shell.last('radarReport')?.report?.clusters.map((c) => c.key).sort(), [...ours, 'plan-mode'].sort());
  });

  it('sets a corrupt report aside and never uses it; a valid one is read back', async () => {
    // A valid report from an earlier run is shown again after a restart.
    const first = await analyzed();
    await first.controller.dispose();
    controllers = controllers.filter((c) => c !== first.controller);
    const again = await start({ 'radar.enabled': true });
    assert.equal(again.shell.last('radarReport')?.report?.clusters[0].title, 'Background agents');

    const file = path.join(home, 'radar', 'report.json');
    const tampered = JSON.parse(readFileSync(file, 'utf8'));
    tampered.items[0].url = 'javascript:alert(1)';
    tampered.clusters[0].title = '<img src=x onerror=alert(1)>';
    for (const content of [JSON.stringify(tampered), '{"schema":1,', 'null']) {
      writeFileSync(file, content);
      const { shell, view } = await start({ 'radar.enabled': true });
      assert.equal(shell.last('radarReport')?.report, undefined, content.slice(0, 20));
      assert.match(view().error ?? '', /could not be read and was set aside \(report\.broken-\d+\.json\)/);
      assert.equal(existsSync(file), false, 'moved aside');
    }
    assert.ok(readdirSync(path.join(home, 'radar')).filter((f) => f.startsWith('report.broken-')).length >= 1);
  });

  it('leaves a report it cannot read right now where it is, and keeps the queue when the report cannot be written', async () => {
    // A folder where report.json belongs: reading and replacing it fail, like a file another program holds.
    const file = path.join(home, 'radar', 'report.json');
    mkdirSync(file, { recursive: true });
    const started = await start({ 'radar.enabled': true, ...localProvider(), 'radar.provider': 'custom:local' });
    assert.match(started.view().error ?? '', /could not be read right now/);
    assert.equal(readdirSync(path.join(home, 'radar')).filter((f) => f.startsWith('report.broken-')).length, 0, 'not set aside');
    assert.ok(existsSync(file));

    assert.deepEqual(started.timers.fire(), [30_000]);
    await until(() => started.view().pending === 1 && !started.view().polling, 'the poll');
    await started.controller.handleMessage({ type: 'radar', action: 'analyze' });
    assert.ok(started.view().error, 'the failed save is shown');
    assert.equal(started.view().pending, 1, 'the entry waits for the next analysis');
    assert.equal(started.shell.last('radarReport')?.report, undefined, 'no report that was never saved');
    assert.deepEqual(readdirSync(path.join(home, 'radar')).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
    assert.doesNotThrow(() => readdirSync(file), 'a report that cannot be read is never written over');
  });
});

describe('Radar panel', () => {
  const providers: ProviderView[] = [
    { kind: 'claude', label: 'Claude API', local: false, ready: true, models: [], model: 'claude-opus-5-5' },
    { kind: 'claude-code', label: 'Claude Code (local)', local: true, ready: true, models: [], model: 'opus' },
    { kind: 'agent:gemini', label: 'Gemini CLI', local: true, ready: true, models: [], model: '', agent: true },
    { kind: 'custom:local', label: 'Local', local: true, ready: true, models: [], model: 'fake-1', custom: { id: 'local', baseUrl: 'http://127.0.0.1:1/v1', requiresKey: false } },
  ];
  const deps = { providers, modelOptions: () => '<option value="x">x</option>' };
  const view = (patch: Partial<RadarView> = {}): RadarView => ({
    enabled: true,
    autoAnalyze: false,
    hosts: [{ host: 'github.com', products: ['Agent CLI'] }],
    sources: [],
    sourceErrors: [],
    polling: false,
    pending: 2,
    quarantined: 0,
    choice: { provider: '', model: '' },
    maxCalls: 100,
    ...patch,
  });

  it('lists the hosts while off, and offers only model providers', () => {
    const off = radarPanelHtml(view({ enabled: false }), undefined, deps);
    assert.match(off, /data-action="radar-switch" data-on="true"/);
    assert.match(off, /<code>github\.com<\/code>/);
    assert.doesNotMatch(off, /radar-analyze/);
    assert.ok(radarSettingsCard(view({ enabled: false }), true).split(/[\s,<>]+/).some((word) => word.replace(/\.$/, '') === 'github.com'), 'the settings card names them too');

    const on = radarPanelHtml(view({ model: { provider: 'claude', model: 'claude-opus-5-5', label: 'Claude API', inherited: true } }), undefined, deps);
    const options = [...on.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(options.filter((o) => o !== 'x'), ['', 'claude', 'custom:local'], 'no agent CLI, no Claude Code');
    assert.match(on, /data-action="radar-analyze">/, 'Analyze is offered');
  });

  it('escapes everything the report holds and links only https pages', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const report: RadarReportView = {
      generatedAt: '2026-10-30T00:00:00.000Z',
      provider: { id: 'custom:local', model: evil },
      clusters: [
        {
          key: 'background-agents',
          title: evil,
          vendors: [evil],
          tags: ['agents'],
          items: [
            { id: 'a-1', vendor: evil, product: evil, title: evil, summary: evil, kind: 'feature', relevance: 3, match: 'gap', url: 'javascript:alert(1)' },
            { id: 'a-2', vendor: 'Example', product: 'CLI', title: 'Real', summary: 'ok', kind: 'feature', relevance: 3, match: 'have', url: 'https://github.com/x"onmouseover="alert(1)' },
          ],
          comparison: { approaches: [{ vendor: evil, approach: evil }], assessment: evil, confidence: 'low', basis: 'public release notes only' },
          decision: {
            clusterKey: 'background-agents',
            decision: 'gap',
            priority: 'P1',
            effort: 'S',
            fitsPrinciples: true,
            rationale: evil,
            decidedBy: 'model',
            proposal: { title: evil, problem: evil, acceptanceCriteria: [evil], areas: ['agents'] },
          },
          canStart: true,
        },
      ],
      others: [],
      needsHuman: 0,
      stats: { entries: 1, calls: 5, inputTokens: 1, outputTokens: 1, left: 0 },
    };
    const html = radarPanelHtml(view({ error: evil }), report, deps);
    assert.ok(!html.includes('<img'), 'every value is escaped');
    assert.doesNotMatch(html, /javascript:/, 'a non-https link is not a link');
    assert.ok(html.includes('data-url="https://github.com/x&quot;onmouseover=&quot;alert(1)"'), 'attributes are escaped');
    assert.doesNotMatch(html, /\sstyle=/, 'no inline styles (the CSP blocks them)');
    assert.match(html, /data-action="radar-start" data-cluster="background-agents"/);
  });

  it('says the pending count in the names screen readers read, not on the badge alone', () => {
    const badge = radarBadge(view({ pending: 4 }));
    assert.match(badge, /^<span class="radar-badge" aria-hidden="true">4<\/span>$/, 'the badge is only seen');
    for (const where of ['rail', 'list'] as const) {
      assert.match(radarEntryHtml(where, view({ pending: 4 })), /aria-label="Radar: what other AI coding tools shipped \(4 new entries\)"/, where);
      assert.match(radarEntryHtml(where, view({ pending: 0 })), /aria-label="Radar: what other AI coding tools shipped"/, where);
    }
    assert.equal(radarLabel('Show the side panel', view({ pending: 1 })), 'Show the side panel (1 new entry)');
    assert.equal(radarLabel('Show the side panel', undefined), 'Show the side panel');
  });

  it('tells, before Radar is turned on, that automatic analysis is on when it is', () => {
    const clickOnly = radarPanelHtml(view({ enabled: false }), undefined, deps);
    assert.match(clickOnly, /An analysis runs only when you click Analyze/);
    assert.doesNotMatch(clickOnly, /radar\.autoAnalyze/);
    const auto = radarPanelHtml(view({ enabled: false, autoAnalyze: true }), undefined, deps);
    assert.doesNotMatch(auto, /only when you click Analyze/);
    assert.match(auto, /Automatic analysis is on: when a check finds something, Radar analyzes it right away on your own provider and API key\./);
    assert.match(auto, /at most 100 model calls a run\./);
    assert.match(auto, /<input type="checkbox" data-setting="radar\.autoAnalyze" checked>/, 'and it can be turned off before Radar is turned on');
    assert.match(radarSettingsCard(view({ enabled: false, autoAnalyze: true }), true), /data-setting="radar\.autoAnalyze" checked>/, 'in Settings too');
    assert.match(radarSettingsCard(view({ enabled: false }), true), /data-setting="radar\.autoAnalyze" disabled>/);
  });

  it('keeps its settings card the same while a check or an analysis runs (Settings > Control is not rebuilt for it)', () => {
    const idle = radarSettingsCard(view({ pending: 0 }), true);
    const busy = radarSettingsCard(view({ pending: 9, polling: true, lastPollAt: '2026-10-30T00:00:00.000Z', error: 'x', analysis: { stage: 'map', done: 3, total: 9, calls: 12, maxCalls: 100 } }), true);
    assert.equal(busy, idle);
    assert.notEqual(radarSettingsCard(view({ autoAnalyze: true }), true), idle);
  });

  it('reads naturally in Turkish', () => {
    setLocale('tr');
    try {
      const report: RadarReportView = {
        generatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        provider: { id: 'claude', model: 'claude-opus-5-5' },
        clusters: [
          {
            key: 'background-agents',
            title: 'Arka plan agentları',
            vendors: ['OpenAI'],
            tags: ['agents'],
            items: [],
            decision: { clusterKey: 'background-agents', decision: 'gap', priority: 'P1', effort: 'M', fitsPrinciples: true, rationale: '', decidedBy: 'model' },
            canStart: false,
          },
        ],
        others: [],
        needsHuman: 0,
        stats: { entries: 1, calls: 5, inputTokens: 1, outputTokens: 1, left: 0 },
      };
      const html = radarPanelHtml(view(), report, deps);
      const off = /data-action="radar-switch" data-on="false">([^<]*)</.exec(html)?.[1];
      assert.equal(off, 'Radar&#39;ı kapat');
      assert.notEqual(off, TR.Close, 'not the word for closing the panel');
      assert.match(html, /<span class="muted small">2 sa önce güncellendi · claude \/ claude-opus-5-5 · 5 çağrı<\/span>/);
      assert.match(html, /<div class="radar-verdict" data-verdict="gap">Orka&#39;da eksik · öncelik P1, boyut M<\/div>/);
      assert.match(radarPanelHtml(view({ enabled: false }), undefined, deps), /API anahtarınızla/);
    } finally {
      setLocale('en');
    }
  });
});

describe('message box', () => {
  it('keeps what the user typed and adds a proposal after it, once', () => {
    const proposal = 'Implement this feature in Orka: Background tasks\n\n1. A task keeps running';
    assert.equal(appendToDraft('', proposal), proposal);
    assert.equal(appendToDraft('  \n', proposal), proposal);
    assert.equal(appendToDraft('Fix the lobby jitter first.\n', proposal), `Fix the lobby jitter first.\n\n${proposal}`);
    assert.equal(appendToDraft(`Fix the lobby jitter first.\n\n${proposal}`, proposal), `Fix the lobby jitter first.\n\n${proposal}`, 'a second click adds nothing');
  });
});
