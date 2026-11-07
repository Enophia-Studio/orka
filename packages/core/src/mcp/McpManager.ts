import { t } from '../i18n';
import type { Tool } from '../tools/Tool';
import { ToolError } from '../tools/Tool';
import type { JsonSchema } from '../types';
import { McpClient, type McpServerConfig, type McpState, type McpToolInfo } from './McpClient';
import { MCP_LIMIT_DEFAULTS, type McpLimits, type McpServerLimits } from './limits';

export { MCP_LIMIT_DEFAULTS, MCP_LIMIT_RANGES, type McpLimits, type McpServerLimits, readMcpLimits, readMcpServerLimits } from './limits';

export interface McpServerStatus {
  name: string;
  state: McpState;
  /** Tools the server lists. */
  tools: number;
  /** Of those, the ones the model gets (allow-list and the server's own tool limit applied). */
  exposed: number;
  /** The names of the tools the server lists (empty until it started). */
  toolNames: string[];
  error?: string;
  disabled?: boolean;
}

/** Tool names must fit every provider (letters, digits, _ and -, at most 64 characters). */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/**
 * At most max MCP tools for the model (0 = all), in server order; with a notice for the user when
 * some were left out. Providers refuse requests with too many tools, and each tool costs tokens.
 */
export function capMcpTools(tools: Tool[], max: number): { tools: Tool[]; notice?: string } {
  if (!max || tools.length <= max) return { tools };
  return {
    tools: tools.slice(0, max),
    notice: t('MCP servers offer {total} tools; the model gets the first {n} of them (Settings → MCP → Limits).', { total: tools.length, n: max }),
  };
}

/**
 * Keeps one client per configured MCP server alive across tasks, restarts a server when its
 * configuration changes, and exposes all their tools as agent tools.
 */
export class McpManager {
  private readonly clients = new Map<string, { client: McpClient; key: string }>();
  private configs: Record<string, McpServerConfig> = {};
  private limits: McpLimits = { ...MCP_LIMIT_DEFAULTS };
  private serverLimits: Record<string, McpServerLimits> = {};

  constructor(private readonly onChange: () => void = () => {}) {}

  /**
   * Apply the current configuration: removed or changed servers are stopped (started again on
   * demand). Limits apply from the next start, call and task; changing them restarts nothing.
   */
  sync(configs: Record<string, McpServerConfig>, limits?: { global?: McpLimits; servers?: Record<string, McpServerLimits> }): void {
    this.configs = configs;
    if (limits?.global) this.limits = limits.global;
    if (limits?.servers) this.serverLimits = limits.servers;
    for (const [name, entry] of this.clients) {
      const config = configs[name];
      if (!config || config.disabled || JSON.stringify(config) !== entry.key) {
        entry.client.close();
        this.clients.delete(name);
      }
    }
    this.onChange();
  }

  /** One server's limits: its own values, else the global ones. */
  limitsFor(server: string): McpLimits {
    const own = this.serverLimits[server] ?? {};
    return {
      maxResultChars: own.maxResultChars ?? this.limits.maxResultChars,
      callTimeoutSeconds: own.callTimeoutSeconds ?? this.limits.callTimeoutSeconds,
      startTimeoutSeconds: own.startTimeoutSeconds ?? this.limits.startTimeoutSeconds,
      // A server's own tool limit; the global one counts every server's tools together (capMcpTools).
      maxTools: own.maxTools ?? 0,
    };
  }

  /** Start every enabled server (in parallel) and return their tools. Servers that fail are skipped. */
  async tools(): Promise<Tool[]> {
    const names = Object.keys(this.configs).filter((n) => !this.configs[n].disabled);
    await Promise.all(names.map((name) => this.client(name).start(this.limitsFor(name).startTimeoutSeconds * 1000).catch(() => undefined)));
    this.onChange();
    const tools: Tool[] = [];
    const used = new Set<string>();
    for (const name of names) {
      const client = this.clients.get(name)?.client;
      if (client?.state !== 'ready') continue;
      for (const info of this.exposedTools(name, client.tools)) {
        const toolName = mcpToolName(name, info.name);
        if (used.has(toolName)) continue;
        used.add(toolName);
        tools.push(this.wrap(name, toolName, info));
      }
    }
    return tools;
  }

  /** A server's tools the model may get: those on its allow-list (all without one), at most its own tool limit. */
  private exposedTools(server: string, tools: McpToolInfo[]): McpToolInfo[] {
    const allowed = this.serverLimits[server]?.allowedTools;
    const list = allowed ? tools.filter((tool) => allowed.includes(tool.name)) : tools;
    const max = this.limitsFor(server).maxTools;
    return max ? list.slice(0, max) : list;
  }

  status(): McpServerStatus[] {
    return Object.entries(this.configs).map(([name, config]) => {
      const client = this.clients.get(name)?.client;
      const ready = client?.state === 'ready';
      return {
        name,
        state: config.disabled ? 'idle' : (client?.state ?? 'idle'),
        tools: ready ? client.tools.length : 0,
        exposed: ready ? this.exposedTools(name, client.tools).length : 0,
        toolNames: ready ? client.tools.map((tool) => tool.name) : [],
        error: client?.error,
        disabled: config.disabled,
      };
    });
  }

  /** Stop everything; servers start again on the next task. */
  restart(): void {
    for (const { client } of this.clients.values()) client.close();
    this.clients.clear();
    this.onChange();
  }

  dispose(): void {
    for (const { client } of this.clients.values()) client.close();
    this.clients.clear();
  }

  private client(name: string): McpClient {
    const existing = this.clients.get(name);
    if (existing && existing.client.state !== 'error' && existing.client.state !== 'closed') return existing.client;
    existing?.client.close();
    const config = this.configs[name];
    const client = new McpClient(name, config);
    this.clients.set(name, { client, key: JSON.stringify(config) });
    return client;
  }

  private wrap(server: string, toolName: string, info: McpToolInfo): Tool<Record<string, unknown>> {
    const readOnly = info.annotations?.readOnlyHint === true;
    const destructive = info.annotations?.destructiveHint === true && !readOnly;
    const schema: JsonSchema = info.inputSchema && typeof info.inputSchema === 'object' ? { type: 'object', ...info.inputSchema } : { type: 'object', properties: {} };
    return {
      name: toolName,
      readOnly,
      description: `[MCP server "${server}"] ${info.description?.trim() || info.annotations?.title || info.name}`,
      inputSchema: schema,
      describe: (input) => ({
        // MCP tools act outside the workspace (an editor, a database, ...): treat them like commands.
        // The server's own hints may only raise the risk, never lower it: a "read-only" tool still
        // follows the terminal rules (Ask mode asks), so a server cannot vouch for itself.
        category: 'command',
        risk: destructive ? 'dangerous' : 'normal',
        title: t('MCP {server}: {tool}', { server, tool: info.annotations?.title || info.name }),
        detail: `${server} / ${info.name}\n${JSON.stringify(input, null, 2).slice(0, 2000)}`,
      }),
      execute: async (input, ctx) => {
        const client = this.clients.get(server)?.client;
        if (!client) throw new ToolError(`The MCP server "${server}" is not running any more.`);
        const limits = this.limitsFor(server);
        const timeoutMs = limits.callTimeoutSeconds ? limits.callTimeoutSeconds * 1000 : Math.max(ctx.commandTimeoutMs, 60_000);
        try {
          return await client.callTool(info.name, input, ctx.signal, timeoutMs, limits.maxResultChars);
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          throw new ToolError(`MCP server "${server}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }
}
