import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ChangeTracker } from '../src/changes/ChangeTracker';
import { NodeHost } from '../src/host/NodeHost';
import { McpClient, truncateResult } from '../src/mcp/McpClient';
import { capMcpTools, MCP_LIMIT_DEFAULTS, McpManager, readMcpLimits, readMcpServerLimits } from '../src/mcp/McpManager';
import type { AgentEvent } from '../src/orchestrator/events';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { PermissionManager } from '../src/permissions/PermissionManager';
import type { Tool, ToolContext } from '../src/tools/Tool';
import { ScriptedProvider, tempWorkspace, text } from './helpers';

const SCRIPT = path.resolve(__dirname, '../../test/fixtures/fake-mcp.mjs');
const FAKE = { command: process.execPath, args: [SCRIPT], env: { FAKE_MCP_EXTRA: '1' } };

describe('MCP limits', () => {
  let ws: ReturnType<typeof tempWorkspace>;
  let manager: McpManager;
  beforeEach(() => {
    ws = tempWorkspace();
    manager = new McpManager();
  });
  afterEach(() => {
    manager.dispose();
    ws.cleanup();
  });

  const ctx = (commandTimeoutMs = 10_000): ToolContext => {
    const host = new NodeHost({ workspaceRoot: ws.root });
    return { callId: 'c', host, changes: new ChangeTracker(host), signal: new AbortController().signal, commandTimeoutMs, plan: undefined, setPlan: () => {}, onOutput: () => {} };
  };
  const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!;

  it('reads limits from settings, dropping values out of range', () => {
    assert.deepEqual(readMcpLimits(undefined), MCP_LIMIT_DEFAULTS);
    assert.deepEqual(readMcpLimits({ maxResultChars: 5000, callTimeoutSeconds: 20, startTimeoutSeconds: 1, maxTools: '50' }), {
      ...MCP_LIMIT_DEFAULTS,
      maxResultChars: 5000,
      callTimeoutSeconds: 20,
    });
    assert.deepEqual(
      readMcpServerLimits({
        unity: { maxResultChars: 2000, maxTools: 3, allowedTools: ['a', 'b', 'a', 7, 'bad name'] },
        'bad name': { maxTools: 3 },
        blender: { maxResultChars: 1.5, startTimeoutSeconds: 9999 },
        list: [1],
      }),
      { unity: { maxResultChars: 2000, maxTools: 3, allowedTools: ['a', 'b'] } },
    );
  });

  it('cuts a large tool result at the server limit and tells the model', async () => {
    manager.sync({ unity: FAKE }, { servers: { unity: { maxResultChars: 1000 } } });
    const tools = await manager.tools();
    const result = await tool(tools, 'mcp__unity__big_output').execute({ size: 5000 }, ctx());
    assert.ok(result.content.startsWith('x'.repeat(1000)));
    assert.ok(!result.content.startsWith('x'.repeat(1001)));
    assert.match(result.content, /cut this result at the MCP limit of 1000 characters; 4000 more characters were not shown/);
    // The global limit applies where the server has none of its own.
    manager.sync({ unity: FAKE }, { global: { ...MCP_LIMIT_DEFAULTS, maxResultChars: 2000 }, servers: {} });
    const again = await tool(await manager.tools(), 'mcp__unity__big_output').execute({ size: 5000 }, ctx());
    assert.match(again.content, /limit of 2000 characters; 3000 more/);
    assert.equal(truncateResult('short', 10), 'short');
  });

  it('a call that takes longer than the call timeout fails, and a fast one does not', async () => {
    manager.sync({ unity: FAKE }, { servers: { unity: { callTimeoutSeconds: 1 } } });
    const tools = await manager.tools();
    const slow = tool(tools, 'mcp__unity__slow');
    const started = Date.now();
    await assert.rejects(slow.execute({ ms: 4000 }, ctx(60_000)), /no answer to tools\/call within 1s/);
    assert.ok(Date.now() - started < 3500, 'the server limit, not the command timeout');
    assert.equal((await slow.execute({ ms: 10 }, ctx())).content, 'done');
  });

  it('starts each server with its start timeout', async () => {
    // A server slower than the timeout fails to start.
    const client = new McpClient('slow', { ...FAKE, env: { FAKE_MCP_START_DELAY: '1500' } });
    try {
      await assert.rejects(client.start(300), /no answer to initialize within 0s|within 0s/);
      assert.equal(client.state, 'error');
    } finally {
      client.close();
    }
    // The manager passes each server's own value, else the global one.
    const seen: Array<[string, number]> = [];
    const original = McpClient.prototype.start;
    McpClient.prototype.start = function (this: McpClient, timeoutMs?: number) {
      seen.push([this.name, timeoutMs ?? -1]);
      return Promise.reject(new Error('not started in this test'));
    };
    try {
      manager.sync({ a: FAKE, b: FAKE }, { global: { ...MCP_LIMIT_DEFAULTS, startTimeoutSeconds: 45 }, servers: { a: { startTimeoutSeconds: 120 } } });
      assert.deepEqual(await manager.tools(), []);
      assert.deepEqual(seen.sort(), [
        ['a', 120_000],
        ['b', 45_000],
      ]);
    } finally {
      McpClient.prototype.start = original;
    }
  });

  it('gives the model only allowed tools, at most the server limit, and shows both counts', async () => {
    manager.sync({ unity: FAKE }, { servers: { unity: { allowedTools: ['get_scene', 'slow', 'big_output'], maxTools: 2 } } });
    const tools = await manager.tools();
    assert.deepEqual(tools.map((t) => t.name), ['mcp__unity__get_scene', 'mcp__unity__big_output']);
    const [status] = manager.status();
    assert.equal(status.tools, 4);
    assert.equal(status.exposed, 2);
    assert.deepEqual(status.toolNames, ['get_scene', 'delete_object', 'big_output', 'slow']);
    // New limits apply to the next task without restarting the server.
    const pid = (manager as unknown as { clients: Map<string, { client: McpClient }> }).clients.get('unity')!.client;
    manager.sync({ unity: FAKE }, { servers: {} });
    assert.equal((await manager.tools()).length, 4);
    assert.equal((manager as unknown as { clients: Map<string, { client: McpClient }> }).clients.get('unity')!.client, pid, 'same server process');
  });

  it('caps the tools of all servers together, and the agent says so', async () => {
    const fakeTool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' }, describe: () => ({ category: 'read', risk: 'safe', title: name }), execute: async () => ({ content: '' }) });
    const many = Array.from({ length: 5 }, (_, i) => fakeTool(`mcp__s__t${i}`));
    assert.deepEqual(capMcpTools(many, 0), { tools: many });
    assert.deepEqual(capMcpTools(many, 5), { tools: many });
    const capped = capMcpTools(many, 3);
    assert.deepEqual(capped.tools.map((t) => t.name), ['mcp__s__t0', 'mcp__s__t1', 'mcp__s__t2']);
    assert.match(capped.notice!, /offer 5 tools; the model gets the first 3/);

    const provider = new ScriptedProvider([
      (req) => {
        const names = req.tools.map((t) => t.name);
        assert.ok(names.includes('mcp__s__t2') && !names.includes('mcp__s__t3'));
        return [text('ok')];
      },
    ]);
    const events: AgentEvent[] = [];
    const orchestrator = new Orchestrator({
      host: new NodeHost({ workspaceRoot: ws.root }),
      getProvider: () => provider,
      permissions: new PermissionManager('balanced'),
      getSettings: () => ({ maxIterations: 3, autoVerify: false, commandTimeoutMs: 10_000 }),
      getExtraTools: async () => ({ tools: capped.tools, notices: [capped.notice!] }),
    });
    orchestrator.on((e) => events.push(e));
    assert.equal(await orchestrator.run('hi'), 'completed');
    assert.ok(events.some((e) => e.type === 'notice' && /the model gets the first 3/.test(e.message)));
  });
});
