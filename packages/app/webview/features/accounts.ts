// Accounts: which account each CLI is signed in with, as its own status command says, in the
// desktop sidebar's footer, in the Add account popup and in Settings > Accounts. Sign-in and
// sign-out are the vendor's own commands, run by the app in a terminal the user sees; the page
// only names a CLI id and a profile id.
import { t } from '@orka/core/src/i18n';
import type { AccountView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

/** The data attributes that name one row's CLI and Claude Code profile. */
function target(a: AccountView): string {
  return `data-cli="${attr(a.cli)}"${a.profile?.id ? ` data-profile="${attr(a.profile.id)}"` : ''}`;
}

export function accountKey(a: AccountView): string {
  return `${a.cli}:${a.profile?.id ?? ''}`;
}

/** Claude Code with profiles: every row names its profile; with the default one only, just the CLI. */
export function accountName(a: AccountView, all: readonly AccountView[]): string {
  if (!a.profile) return a.label;
  const profiles = all.filter((r) => r.cli === a.cli && r.profile).length;
  return profiles > 1 ? `${a.label} · ${a.profile.name}` : a.label;
}

/** Not known to be missing: listed as an account (before the first check every CLI is "unknown"). */
export function accountInstalled(a: AccountView): boolean {
  return a.status.state !== 'not_installed';
}

/** Signed in out of installed, once at least one status command answered; undefined before. */
export function accountsCount(accounts: readonly AccountView[]): { signedIn: number; installed: number } | undefined {
  if (!accounts.some((a) => a.status.state === 'signed_in' || a.status.state === 'signed_out' || a.status.state === 'not_installed')) return undefined;
  const installed = accounts.filter(accountInstalled);
  return { signedIn: installed.filter((a) => a.status.state === 'signed_in').length, installed: installed.length };
}

/** The state as a coloured dot and a word; what the status command said goes in the title. */
export function accountStateHtml(a: AccountView): string {
  const title = [a.status.label, a.status.hint].filter(Boolean).join('\n');
  const pill = (cls: string, text: string, dot = true) =>
    `<span class="pill${cls}"${title ? ` title="${attr(title)}"` : ''}>${dot ? '<span class="pill-dot"></span>' : ''}${escapeHtml(text)}</span>`;
  switch (a.status.state) {
    case 'checking':
      return `<span class="pill"><span class="spinner small"></span>${escapeHtml(t('Checking'))}</span>`;
    case 'signed_in':
      return pill(' ok', t('Signed in'));
    case 'signed_out':
      return pill(' warn', t('Signed out'));
    case 'not_installed':
      return pill(' warn', t('Not installed'));
    default:
      return pill('', t('Unknown'), false);
  }
}

/** One line under a row: what the status command said, else what to do instead. */
function detailHtml(a: AccountView): string {
  const text = a.status.label || a.status.hint;
  return text ? `<span class="muted small ellipsis" title="${attr(text)}">${escapeHtml(text)}</span>` : '';
}

/**
 * Accounts in the session list's footer and in the rail. The footer row folds open to one row per
 * installed CLI (and Claude Code profile), each with its … menu, then "Add account". The rail's
 * button opens the Add account popup.
 */
export function accountsEntryHtml(where: 'list' | 'rail', accounts: readonly AccountView[], open: boolean): string {
  const count = accountsCount(accounts);
  const label = count ? t('Accounts: {n} of {total} signed in', { n: count.signedIn, total: count.installed }) : t('Accounts');
  const badge = count ? `<span class="accounts-count" aria-hidden="true">${count.signedIn}/${count.installed}</span>` : '';
  if (where === 'rail') {
    return `<button class="icon-btn" data-action="add-account" aria-label="${attr(label)}" title="${attr(label)}">${icon('user')}</button>`;
  }
  const head = `<button class="side-link" data-action="toggle-accounts" aria-expanded="${open}" aria-label="${attr(label)}" title="${attr(label)}">${icon('user')}<span>${escapeHtml(
    t('Accounts'),
  )}</span>${badge}${icon('chevron', `fold-chevron${open ? '' : ' folded'}`)}</button>`;
  if (!open) return head;
  const rows = accounts
    .filter(accountInstalled)
    .map((a) => {
      const name = accountName(a, accounts);
      return `<div class="account-row" ${target(a)}>
        <span class="account-dot ${a.status.state}" aria-hidden="true"></span>
        <span class="account-name ellipsis" title="${attr([name, a.status.label, a.status.hint].filter(Boolean).join('\n'))}">${escapeHtml(name)}</span>
        <button class="icon-btn side-more" data-action="account-menu" data-key="${attr(accountKey(a))}" aria-haspopup="menu" aria-label="${attr(
          t('More for {account}', { account: name }),
        )}" title="${attr(t('More for {account}', { account: name }))}">${icon('more')}</button></div>`;
    })
    .join('');
  return `${head}<div class="account-rows">${rows}
    <button class="side-link account-add" data-action="add-account">${icon('plus')}<span>${escapeHtml(t('Add account'))}</span></button></div>`;
}

/** The … menu of one account row: check, sign in, sign out, and for a Claude Code profile, use it. */
export function accountMenuHtml(a: AccountView): string {
  const item = (action: string, glyph: string, label: string) =>
    `<button class="menu-item" role="menuitem" data-action="${action}" ${target(a)}>${icon(glyph)}<span>${escapeHtml(label)}</span></button>`;
  const useProfile = a.profile && !a.profile.chosen ? item('account-use-profile', 'check', t('Use this profile')) : '';
  return `${item('account-check', 'refresh', t('Check'))}
    ${item('account-login', 'arrow', t('Sign in…'))}
    ${item('account-logout', 'undo', t('Sign out…'))}
    ${useProfile ? `<hr>${useProfile}` : ''}
    <hr>${item('open-accounts', 'gear', t('All accounts…'))}`;
}

/** The Add account popup: which CLI, then the exact command and where the user signs in. */
export interface AddAccountState {
  /** The CLI picked (step two), with the Claude Code profile picked for it. */
  cli?: string;
  profile?: string;
}

export function addAccountHtml(accounts: readonly AccountView[], state: AddAccountState): string {
  const close = `<button class="btn" type="button" data-action="add-account-close">${escapeHtml(t('Cancel'))}</button>`;
  const picked = state.cli ? accounts.filter((a) => a.cli === state.cli && accountInstalled(a)) : [];
  if (picked.length) {
    const row = picked.find((a) => (a.profile?.id ?? '') === (state.profile ?? '')) ?? picked.find((a) => a.profile?.chosen) ?? picked[0];
    const profiles = row.profile
      ? `<div class="field"><span class="field-label">${escapeHtml(t('Profile'))}</span>
          <div class="pick-list" role="radiogroup" aria-label="${attr(t('Profile'))}">${picked
            .map(
              (a) =>
                `<button class="pick-item${a === row ? ' picked' : ''}" type="button" role="radio" aria-checked="${a === row}" data-action="add-account-pick" ${target(a)}>
                  <span class="account-pick-head"><span class="pick-label">${escapeHtml(a.profile!.name)}</span>${accountStateHtml(a)}</span>${
                    a.profile!.dir ? `<span class="muted small ellipsis">${escapeHtml(a.profile!.dir)}</span>` : ''
                  }</button>`,
            )
            .join('')}</div>
          <button class="link" type="button" data-action="add-claude-profile">${escapeHtml(t('New profile…'))}</button></div>`
      : '';
    const command = row.loginCommand || row.label;
    return `<div class="dialog modal add-account" role="dialog" aria-label="${attr(t('Sign in to {cli}', { cli: row.label }))}">
      <strong class="dialog-title">${escapeHtml(t('Sign in to {cli}', { cli: row.label }))}</strong>
      ${profiles}
      <div class="field"><span class="field-label">${escapeHtml(t('Command'))}</span><code class="mono account-command">${escapeHtml(command)}</code></div>
      <span class="muted">${escapeHtml(t("A terminal opens; finish the sign-in there or on the vendor's page. Orka never sees your password or token."))}</span>
      <div class="dialog-actions">
        <button class="btn" type="button" data-action="add-account-back">${escapeHtml(t('Back'))}</button>
        <button class="btn primary" type="button" data-action="account-login" ${target(row)}>${escapeHtml(t('Open terminal'))}</button>${close}</div>
    </div>`;
  }
  // One entry per CLI: Claude Code once, however many profiles it has.
  const seen = new Set<string>();
  const first = accounts.filter((a) => !seen.has(a.cli) && seen.add(a.cli));
  const installed = first.filter((a) => accounts.some((r) => r.cli === a.cli && accountInstalled(r)));
  const missing = first.filter((a) => !installed.includes(a));
  const list = installed.length
    ? installed
        .map(
          (a) => `<button class="pick-item account-pick" type="button" data-action="add-account-pick" data-cli="${attr(a.cli)}">
            <span class="account-pick-head"><span class="pick-label">${escapeHtml(a.label)}</span>${accountStateHtml(a)}</span>${detailHtml(a)}</button>`,
        )
        .join('')
    : `<span class="muted">${escapeHtml(t('No CLI is installed yet.'))}</span>`;
  const notInstalled = missing.length
    ? `<div class="account-missing"><span class="muted small">${escapeHtml(t('Not installed:'))}</span>${missing
        .map((a) => `<button class="link" type="button" data-action="install-cli" data-id="${attr(a.cli)}" title="${attr(t('Install {cli}', { cli: a.label }))}">${escapeHtml(a.label)}</button>`)
        .join('')}</div>`
    : '';
  return `<div class="dialog modal add-account" role="dialog" aria-label="${attr(t('Sign in with which CLI?'))}">
    <strong class="dialog-title">${escapeHtml(t('Sign in with which CLI?'))}</strong>
    <div class="pick-list">${list}</div>
    ${notInstalled}
    <div class="dialog-actions"><button class="btn" type="button" data-action="check-accounts">${icon('refresh')}${escapeHtml(t('Check all'))}</button>${close}</div>
  </div>`;
}

/**
 * Settings > Accounts: every CLI with its state and the vendor's commands, Install for a missing
 * one, and the Claude Code profiles.
 */
export function accountsTabHtml(accounts: readonly AccountView[]): string {
  const card = (a: AccountView) => {
    const ref = target(a);
    const name = accountName(a, accounts);
    const buttons =
      a.status.state === 'not_installed'
        ? `<button class="btn" data-action="install-cli" data-id="${attr(a.cli)}">${escapeHtml(t('Install…'))}</button>`
        : `<button class="btn" data-action="account-check" ${ref}>${escapeHtml(t('Check'))}</button>
          <button class="btn" data-action="account-login" ${ref} title="${attr(t('Opens {command} in a terminal; you sign in there, Orka never sees it.', { command: a.loginCommand || a.label }))}">${escapeHtml(
            t('Sign in…'),
          )}</button>
          <button class="btn" data-action="account-logout" ${ref} title="${attr(a.logoutCommand ?? a.logoutHint ?? '')}">${escapeHtml(t('Sign out…'))}</button>`;
    // Claude Code with more than one profile: the one in use is marked, the others can be picked.
    const several = !!a.profile && accounts.filter((r) => r.profile).length > 1;
    const inUse = several && a.profile!.chosen ? `<span class="tag">${escapeHtml(t('in use'))}</span>` : '';
    const use = several && !a.profile!.chosen ? `<button class="btn" data-action="account-use-profile" ${ref}>${escapeHtml(t('Use this profile'))}</button>` : '';
    const remove = a.profile?.id ? `<button class="btn danger-outline" data-action="remove-claude-profile" ${ref}>${escapeHtml(t('Remove'))}</button>` : '';
    return `<div class="card account-card" ${ref}>
      <div class="card-head"><strong class="ellipsis">${escapeHtml(name)}</strong>${inUse}<span class="spacer"></span>${accountStateHtml(a)}</div>
      ${detailHtml(a)}
      ${a.profile?.dir ? `<span class="muted small mono ellipsis" title="${attr(a.profile.dir)}">CLAUDE_CONFIG_DIR=${escapeHtml(a.profile.dir)}</span>` : ''}
      <div class="key-row">${buttons}${use}${remove}</div>
    </div>`;
  };
  return `<div class="section"><strong class="section-title">${escapeHtml(t('Accounts'))}</strong>
      <span class="muted small">${escapeHtml(
        t("Each CLI signs in with its own command, in a terminal you can see. Orka asks only the CLI's own status command and never reads or stores a sign-in."),
      )}</span></div>
    <div class="key-row">
      <button class="btn primary" data-action="add-account">${icon('plus')}${escapeHtml(t('Add account'))}</button>
      <button class="btn" data-action="check-accounts">${icon('refresh')}${escapeHtml(t('Check all'))}</button>
    </div>
    ${accounts.map(card).join('')}
    <div class="card"><div class="card-head"><strong>${escapeHtml(t('Claude Code profiles'))}</strong></div>
      <div class="card-text">${escapeHtml(
        t('A profile is its own Claude Code sign-in, kept by Claude Code in its own folder (CLAUDE_CONFIG_DIR). One profile runs at a time; you pick it here.'),
      )}</div>
      <div class="muted small">${escapeHtml(t("Separate accounts are for separate work, such as work and personal. Using them to get around a usage limit may break the vendor's terms."))}</div>
      <button class="btn" data-action="add-claude-profile">${icon('plus')}${escapeHtml(t('Add profile'))}</button>
    </div>`;
}
