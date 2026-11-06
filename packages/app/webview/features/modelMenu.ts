// The message box's model menu: the session's model, effort and Claude Code profile, from its next
// request on. The settings hold the defaults a new session starts with ("Use as default" writes
// them); the provider itself is picked in the Agents panel.
import type { ContextFill, ModelInfo } from '@orka/core';
import { t } from '@orka/core/src/i18n';
import type { SessionModelView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

export interface ModelMenuInput {
  view: SessionModelView;
  /** The provider's models (none for an agent CLI). */
  models: readonly ModelInfo[];
  /** The provider runs as an agent CLI (it picks its model itself unless it offers a choice). */
  agent: boolean;
  /** A request runs now: changes apply from the next one. */
  running: boolean;
}

/** What an effort level is called in the menu ('' = the provider's own default). */
export function effortLabel(provider: string, effort: string): string {
  if (effort) return effort;
  return provider === 'claude-code' ? t('CLI default') : t('Default');
}

/** The button in the message box: "Claude Code · Opus (latest) · max". */
export function modelButtonHtml(label: string, view: SessionModelView | undefined, open: boolean, warn: boolean): string {
  const effort = view?.effort ? ` · ${view.effort}` : '';
  return `<button class="agent-btn model-btn${open ? ' open' : ''}${warn ? ' warn' : ''}" data-action="model-menu" aria-haspopup="dialog" aria-expanded="${open}" title="${attr(
    t('Model and effort for this session'),
  )}">${icon('agent')}<span>${escapeHtml(label + effort)}</span>${icon('chevron', 'chev')}</button>`;
}

function radio(action: string, attrs: string, checked: boolean, label: string, hint = ''): string {
  return `<button class="model-option" role="radio" aria-checked="${checked}" data-action="${action}" ${attrs}>${icon(checked ? 'check' : 'none', 'tick')}<span class="model-option-label">${escapeHtml(
    label,
  )}</span>${hint ? `<span class="menu-hint">${escapeHtml(hint)}</span>` : ''}</button>`;
}

export function modelMenuHtml({ view, models, agent, running }: ModelMenuInput): string {
  const sections: string[] = [];
  // The model: the provider's list (the model of the session first when it is not on it).
  let modelRows: string;
  if (agent) {
    modelRows = `<p class="model-menu-note">${escapeHtml(t('Set in the agent'))}</p>`;
  } else {
    const list = view.model && !models.some((m) => m.id === view.model) ? [{ id: view.model, label: view.model, family: '' } as ModelInfo, ...models] : models;
    modelRows = `<div class="model-options" role="radiogroup" aria-label="${attr(t('Model'))}">${list
      .map((m) => radio('session-model', `data-model="${attr(m.id)}"`, m.id === view.model, t(m.label), m.note ? t(m.note) : ''))
      .join('')}</div>`;
  }
  sections.push(`<div class="model-menu-section"><div class="model-menu-label">${escapeHtml(t('Model'))}</div>${modelRows}</div>`);
  if (view.efforts.length) {
    const buttons = view.efforts
      .map(
        (e) =>
          `<button class="seg-btn" role="radio" aria-checked="${e === view.effort}" data-action="session-effort" data-effort="${attr(e)}"${
            e ? '' : ` title="${attr(t('The provider’s own default'))}"`
          }>${escapeHtml(effortLabel(view.provider, e))}</button>`,
      )
      .join('');
    sections.push(
      `<div class="model-menu-section"><div class="model-menu-label">Effort</div><div class="seg" role="radiogroup" aria-label="Effort">${buttons}</div></div>`,
    );
  }
  if (view.profiles.length) {
    sections.push(
      `<div class="model-menu-section"><div class="model-menu-label">Claude Code Profile</div><div class="model-options" role="radiogroup" aria-label="Profile">${view.profiles
        .map((p) => radio('session-profile', `data-profile="${attr(p.id)}"`, p.id === view.profile, p.name))
        .join('')}</div></div>`,
    );
  }
  const note = running ? `<p class="model-menu-note">${escapeHtml(t('Applies from your next message.'))}</p>` : '';
  const footer = `<div class="model-menu-foot">
      <button class="link" data-action="model-menu-agents">${escapeHtml(t('Agent settings…'))}</button>
      <button class="btn small" data-action="session-model-default"${view.differs ? '' : ' disabled'} title="${attr(
        t('New sessions start with this model, effort and profile. Sessions open now keep theirs.'),
      )}">${escapeHtml(t('Use as default'))}</button>
    </div>`;
  return `${sections.join('')}${note}${footer}`;
}

/**
 * The context gauge next to the model menu: a ring filled as far as the conversation fills the
 * model's context window, as the provider reported it. Undefined when that is not known (no ring).
 * `count` writes a token count ("12.3k").
 */
export function contextRing(context: ContextFill | undefined, count: (n: number) => string): { html: string; title: string } | undefined {
  if (!context || !(context.size > 0) || !(context.used >= 0)) return undefined;
  const share = Math.min(1, context.used / context.size);
  // r = 6 in a 16 x 16 box.
  const length = 2 * Math.PI * 6;
  const level = share >= 0.9 ? ' full' : share >= 0.7 ? ' high' : '';
  const html = `<svg class="ring${level}" viewBox="0 0 16 16" aria-hidden="true"><circle class="ring-track" cx="8" cy="8" r="6"/><circle class="ring-fill" cx="8" cy="8" r="6" stroke-dasharray="${(share * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
  const title = t('Context: {percent}% full ({used} of {size} tokens)', { percent: Math.round(share * 100), used: count(context.used), size: count(context.size) });
  return { html, title };
}
