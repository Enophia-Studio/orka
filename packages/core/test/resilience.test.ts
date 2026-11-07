import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SUBAGENTS } from '../src/agents/subagents';
import { NodeHost } from '../src/host/NodeHost';
import { setLocale } from '../src/i18n';
import type { AgentEvent, WaitStatus } from '../src/orchestrator/events';
import { Orchestrator, type OrchestratorSettings } from '../src/orchestrator/Orchestrator';
import { PermissionManager, type PermissionMode } from '../src/permissions/PermissionManager';
import {
  AbortedError,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  isConnectionError,
  ProviderError,
  type ProviderStreamEvent,
  retryAfterFrom,
} from '../src/providers/AIProvider';
import { ClaudeCodeProvider, classifyError } from '../src/providers/ClaudeCodeProvider';
import { geminiRetryDelay } from '../src/providers/GeminiProvider';
import { chatWithRetry, DEFAULT_RETRY_TIMING, isTransient, retryDelay } from '../src/providers/retry';
import type { AssistantMessage } from '../src/types';
import { applyEvent, emptySession } from '../src/ui/transcript';
import { clockTime, toolLabel, waitLabel } from '../src/ui/waitStatus';
import { call, lastToolResults, ScriptedProvider, tempWorkspace, text } from './helpers';

const FAST = { baseMs: 5, capMs: 20, maxWaitMs: 1_000 };
const SETTINGS: OrchestratorSettings = { maxIterations: 20, autoVerify: false, commandTimeoutMs: 30_000, maxRetries: 2, retryTiming: FAST };

type Step = (request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void) => AssistantMessage['content'] | Promise<AssistantMessage['content']>;

/** A provider whose steps may stream and then throw (a stream cut mid-answer, a 529, a 429). */
class FlakyProvider implements AIProvider {
  readonly id = 'flaky';
  readonly label = 'Flaky';
  readonly model = 'flaky-1';
  readonly requests: ChatRequest[] = [];
  private index = 0;
  constructor(private readonly steps: Step[]) {}

  async chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse> {
    this.requests.push(request);
    const step = this.steps[this.index++];
    if (!step) throw new Error(`FlakyProvider ran out of steps at request ${this.index}`);
    const content = await step(request, onEvent);
    for (const block of content) if (block.type === 'text') onEvent({ type: 'text_delta', text: block.text });
    return {
      message: { role: 'assistant', content },
      stopReason: content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: this.model,
    };
  }
}

const cut = (shown: string): Step => (_req, onEvent) => {
  onEvent({ type: 'text_delta', text: shown });
  throw new ProviderError('The connection to the API broke off: terminated', 'network');
};

describe('retries: which failures, how long', () => {
  it('retries what may pass and fails fast on the rest', () => {
    assert.equal(isTransient(new ProviderError('reset', 'network')), true);
    assert.equal(isTransient(new ProviderError('529 overloaded', 'server', 529)), true);
    assert.equal(isTransient(new ProviderError('429', 'rate_limit', 429)), true);
    assert.equal(isTransient(new ProviderError('429 later', 'rate_limit', 429, undefined, { retryAfterMs: 10 * 60_000 })), false, 'a wait past the limit is not waited for');
    assert.equal(isTransient(new ProviderError('Claude Code: usage limit reached', 'rate_limit')), false, 'a usage limit without a status');
    assert.equal(isTransient(new ProviderError('bad key', 'auth', 401)), false);
    assert.equal(isTransient(new ProviderError('bad request', 'bad_request', 400)), false);
    assert.equal(isTransient(new ProviderError('exited', 'other', undefined, undefined, { transient: true })), true);
    assert.equal(isTransient(new ProviderError('stopped', 'aborted')), false);
    assert.equal(isTransient(new AbortedError()), false);
    assert.equal(isTransient(new Error('plain')), false);
  });

  it('honours Retry-After and otherwise backs off exponentially with jitter, capped', () => {
    const after = new ProviderError('429', 'rate_limit', 429, undefined, { retryAfterMs: 7_000 });
    assert.equal(retryDelay(0, after, DEFAULT_RETRY_TIMING, () => 0), 7_000);
    assert.equal(retryDelay(3, after, DEFAULT_RETRY_TIMING, () => 1), 7_250);
    const server = new ProviderError('500', 'server', 500);
    const timing = { baseMs: 1_000, capMs: 8_000, maxWaitMs: 60_000 };
    assert.equal(retryDelay(0, server, timing, () => 0), 500);
    assert.equal(retryDelay(0, server, timing, () => 1), 1_000);
    assert.equal(retryDelay(2, server, timing, () => 0), 2_000);
    assert.equal(retryDelay(10, server, timing, () => 1), 8_000, 'capped');
    for (let i = 0; i < 50; i++) {
      const d = retryDelay(1, server, timing);
      assert.ok(d >= 1_000 && d <= 2_000, `jitter stays in [half, full]: ${d}`);
    }
  });

  it('reads Retry-After in seconds, as a date, and retry-after-ms', () => {
    const headers = (h: Record<string, string>) => new Headers(h);
    assert.equal(retryAfterFrom(headers({ 'retry-after': '12' })), 12_000);
    assert.equal(retryAfterFrom(headers({ 'retry-after-ms': '1500', 'retry-after': '9' })), 1_500);
    const now = Date.parse('2026-11-07T10:00:00Z');
    assert.equal(retryAfterFrom(headers({ 'retry-after': 'Sat, 07 Nov 2026 10:00:30 GMT' }), now), 30_000);
    assert.equal(retryAfterFrom({ 'retry-after': '3' }), 3_000);
    assert.equal(retryAfterFrom(headers({ 'retry-after': 'soon' })), undefined);
    assert.equal(retryAfterFrom(undefined), undefined);
    assert.equal(geminiRetryDelay('{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"21s"}]}}'), 21_000);
    assert.equal(geminiRetryDelay('quota exceeded'), undefined);
  });

  it('tells a cut connection from an answer, and sorts Claude Code errors', () => {
    assert.equal(isConnectionError(new TypeError('terminated')), true);
    assert.equal(isConnectionError(Object.assign(new Error('read'), { code: 'ECONNRESET' })), true);
    assert.equal(isConnectionError(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }) })), true);
    assert.equal(isConnectionError(new Error('Invalid JSON in tool input')), false);
    assert.equal(classifyError('API Error: 529 {"type":"overloaded_error"}'), 'server');
    assert.equal(classifyError('API Error: Connection error.'), 'network');
    assert.equal(classifyError('Claude AI usage limit reached|1767000000'), 'rate_limit');
    assert.equal(classifyError('Invalid API key · Please run /login'), 'auth');
  });

  it('chatWithRetry: the provider tries once per call, and the waits are announced and cancellable', async () => {
    const flaky = new FlakyProvider([cut('a'), cut('b'), () => [text('done')]]);
    const retries: number[] = [];
    let resumed = 0;
    const response = await chatWithRetry(flaky, { system: '', messages: [], tools: [] }, () => {}, {
      maxRetries: 3,
      timing: FAST,
      onRetry: (info) => retries.push(info.attempt),
      onResume: () => resumed++,
    });
    assert.equal(response.message.content[0].type, 'text');
    assert.deepEqual(retries, [1, 2]);
    assert.equal(resumed, 2);
    assert.ok(flaky.requests.every((r) => r.selfRetry === true), 'the SDK does not retry out of sight');

    // Not transient: one attempt only.
    const auth = new FlakyProvider([() => Promise.reject(new ProviderError('bad key', 'auth', 401))]);
    await assert.rejects(chatWithRetry(auth, { system: '', messages: [], tools: [] }, () => {}, { maxRetries: 3, timing: FAST }), /bad key/);
    assert.equal(auth.requests.length, 1);

    // Stop during a long wait ends it at once.
    const abort = new AbortController();
    const slow = new FlakyProvider([cut('x')]);
    const started = Date.now();
    const pending = chatWithRetry(slow, { system: '', messages: [], tools: [], signal: abort.signal }, () => {}, {
      maxRetries: 3,
      timing: { baseMs: 60_000, capMs: 60_000, maxWaitMs: 60_000 },
      onRetry: () => setTimeout(() => abort.abort(), 20),
    });
    await assert.rejects(pending, (e: Error) => e.name === 'AbortedError');
    assert.ok(Date.now() - started < 5_000);
  });
});

describe('Orchestrator: retries, wait reasons and stopping one tool', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  afterEach(() => ws?.cleanup());
  beforeEach(() => {
    ws = tempWorkspace();
    setLocale('en');
  });

  function setup(provider: AIProvider, options: { mode?: PermissionMode; settings?: OrchestratorSettings; fallback?: AIProvider; approve?: () => Promise<{ approved: boolean }> } = {}) {
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: options.approve ?? (async () => ({ approved: true })) }),
      getProvider: () => provider,
      getFallbackProvider: options.fallback ? () => options.fallback : undefined,
      permissions: new PermissionManager(options.mode ?? 'autonomous'),
      getSettings: () => options.settings ?? SETTINGS,
    });
    const events: AgentEvent[] = [];
    const session = emptySession();
    orchestrator.on((e) => {
      events.push(e);
      applyEvent(session, e);
    });
    const waits = () => events.filter((e): e is Extract<AgentEvent, { type: 'wait' }> => e.type === 'wait').map((e) => e.wait);
    return { orchestrator, events, session, waits };
  }

  it('a stream cut mid-answer is tried again: the shown text is replaced, not doubled, and the tool runs once', async () => {
    const flaky = new FlakyProvider([
      cut('I will list the fi'),
      () => [text('I will list the files.'), call('list_directory', { path: '.' })],
      (req) => {
        assert.equal(lastToolResults(req).length, 1);
        return [text('Done.')];
      },
    ]);
    const { orchestrator, events, session, waits } = setup(flaky);
    assert.equal(await orchestrator.run('list the files'), 'completed');
    assert.equal(flaky.requests.length, 3);
    assert.equal(events.filter((e) => e.type === 'assistant_retry').length, 1);
    const answers = session.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''));
    assert.deepEqual(answers, ['I will list the files.', 'Done.'], 'the cut-off text is gone');
    assert.equal(session.items.filter((i) => i.kind === 'tool').length, 1, 'the tool ran once');
    // History: user, assistant (tool call), tool result, assistant.
    assert.equal(orchestrator.history.filter((m) => m.role === 'assistant').length, 2);
    const retrying = waits().find((w) => w?.reason === 'retrying');
    assert.ok(retrying && retrying.reason === 'retrying' && retrying.attempt === 1 && retrying.max === 2, JSON.stringify(waits()));
    assert.equal(waits().at(-1), undefined, 'nothing is waited for once the run ends');
    assert.equal(session.wait, undefined);
  });

  it('a 429 with Retry-After shows "rate limited until", and a non-transient error fails at once', async () => {
    const limited = new FlakyProvider([
      () => Promise.reject(new ProviderError('rate limit', 'rate_limit', 429, undefined, { retryAfterMs: 30 })),
      () => [text('ok')],
    ]);
    const first = setup(limited);
    assert.equal(await first.orchestrator.run('hi'), 'completed');
    const wait = first.waits().find((w) => w?.reason === 'rate_limited');
    assert.ok(wait && wait.reason === 'rate_limited' && wait.until >= Date.now() - 5_000);

    const auth = new FlakyProvider([() => Promise.reject(new ProviderError('Claude rejected the API key (401).', 'auth', 401))]);
    const second = setup(auth);
    assert.equal(await second.orchestrator.run('hi'), 'error');
    assert.equal(auth.requests.length, 1, 'no retry');
    const notice = second.events.find((e) => e.type === 'notice' && e.level === 'error');
    assert.ok(notice && notice.type === 'notice' && !/continue/.test(notice.message), 'an auth error is not offered as resumable');
  });

  it('after the last retry the error says the conversation is intact; a long rate limit goes straight to the fallback', async () => {
    const down = new FlakyProvider([cut('a'), cut('b'), cut('c')]);
    const { orchestrator, events } = setup(down);
    assert.equal(await orchestrator.run('hi'), 'error');
    assert.equal(down.requests.length, 3, 'one try and two retries');
    const notice = events.find((e) => e.type === 'notice' && e.level === 'error');
    assert.ok(notice && notice.type === 'notice' && /send "continue" to try again/.test(notice.message), JSON.stringify(notice));

    const limited = new FlakyProvider([() => Promise.reject(new ProviderError('limit', 'rate_limit', 429, undefined, { retryAfterMs: 3_600_000 }))]);
    const fallback = new ScriptedProvider([() => [text('from the fallback')]]);
    const second = setup(limited, { fallback });
    assert.equal(await second.orchestrator.run('hi'), 'completed');
    assert.equal(limited.requests.length, 1, 'an hour is not waited for');
    assert.equal(fallback.requests.length, 1);
  });

  it('Stop during a retry wait ends the run at once', async () => {
    const down = new FlakyProvider([cut('a')]);
    const { orchestrator, events } = setup(down, { settings: { ...SETTINGS, retryTiming: { baseMs: 60_000, capMs: 60_000, maxWaitMs: 60_000 } } });
    orchestrator.on((e) => {
      if (e.type === 'wait' && e.wait?.reason === 'retrying') setTimeout(() => orchestrator.stop(), 10);
    });
    const started = Date.now();
    assert.equal(await orchestrator.run('hi'), 'stopped');
    assert.ok(Date.now() - started < 5_000);
    assert.ok(!events.some((e) => e.type === 'notice' && e.level === 'error'));
  });

  it('maxRetries 0 never retries', async () => {
    const down = new FlakyProvider([cut('a')]);
    const { orchestrator } = setup(down, { settings: { ...SETTINGS, maxRetries: 0 } });
    assert.equal(await orchestrator.run('hi'), 'error');
    assert.equal(down.requests.length, 1);
  });

  it('the wait follows the request: thinking, approval, the tool, thinking again, nothing at the end', async () => {
    const provider = new ScriptedProvider([() => [call('run_command', { command: 'node -e "console.log(1)"' })], () => [text('ok')]]);
    const { orchestrator, waits } = setup(provider, { mode: 'ask' });
    assert.equal(await orchestrator.run('run it'), 'completed');
    const reasons = waits().map((w) => w?.reason ?? 'none');
    const seq = reasons.filter((r, i) => r !== reasons[i - 1]);
    assert.deepEqual(seq, ['thinking', 'approval', 'tool', 'thinking', 'none'], reasons.join(','));
    const tool = waits().find((w) => w?.reason === 'tool');
    assert.ok(tool && tool.reason === 'tool' && tool.tool === 'run_command');
  });

  it('a sub-agent run shows as waiting for that sub-agent, and compaction as compacting', async () => {
    const explore = new ScriptedProvider([() => [text('report')]]);
    const main = new ScriptedProvider([() => [call('run_subagent', { agent: 'explore', task: 'look around' })], () => [text('done')], () => [text('the handoff note')]]);
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root, approve: async () => ({ approved: true }) }),
      getProvider: () => main,
      permissions: new PermissionManager('autonomous'),
      getSettings: () => SETTINGS,
      subagents: { getProfiles: () => DEFAULT_SUBAGENTS, getProvider: () => explore },
    });
    const waits: Array<WaitStatus | undefined> = [];
    orchestrator.on((e) => {
      if (e.type === 'wait') waits.push(e.wait);
    });
    assert.equal(await orchestrator.run('explore'), 'completed');
    assert.ok(waits.some((w) => w?.reason === 'subagent' && w.agent === 'explore'), JSON.stringify(waits));
    assert.equal(await orchestrator.compact(), true);
    assert.ok(waits.some((w) => w?.reason === 'compacting'));
    assert.equal(waits.at(-1), undefined);
  });

  it('a running command can be stopped from its card: the agent hears it and the request goes on', async () => {
    let toolId = '';
    const provider = new ScriptedProvider([
      () => [call('run_command', { command: 'node -e "setTimeout(() => {}, 20000)"' }), call('list_directory', { path: '.' })],
      (req) => {
        const [stopped, listed] = lastToolResults(req);
        assert.match(stopped.content, /^Cancelled by the user/);
        assert.equal(stopped.isError, true);
        assert.doesNotMatch(listed.content, /Cancelled/, 'the next call of the same turn still runs');
        return [text('I will go another way.')];
      },
    ]);
    const { orchestrator, events, session } = setup(provider);
    orchestrator.on((e) => {
      if (e.type === 'tool_call' && e.call.name === 'run_command' && e.call.status === 'running' && e.call.cancellable && !toolId) {
        toolId = e.call.id;
        setTimeout(() => assert.equal(orchestrator.cancelTool(toolId), true), 200);
      }
    });
    const started = Date.now();
    assert.equal(await orchestrator.run('run the long thing'), 'completed');
    assert.ok(Date.now() - started < 15_000, 'the command did not run to its end');
    const card = session.items.find((i) => i.kind === 'tool' && i.id === toolId);
    assert.ok(card && card.kind === 'tool' && card.call.status === 'cancelled' && !card.call.cancellable);
    assert.equal(orchestrator.cancelTool(toolId), false, 'a finished call cannot be stopped');
    assert.ok(!events.some((e) => e.type === 'run_finished' && e.reason === 'stopped'));
  });

  it('file writes cannot be stopped halfway; other calls offer Stop', async () => {
    const provider = new ScriptedProvider([() => [call('write_file', { path: 'a.txt', content: 'x' }), call('list_directory', { path: '.' })], () => [text('ok')]]);
    const { orchestrator, events } = setup(provider);
    await orchestrator.run('write');
    const running = events.filter((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call' && e.call.status === 'running');
    assert.equal(running.find((e) => e.call.name === 'write_file')?.call.cancellable, undefined);
    assert.equal(running.find((e) => e.call.name === 'list_directory')?.call.cancellable, true);
  });

  it('Claude Code that exits mid-answer is started again and the turn redone; the start shows as a wait', async () => {
    process.env.FAKE_CC_SCRIPT = JSON.stringify(['__CRASH_ONCE__:The whole answer.']);
    process.env.FAKE_CC_CRASHED = path.join(ws.root, 'crashed');
    delete process.env.FAKE_CC_LOG;
    delete process.env.FAKE_CC_HOLD;
    const provider = new ClaudeCodeProvider({ executable: process.execPath, executableArgs: [path.resolve(__dirname, '../../test/fixtures/fake-claude.mjs')] });
    try {
      const { orchestrator, session, waits, events } = setup(provider);
      assert.equal(await orchestrator.run('answer'), 'completed');
      const answers = session.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''));
      assert.deepEqual(answers, ['The whole answer.']);
      assert.ok(events.some((e) => e.type === 'assistant_retry'));
      assert.ok(waits().some((w) => w?.reason === 'starting' && w.agent === 'Claude Code'), JSON.stringify(waits()));
      assert.ok(waits().some((w) => w?.reason === 'retrying'));
    } finally {
      provider.dispose();
      delete process.env.FAKE_CC_SCRIPT;
      delete process.env.FAKE_CC_CRASHED;
    }
  });
});

describe('wait labels', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('en'));

  it('say why the session waits, with a countdown and a clock time', () => {
    const now = Date.parse('2026-11-07T10:00:00');
    assert.equal(waitLabel({ reason: 'starting', agent: 'Claude Code' }), 'Starting Claude Code');
    assert.equal(waitLabel({ reason: 'starting' }), 'Starting the CLI');
    assert.equal(waitLabel({ reason: 'tool', tool: 'run_command' }), 'Running run_command');
    assert.equal(waitLabel({ reason: 'tool', tool: 'mcp__unity__run_tests' }), 'Running unity · run_tests');
    assert.equal(waitLabel({ reason: 'approval' }), 'Waiting for your approval');
    assert.equal(waitLabel({ reason: 'retrying', until: now + 4_200, attempt: 1, max: 3 }, now), 'Retrying in 5s (attempt 1/3)');
    assert.equal(waitLabel({ reason: 'rate_limited', until: Date.parse('2026-11-07T14:32:00'), attempt: 2, max: 3 }, now), 'Rate limited until 14:32 (attempt 2/3)');
    assert.equal(waitLabel({ reason: 'compacting' }), 'Compacting the conversation');
    assert.equal(waitLabel({ reason: 'subagent', agent: 'explore' }), 'Waiting for the explore sub-agent');
    assert.equal(toolLabel('read_file'), 'read_file');
    assert.equal(clockTime(Date.parse('2026-11-07T09:05:00')), '09:05');
    setLocale('tr');
    assert.equal(waitLabel({ reason: 'approval' }), 'Onayın bekleniyor');
    assert.equal(waitLabel({ reason: 'retrying', until: now + 2_000, attempt: 1, max: 3 }, now), '2 sn sonra yeniden deneniyor (deneme 1/3)');
  });
});
