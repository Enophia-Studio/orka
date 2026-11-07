// Settings > MCP > Limits: the page's HTML and form, and the app storing and applying the limits.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MCP_LIMIT_DEFAULTS } from '@orka/core/src/mcp/limits';
import type { Tool } from '@orka/core';
import { AppController } from '../src/AppController';
import type { McpServerView } from '../src/protocol';
import { captureLimitDrafts, globalLimitsHtml, readServerLimitsForm, restoreLimitDrafts, serverLimitsHtml, toolCountLabel } from '../webview/features/mcpLimits';
import { FakeShell } from './fakeShell';

const FAKE_MCP = path.resolve(__dirname, '../../../core/test/fixtures/fake-mcp.mjs');

const server = (patch: Partial<McpServerView> = {}): McpServerView => ({
  name: 'unity',
  source: 'settings',
  transport: 'stdio',
  target: 'node fake.mjs',
  enabled: true,
  state: 'ready',
  tools: 3,
  exposed: 3,
  toolNames: ['get_scene', 'delete_object', '<b>odd</b>'],
  limits: {},
  ...patch,
});

/** Just enough of an <input> and a container for the form readers. */
type FakeInput = { dataset: Record<string, string>; value: string; checked: boolean };
const input = (data: Record<string, string>, value = '', checked = false): FakeInput => ({ dataset: data, value, checked });
const form = (inputs: FakeInput[], name = 'unity') => {
  const node = {
    dataset: { mcpLimitsFor: name },
    querySelectorAll: (selector: string) =>
      selector === '[data-mcp-limits-for]'
        ? [node]
        : inputs.filter((i) => (selector.includes('data-mcp-limit]') ? 'mcpLimit' in i.dataset : 'mcpTool' in i.dataset)),
  };
  return node as unknown as HTMLElement;
};

describe('MCP limits page', () => {
  it('shows the global limits as settings inputs, and a server count with what the model gets', () => {
    const html = globalLimitsHtml({ ...MCP_LIMIT_DEFAULTS, maxTools: 64 });
    assert.match(html, /data-setting="mcp\.maxTools" value="64"/);
    assert.match(html, /data-setting="mcp\.maxResultChars" value="40000"/);
    assert.match(html, /data-setting="mcp\.callTimeoutSeconds"/);
    assert.match(html, /data-setting="mcp\.startTimeoutSeconds" value="30"/);
    assert.equal(toolCountLabel({ tools: 6, exposed: 4 }), '4 of 6 tools');
    assert.equal(toolCountLabel({ tools: 6, exposed: 6 }), '6 tools');
    assert.equal(toolCountLabel({ tools: 1, exposed: 1 }), '1 tool');
  });

  it("a server's form: global values as placeholders, its own values, its tools ticked from the allow-list, escaped", () => {
    const html = serverLimitsHtml(server({ limits: { maxResultChars: 2000, allowedTools: ['get_scene'] } }), MCP_LIMIT_DEFAULTS);
    assert.match(html, /data-mcp-limit="maxResultChars" placeholder="40000" value="2000"/);
    assert.match(html, /data-mcp-limit="startTimeoutSeconds" placeholder="30" value=""/);
    assert.match(html, /data-mcp-tool="get_scene" checked/);
    assert.match(html, /data-mcp-tool="delete_object">/);
    assert.ok(!html.includes('<b>odd</b>'), 'tool names from the server are escaped');
    assert.match(html, /&lt;b&gt;odd&lt;\/b&gt;/);
    // Not started yet: no list to tick, and a word on how to get one.
    assert.match(serverLimitsHtml(server({ toolNames: [], state: 'idle' }), MCP_LIMIT_DEFAULTS), /Start the server \(run a task\)/);
  });

  it('reads the form: numbers in range only, no allow-list when every tool is ticked', () => {
    const numbers = [input({ mcpLimit: 'maxResultChars' }, '5000'), input({ mcpLimit: 'callTimeoutSeconds' }, ''), input({ mcpLimit: 'maxTools' }, '-4'), input({ mcpLimit: 'startTimeoutSeconds' }, '2.5')];
    const all = [input({ mcpTool: 'a' }, '', true), input({ mcpTool: 'b' }, '', true)];
    assert.deepEqual(readServerLimitsForm(form([...numbers, ...all]), undefined), { maxResultChars: 5000 });
    const some = [input({ mcpTool: 'a' }, '', true), input({ mcpTool: 'b' }, '', false)];
    assert.deepEqual(readServerLimitsForm(form(some), undefined), { allowedTools: ['a'] });
    // A server that has not listed its tools keeps the stored list.
    assert.deepEqual(readServerLimitsForm(form([]), { allowedTools: ['x'] }), { allowedTools: ['x'] });
  });

  it('keeps unsaved input across a re-render', () => {
    const before = form([input({ mcpLimit: 'maxTools' }, '7'), input({ mcpTool: 'a' }, '', false)]);
    const drafts = captureLimitDrafts(before);
    const after = [input({ mcpLimit: 'maxTools' }, ''), input({ mcpTool: 'a' }, '', true)];
    restoreLimitDrafts(form(after), drafts);
    assert.equal(after[0]!.value, '7');
    assert.equal(after[1]!.checked, false);
  });
});

let home: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-mcp-limits-test-'));
  for (const dir of [path.join(home, 'work'), path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function start(settings: Record<string, unknown> = {}) {
  const shell = new FakeShell('desktop', home, [path.join(home, 'work')], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

describe('MCP limits in the app', () => {
  it('stores a server limits under mcp.serverLimits, drops bad values, and clears them', async () => {
    const { shell, controller } = await start({ mcpServers: { unity: { command: 'node', args: ['x.js'] } } });
    await controller.handleMessage({ type: 'setMcpServerLimits', name: 'unity', limits: { maxResultChars: 3000, maxTools: -1, callTimeoutSeconds: 'x' as unknown as number, allowedTools: ['get_scene'] } });
    assert.deepEqual(shell.settings.data['mcp.serverLimits'], { unity: { maxResultChars: 3000, allowedTools: ['get_scene'] } });
    const limits = () => shell.pageConfig()?.mcp.servers.find((s) => s.name === 'unity')?.limits ?? {};
    await until(() => Object.keys(limits()).length > 0);
    assert.deepEqual(limits(), { maxResultChars: 3000, allowedTools: ['get_scene'] });
    await controller.handleMessage({ type: 'setMcpServerLimits', name: '../bad', limits: { maxTools: 2 } });
    assert.deepEqual(Object.keys(shell.settings.data['mcp.serverLimits'] as object), ['unity']);
    await controller.handleMessage({ type: 'setMcpServerLimits', name: 'unity', limits: {} });
    assert.deepEqual(shell.settings.data['mcp.serverLimits'], {});
    // Global limits are plain settings, checked like the others.
    for (const value of [-1, 2000, 1.5]) await controller.handleMessage({ type: 'setSetting', key: 'mcp.maxTools', value });
    assert.equal(shell.settings.isSet('mcp.maxTools'), false);
    await controller.handleMessage({ type: 'setSetting', key: 'mcp.maxTools', value: 1 });
    await until(() => shell.pageConfig()?.mcp.limits.maxTools === 1);
    assert.equal(shell.pageConfig()?.mcp.limits.maxTools, 1);
    assert.deepEqual(shell.pageConfig()?.mcp.limits, { ...MCP_LIMIT_DEFAULTS, maxTools: 1 });
  });

  it("gives a task only the allowed tools and at most the global number, with a notice", async () => {
    const { shell, controller } = await start({
      mcpServers: { unity: { command: process.execPath, args: [FAKE_MCP] } },
      'mcp.maxTools': 1,
      'mcp.serverLimits': { unity: { allowedTools: ['delete_object', 'get_scene'] } },
    });
    const options = (controller.activeSession!.orchestrator as unknown as { options: { getExtraTools(): Promise<{ tools: Tool[]; notices: string[] }> } }).options;
    const extra = await options.getExtraTools();
    assert.deepEqual(
      extra.tools.map((t) => t.name),
      ['mcp__unity__get_scene'],
    );
    assert.match(extra.notices[0]!, /offer 2 tools; the model gets the first 1/);
    // Settings shows what the server lists and what its allow-list lets through.
    const unity = shell.pageConfig()?.mcp.servers.find((s) => s.name === 'unity');
    assert.equal(unity?.tools, 2);
    assert.equal(unity?.exposed, 2);
    assert.deepEqual(unity?.toolNames, ['get_scene', 'delete_object']);
  });
});
