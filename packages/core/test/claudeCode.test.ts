import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ProviderError, type ProviderStreamEvent } from '../src/providers/AIProvider';
import { ClaudeCodeProvider, contextWindowOf } from '../src/providers/ClaudeCodeProvider';
import { defaultTools, toSpec } from '../src/tools';
import type { ChatMessage } from '../src/types';
import { tempWorkspace } from './helpers';

const FAKE_CLI = path.resolve(__dirname, '../../test/fixtures/fake-claude.mjs');
const tools = defaultTools().map(toSpec);

describe('ClaudeCodeProvider (fake CLI speaking the stream-json protocol)', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let logFile: string;
  let provider: ClaudeCodeProvider;

  function setup(replies: string[], model?: string) {
    process.env.FAKE_CC_SCRIPT = JSON.stringify(replies);
    process.env.FAKE_CC_LOG = logFile;
    provider = new ClaudeCodeProvider({ executable: process.execPath, executableArgs: [FAKE_CLI], model });
  }

  function received(): Array<{ pid: number; turn: number; text: string; argv: string[] }> {
    return existsSync(logFile)
      ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  }

  beforeEach(() => {
    ws = tempWorkspace();
    logFile = path.join(ws.root, 'cli-log.jsonl');
  });
  afterEach(() => {
    provider?.dispose();
    ws.cleanup();
  });

  it('turns protocol text into tool calls and keeps one process per conversation', async () => {
    setup([
      'Let me read it.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">src/a.ts</parameter>\n</invoke>\n</function_calls>',
      'The file exports q.',
    ], 'haiku');
    const events: ProviderStreamEvent[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'What does src/a.ts export?' }] }];

    const first = await provider.chat({ system: 'SYS', messages, tools }, (e) => events.push(e));
    assert.equal(first.stopReason, 'tool_use');
    assert.equal(first.model, 'claude-fake-1');
    assert.deepEqual(first.usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 5 });
    // The context window comes from the result's modelUsage.
    assert.equal(first.contextWindow, 200000);
    const call = first.message.content.find((b) => b.type === 'tool_call');
    assert.deepEqual(call && call.type === 'tool_call' && [call.name, call.input], ['read_file', { path: 'src/a.ts' }]);
    const streamed = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    assert.equal(streamed, 'Let me read it.\n', 'tool XML never reaches the UI stream');
    assert.ok(events.some((e) => e.type === 'reasoning_delta'));

    messages.push(first.message, { role: 'user', content: [{ type: 'tool_result', toolCallId: call!.id, content: 'export const q = 1;' }] });
    const second = await provider.chat({ system: 'SYS', messages, tools }, () => {});
    assert.equal(second.stopReason, 'end_turn');
    assert.deepEqual(second.message.content.filter((b) => b.type === 'text'), [{ type: 'text', text: 'The file exports q.' }]);

    const log = received();
    assert.equal(log.length, 2);
    assert.equal(log[0].pid, log[1].pid, 'same CLI process for both turns');
    assert.equal(log[0].text, 'What does src/a.ts export?');
    assert.equal(
      log[1].text,
      '<function_results>\n<result>\n<tool_name>read_file</tool_name>\n<stdout>\nexport const q = 1;\n</stdout>\n</result>\n</function_results>',
      'only the new turn is sent',
    );

    const argv = log[0].argv;
    for (const flag of ['-p', '--input-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku']) {
      assert.ok(argv.includes(flag), `flag ${JSON.stringify(flag)}`);
    }
    assert.equal(argv[argv.indexOf('--tools') + 1], '', 'built-in tools disabled');
    // A plain text model, also what lets Radar run on it: no MCP servers (none given to the strict
    // config), no settings files (their hooks and plugins), no slash commands or skills.
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '', 'no settings files');
    assert.ok(argv.includes('--disable-slash-commands'));
    assert.ok(!argv.includes('--mcp-config') && !argv.some((a) => /skip-permissions|bypassPermissions/.test(a)));
  });

  it('restarts with the full transcript when the history no longer matches the session', async () => {
    setup(['First answer.', 'Second answer from a fresh process.']);
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const first = await provider.chat({ system: 'SYS', messages, tools }, () => {});
    // History diverges (e.g. another provider answered in between): same conversation, different assistant turn.
    const diverged: ChatMessage[] = [
      messages[0],
      { role: 'assistant', content: [{ type: 'text', text: 'An answer from another model.' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ];
    assert.notEqual(first.message, diverged[1]);
    process.env.FAKE_CC_SCRIPT = JSON.stringify(['Second answer from a fresh process.']);
    await provider.chat({ system: 'SYS', messages: diverged, tools }, () => {});
    const log = received();
    assert.notEqual(log[0].pid, log[1].pid, 'a new process was started');
    assert.match(log[1].text, /conversation so far[\s\S]*<assistant_turn>\nAn answer from another model\.\n<\/assistant_turn>[\s\S]*Latest message:\n\nand now\?$/);
  });

  it("runs a profile's CLI with CLAUDE_CONFIG_DIR set to its folder, and the default one with the environment as it is", async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
      setup(['Default profile.']);
      await provider.chat({ system: 'SYS', messages, tools }, () => {});
      provider.dispose();
      const dir = path.join(ws.root, 'claude-work');
      provider = new ClaudeCodeProvider({ executable: process.execPath, executableArgs: [FAKE_CLI], configDir: dir });
      await provider.chat({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools }, () => {});
      assert.deepEqual(
        received().map((r) => (r as unknown as { configDir: string | null }).configDir),
        [null, dir],
      );
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it('asks the model to rewrite a tool call it could not parse, once', async () => {
    setup([
      'Checking the file.\n<function_calls>\n<invoke name=read_file>\n<parameter name=path>src/a.ts</parameter>\n</invoke>\n</function_calls>',
      '<function_calls>\n<invoke name="read_file">\n<parameter name="path">src/a.ts</parameter>\n</invoke>\n</function_calls>',
    ]);
    const events: ProviderStreamEvent[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }];
    const response = await provider.chat({ system: 'SYS', messages, tools }, (e) => events.push(e));
    assert.equal(response.stopReason, 'tool_use');
    const call = response.message.content.find((b) => b.type === 'tool_call');
    assert.deepEqual(call && call.type === 'tool_call' && [call.name, call.input], ['read_file', { path: 'src/a.ts' }]);
    assert.deepEqual(response.message.content.filter((b) => b.type === 'text'), [{ type: 'text', text: 'Checking the file.' }]);
    assert.equal(response.usage.inputTokens, 22, 'both CLI turns are counted');
    assert.ok(events.some((e) => e.type === 'notice'));
    const log = received();
    assert.equal(log.length, 2);
    assert.match(log[1].text, /could not be read/);
  });

  it('accepts single-quoted names in calls', async () => {
    setup(["<function_calls>\n<invoke name='read_file'>\n<parameter name='path'>src/a.ts</parameter>\n</invoke>\n</function_calls>"]);
    const response = await provider.chat({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools }, () => {});
    assert.equal(response.stopReason, 'tool_use');
    assert.equal(received().length, 1, 'no repair round needed');
  });

  it('a model that needs a newer CLI comes back with an update action and the alias hint', async () => {
    setup(["__ERROR__:API Error: 400 Claude Code 2.1.181 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again."]);
    await assert.rejects(
      provider.chat({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools }, () => {}),
      (error: unknown) => error instanceof ProviderError && error.action === 'claudeUpdate' && error.kind === 'bad_request' && /Opus \(latest\)/.test(error.message),
    );
  });

  it('reports CLI errors such as usage limits as rate-limit provider errors', async () => {
    setup(["__ERROR__:You've hit your session limit · resets 6pm"]);
    await assert.rejects(
      provider.chat({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools }, () => {}),
      (error: unknown) => error instanceof ProviderError && error.kind === 'rate_limit' && /session limit/.test(error.message),
    );
  });

  it('aborts a running turn', async () => {
    setup([]); // never answers with anything useful, we abort first
    const controller = new AbortController();
    const pending = provider.chat(
      { system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools, signal: controller.signal },
      () => {},
    );
    controller.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === 'AbortedError');
  });
});

describe('contextWindowOf', () => {
  it('reads the largest window the result reports, nothing when there is none', () => {
    assert.equal(contextWindowOf({ a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } }), 1000000);
    assert.equal(contextWindowOf({ a: { contextWindow: 'big' } }), undefined);
    assert.equal(contextWindowOf(undefined), undefined);
    assert.equal(contextWindowOf({}), undefined);
  });
});
