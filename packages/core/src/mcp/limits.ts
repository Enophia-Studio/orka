// MCP limits: plain data and checks, with no Node code, so the settings UI can use them too.

/**
 * Limits on what MCP servers may cost: the size of one tool result (in characters), how long one
 * call and the start may take (seconds) and how many tools go to the model. 0 means "no limit" for
 * maxTools and "follow the command timeout (at least 60 s)" for callTimeoutSeconds.
 */
export interface McpLimits {
  maxResultChars: number;
  callTimeoutSeconds: number;
  startTimeoutSeconds: number;
  maxTools: number;
}

/** One server's own limits (each one unset = the global value) and the tools it may give the model (unset = all). */
export interface McpServerLimits extends Partial<McpLimits> {
  allowedTools?: string[];
}

export const MCP_LIMIT_DEFAULTS: McpLimits = { maxResultChars: 40_000, callTimeoutSeconds: 0, startTimeoutSeconds: 30, maxTools: 100 };

/** The values each limit may take (inclusive). */
export const MCP_LIMIT_RANGES: Record<keyof McpLimits, [number, number]> = {
  maxResultChars: [1_000, 1_000_000],
  callTimeoutSeconds: [0, 3600],
  startTimeoutSeconds: [5, 600],
  maxTools: [0, 1000],
};

const LIMIT_KEYS = Object.keys(MCP_LIMIT_RANGES) as Array<keyof McpLimits>;
const TOOL_NAME = /^[\w.:/-]{1,128}$/;

function validLimit(key: keyof McpLimits, value: unknown): value is number {
  const [min, max] = MCP_LIMIT_RANGES[key];
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Global limits from settings: a value out of range falls back to its default. */
export function readMcpLimits(raw: Partial<Record<keyof McpLimits, unknown>> | undefined): McpLimits {
  const out = { ...MCP_LIMIT_DEFAULTS };
  for (const key of LIMIT_KEYS) if (validLimit(key, raw?.[key])) out[key] = raw![key] as number;
  return out;
}

/** Per-server limits from settings (server name -> limits); entries and values that do not look right are dropped. */
export function readMcpServerLimits(raw: unknown): Record<string, McpServerLimits> {
  const out: Record<string, McpServerLimits> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[\w.-]{1,40}$/.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const limits: McpServerLimits = {};
    for (const key of LIMIT_KEYS) if (validLimit(key, v[key])) limits[key] = v[key] as number;
    if (Array.isArray(v.allowedTools)) limits.allowedTools = [...new Set(v.allowedTools.filter((s): s is string => typeof s === 'string' && TOOL_NAME.test(s)))].slice(0, 1000);
    if (Object.keys(limits).length) out[name] = limits;
  }
  return out;
}


/** Of a server's tools (in its order), those the model gets: on its allow-list (all without one), at most its own tool limit. */
export function allowedMcpTools<T>(tools: readonly T[], nameOf: (tool: T) => string, limits: McpServerLimits | undefined): T[] {
  const allowed = limits?.allowedTools;
  const list = allowed ? tools.filter((tool) => allowed.includes(nameOf(tool))) : [...tools];
  return limits?.maxTools ? list.slice(0, limits.maxTools) : list;
}
