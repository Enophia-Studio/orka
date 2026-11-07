/**
 * What a running session waits for, in words: the status line and the session list say it.
 * Pure (type-only imports and the translation table), so the webview uses it as well.
 */
import { t } from '../i18n';
import type { WaitStatus } from '../orchestrator/events';

/** "server · tool" for an MCP tool (mcp__server__tool), else the tool's name. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** 24-hour hh:mm in local time. */
export function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The wait in a few words; `now` counts a retry down. */
export function waitLabel(wait: WaitStatus, now = Date.now()): string {
  switch (wait.reason) {
    case 'starting':
      return wait.agent ? t('Starting {agent}', { agent: wait.agent }) : t('Starting the CLI');
    case 'thinking':
      return t('Thinking');
    case 'tool':
      return t('Running {tool}', { tool: toolLabel(wait.tool) });
    case 'approval':
      return t('Waiting for your approval');
    case 'retrying':
      return t('Retrying in {n}s (attempt {attempt}/{max})', { n: Math.max(0, Math.ceil((wait.until - now) / 1000)), attempt: wait.attempt, max: wait.max });
    case 'rate_limited':
      return t('Rate limited until {time} (attempt {attempt}/{max})', { time: clockTime(wait.until), attempt: wait.attempt, max: wait.max });
    case 'compacting':
      return t('Compacting the conversation');
    case 'subagent':
      return wait.agent ? t('Waiting for the {agent} sub-agent', { agent: wait.agent }) : t('Waiting for a sub-agent');
  }
}

/** A wait that counts down (the label changes every second until `until`). */
export function waitCountsDown(wait: WaitStatus | undefined, now = Date.now()): boolean {
  return !!wait && (wait.reason === 'retrying' || wait.reason === 'rate_limited') && wait.until > now;
}
