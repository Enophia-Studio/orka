// What a running session waits for, as a label in the status line and in the session list. A
// retry's countdown ticks in place, so nothing else (an open menu, a focused button) is redrawn.
import type { WaitStatus } from '@orka/core';
import { waitCountsDown, waitLabel } from '@orka/core/src/ui/waitStatus';
import { attr, escapeHtml } from '../core/dom';

/** The label, with the wait kept on the element for the countdown. */
export function waitHtml(wait: WaitStatus, cls: string): string {
  return `<span class="${attr(cls)}" data-wait="${attr(JSON.stringify(wait))}" data-reason="${attr(wait.reason)}">${escapeHtml(waitLabel(wait))}</span>`;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Bring every countdown on the page up to date; again in a second while one still counts down. */
export function tickWaits(root: ParentNode = document, now = Date.now()): boolean {
  let counting = false;
  root.querySelectorAll<HTMLElement>('[data-wait]').forEach((node) => {
    let wait: WaitStatus;
    try {
      wait = JSON.parse(node.dataset.wait ?? '') as WaitStatus;
    } catch {
      return;
    }
    const label = waitLabel(wait, now);
    if (node.textContent !== label) node.textContent = label;
    if (waitCountsDown(wait, now)) counting = true;
  });
  return counting;
}

/** After a render: keep the countdowns going while any is on the page. */
export function scheduleWaitTicks(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    if (tickWaits()) scheduleWaitTicks();
  }, 1000);
}
