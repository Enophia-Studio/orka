// Settings > MCP > Limits: the global limits (one tool result's size, a call's and a start's time,
// how many MCP tools the model gets), and per server its own values and which of its tools the
// model may use. A server's form leaves a field empty to follow the global value.
import { t, tn } from '@orka/core/src/i18n';
import { MCP_LIMIT_RANGES, type McpLimits, type McpServerLimits } from '@orka/core/src/mcp/limits';
import type { McpServerView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

const KEYS = Object.keys(MCP_LIMIT_RANGES) as Array<keyof McpLimits>;

function label(key: keyof McpLimits, server: boolean): string {
  switch (key) {
    case 'maxResultChars':
      return t('Largest tool result');
    case 'callTimeoutSeconds':
      return t('Tool call timeout');
    case 'startTimeoutSeconds':
      return t('Start timeout');
    case 'maxTools':
      return server ? t('Most tools from this server') : t('Most MCP tools for the model');
  }
}

function unit(key: keyof McpLimits): string {
  return key === 'maxResultChars' ? t('characters') : key === 'maxTools' ? '' : 's';
}

/** The global limits card: generic setting inputs (mcp.maxResultChars, ...). */
export function globalLimitsHtml(limits: McpLimits): string {
  const hint: Record<keyof McpLimits, string> = {
    maxResultChars: t('Longer results are cut, with a note to the model that asks for less.'),
    callTimeoutSeconds: t('0 = the command timeout (at least 60 s).'),
    startTimeoutSeconds: t('Starting a server and listing its tools.'),
    maxTools: t('All servers together; 0 = no limit. Providers refuse requests with too many tools.'),
  };
  const rows = KEYS.map((key) => {
    const [min, max] = MCP_LIMIT_RANGES[key];
    return `<div class="row"><span class="grow">${escapeHtml(label(key, false))}<br><span class="muted small">${escapeHtml(hint[key])}</span></span><input class="num${key === 'maxResultChars' ? ' wide' : ''}" type="number" min="${min}" max="${max}" data-type="int" data-setting="mcp.${key}" value="${attr(String(limits[key]))}" aria-label="${attr(label(key, false))}">${unit(key) ? `<span class="muted">${escapeHtml(unit(key))}</span>` : ''}</div>`;
  }).join('');
  return `<div class="card mcp-limits">
    <div class="card-head">${icon('shield', 'sub')}<strong>${escapeHtml(t('Limits'))}</strong></div>
    ${rows}
  </div>`;
}

/** A server's tool count: "4 of 6 tools" when the allow-list or its own limit leaves some out. */
export function toolCountLabel(server: Pick<McpServerView, 'tools' | 'exposed'>): string {
  return server.exposed < server.tools ? t('{n} of {total} tools', { n: server.exposed, total: server.tools }) : tn('{n} tool', '{n} tools', server.tools);
}

/** A server's own limits form, under its row while open. */
export function serverLimitsHtml(server: McpServerView, global: McpLimits): string {
  const own = server.limits ?? {};
  const fields = KEYS.map((key) => {
    const [min, max] = MCP_LIMIT_RANGES[key];
    // A server's maxTools counts that server alone; there is no global value to show.
    const placeholder = key === 'maxTools' ? t('No limit') : String(global[key]);
    return `<label class="row"><span class="grow">${escapeHtml(label(key, true))}</span><input class="num${key === 'maxResultChars' ? ' wide' : ''}" type="number" min="${min}" max="${max}" data-mcp-limit="${key}" placeholder="${attr(placeholder)}" value="${own[key] === undefined ? '' : attr(String(own[key]))}">${unit(key) ? `<span class="muted">${escapeHtml(unit(key))}</span>` : ''}</label>`;
  }).join('');
  const allowed = own.allowedTools;
  const tools = server.toolNames.length
    ? `<div class="mcp-tools" role="group" aria-label="${attr(t('Tools the model may use'))}">
        <div class="row"><span class="grow">${escapeHtml(t('Tools the model may use'))}</span>
          <button class="link" data-action="mcp-tools-all" data-name="${attr(server.name)}">${escapeHtml(t('All'))}</button>
          <button class="link" data-action="mcp-tools-none" data-name="${attr(server.name)}">${escapeHtml(t('None'))}</button></div>
        ${server.toolNames
          .map((name) => `<label class="check mono small"><input type="checkbox" data-mcp-tool="${attr(name)}"${!allowed || allowed.includes(name) ? ' checked' : ''}> ${escapeHtml(name)}</label>`)
          .join('')}
      </div>`
    : `<p class="footnote">${escapeHtml(
        allowed
          ? t('{n} tools are allowed. Start the server (run a task) to see and change the list.', { n: allowed.length })
          : t('Start the server (run a task) to choose which of its tools the model may use.'),
      )}</p>`;
  return `<div class="mcp-server-limits" data-mcp-limits-for="${attr(server.name)}">
    <div class="muted small">${escapeHtml(t('Empty fields follow the limits for every server.'))}</div>
    ${fields}
    ${tools}
    <div class="key-row">
      <button class="btn primary" data-action="mcp-limits-save" data-name="${attr(server.name)}">${escapeHtml(t('Save'))}</button>
      <button class="btn" data-action="mcp-limits-reset" data-name="${attr(server.name)}">${escapeHtml(t('Use the limits for every server'))}</button>
    </div>
  </div>`;
}

/**
 * The values of a server's form. Only numbers in range are kept; the allow-list is left out when
 * every tool is ticked (so tools the server adds later are allowed too) or the server has not
 * listed its tools yet (the stored list stays as it was).
 */
export function readServerLimitsForm(form: ParentNode, previous: McpServerLimits | undefined): McpServerLimits {
  const out: McpServerLimits = {};
  for (const input of form.querySelectorAll<HTMLInputElement>('input[data-mcp-limit]')) {
    const key = input.dataset.mcpLimit as keyof McpLimits;
    if (!KEYS.includes(key) || input.value.trim() === '') continue;
    const value = Number(input.value);
    const [min, max] = MCP_LIMIT_RANGES[key];
    if (Number.isInteger(value) && value >= min && value <= max) out[key] = value;
  }
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[data-mcp-tool]')];
  if (!boxes.length) {
    if (previous?.allowedTools) out.allowedTools = previous.allowedTools;
  } else if (boxes.some((box) => !box.checked)) {
    out.allowedTools = boxes.filter((box) => box.checked).map((box) => box.dataset.mcpTool!);
  }
  return out;
}

/** The open form of a server (compared by its data attribute, never through a built selector). */
export function serverLimitsForm(root: ParentNode, name: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[data-mcp-limits-for]')].find((el) => el.dataset.mcpLimitsFor === name);
}

/** What the open forms hold, so a settings re-render (a server started, say) keeps unsaved input. */
export type LimitDrafts = Map<string, Map<string, string | boolean>>;

export function captureLimitDrafts(root: ParentNode): LimitDrafts {
  const drafts: LimitDrafts = new Map();
  for (const form of root.querySelectorAll<HTMLElement>('[data-mcp-limits-for]')) {
    const values = new Map<string, string | boolean>();
    for (const input of form.querySelectorAll<HTMLInputElement>('input[data-mcp-limit]')) values.set(`limit:${input.dataset.mcpLimit}`, input.value);
    for (const input of form.querySelectorAll<HTMLInputElement>('input[data-mcp-tool]')) values.set(`tool:${input.dataset.mcpTool}`, input.checked);
    drafts.set(form.dataset.mcpLimitsFor!, values);
  }
  return drafts;
}

export function restoreLimitDrafts(root: ParentNode, drafts: LimitDrafts): void {
  for (const form of root.querySelectorAll<HTMLElement>('[data-mcp-limits-for]')) {
    const values = drafts.get(form.dataset.mcpLimitsFor!);
    if (!values) continue;
    for (const input of form.querySelectorAll<HTMLInputElement>('input[data-mcp-limit]')) {
      const value = values.get(`limit:${input.dataset.mcpLimit}`);
      if (typeof value === 'string') input.value = value;
    }
    for (const input of form.querySelectorAll<HTMLInputElement>('input[data-mcp-tool]')) {
      const value = values.get(`tool:${input.dataset.mcpTool}`);
      if (typeof value === 'boolean') input.checked = value;
    }
  }
}
