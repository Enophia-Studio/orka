// Parts of a tool call's card: a failed call's reason in one line (the full text opens below it)
// and Stop for a running call the user can stop on its own while the request goes on.
import type { ToolCallView } from '@orka/core';
import { t } from '@orka/core/src/i18n';
import { attr, icon } from '../core/dom';

/** Longest error line in a card's head; the rest is in its details. */
const SUMMARY_CHARS = 140;

/** The first line of a failed call's output, shortened ('' for a call that did not fail). */
export function errorSummary(call: ToolCallView): string {
  if (call.status === 'cancelled') return t('Cancelled');
  if (call.status !== 'error' && call.status !== 'denied') return '';
  const line = (call.output ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/** Stop on a running call that can be stopped alone ('' otherwise). */
export function cancelToolButton(call: ToolCallView): string {
  if (call.status !== 'running' || !call.cancellable) return '';
  const label = t('Stop this tool');
  return `<button class="icon-btn tool-cancel" data-action="cancel-tool" data-id="${attr(call.id)}" aria-label="${attr(label)}" title="${attr(label)}">${icon('stop')}</button>`;
}
