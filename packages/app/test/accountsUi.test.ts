import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountView } from '../src/protocol';
import { accountMenuHtml, accountsCount, accountsEntryHtml, accountsTabHtml, addAccountHtml } from '../webview/features/accounts';
import { sidebarFrame } from '../webview/ide/sidebar';

const row = (cli: string, label: string, state: AccountView['status']['state'], patch: Partial<AccountView> = {}): AccountView => ({
  cli,
  label,
  status: { state },
  loginCommand: `${cli} login`,
  logoutCommand: `${cli} logout`,
  installable: true,
  ...patch,
});

const claude = (id: string, name: string, state: AccountView['status']['state'], chosen: boolean, label?: string) =>
  row('claude-code', 'Claude Code', state, {
    profile: { id, name, dir: id ? `C:/Users/you/.claude-${id}` : '', chosen },
    status: { state, label },
    loginCommand: 'claude auth login',
  });

const accounts = (): AccountView[] => [
  claude('', 'Default profile', 'signed_in', true, 'you@example.com <img src=x onerror=alert(1)>'),
  claude('work', 'Work', 'signed_out', false),
  row('codex', 'Codex (codex-acp)', 'not_installed'),
  row('copilot', 'GitHub Copilot CLI', 'unknown', { status: { state: 'unknown', hint: 'type /user' } }),
];

/** The part of the html from the element with this attribute to the next one like it. */
const after = (html: string, marker: string) => html.slice(html.indexOf(marker));

describe('accounts in the sidebar', () => {
  it('has a slot in the footer and in the rail', () => {
    const frame = sidebarFrame('logo.svg');
    assert.ok(frame.includes('id="side-accounts"'));
    assert.ok(frame.includes('id="rail-accounts"'));
  });

  it('counts signed-in out of installed only once a status command answered', () => {
    assert.equal(accountsCount(accounts().map((a) => ({ ...a, status: { state: 'unknown' as const } }))), undefined);
    assert.deepEqual(accountsCount(accounts()), { signedIn: 1, installed: 3 });
    const closed = accountsEntryHtml('list', accounts(), false);
    assert.ok(closed.includes('1/3'));
    assert.ok(closed.includes('aria-expanded="false"'));
    assert.ok(!closed.includes('account-row'), 'folded: one row');
  });

  it('folds open to the installed accounts, each with its menu, then Add account', () => {
    const html = accountsEntryHtml('list', accounts(), true);
    assert.equal((html.match(/class="account-row"/g) ?? []).length, 3, 'Codex is not installed');
    assert.ok(!html.includes('Codex'));
    assert.ok(html.includes('Claude Code · Default profile') && html.includes('Claude Code · Work'));
    assert.ok(html.includes('data-action="account-menu" data-key="claude-code:work"'));
    assert.ok(html.includes('data-action="add-account"'));
    assert.ok(!html.includes('<img'), 'what a status command said is escaped');
  });

  it('names Claude Code alone while it has only the default profile', () => {
    const html = accountsEntryHtml('list', [claude('', 'Default profile', 'signed_in', true)], true);
    assert.ok(html.includes('>Claude Code<'));
    assert.ok(!html.includes('Default profile<'));
  });

  it('opens the Add account popup from the rail', () => {
    assert.match(accountsEntryHtml('rail', accounts(), false), /data-action="add-account"/);
  });

  it("offers Use this profile only on a profile that is not in use", () => {
    const [def, work, , copilot] = accounts();
    assert.ok(!accountMenuHtml(def).includes('account-use-profile'));
    assert.match(accountMenuHtml(work), /data-action="account-use-profile" data-cli="claude-code" data-profile="work"/);
    assert.ok(!accountMenuHtml(copilot).includes('account-use-profile'));
    assert.match(accountMenuHtml(copilot), /data-action="account-login" data-cli="copilot"/);
  });
});

describe('Add account popup', () => {
  it('lists installed CLIs once each, and the missing ones with Install', () => {
    const html = addAccountHtml(accounts(), {});
    assert.equal((html.match(/data-action="add-account-pick" data-cli="claude-code"/g) ?? []).length, 1, 'Claude Code once, whatever its profiles');
    assert.ok(html.includes('data-action="add-account-pick" data-cli="copilot"'));
    assert.ok(!html.includes('data-action="add-account-pick" data-cli="codex"'));
    assert.match(after(html, 'Not installed:'), /data-action="install-cli" data-id="codex"/);
    assert.ok(!html.includes('<img'));
  });

  it('shows the exact command; for Claude Code, the profile it signs in to', () => {
    const html = addAccountHtml(accounts(), { cli: 'claude-code', profile: 'work' });
    assert.ok(html.includes('claude auth login'));
    assert.match(html, /class="pick-item picked"[^>]*data-profile="work"/);
    assert.match(html, /data-action="account-login" data-cli="claude-code" data-profile="work"/);
    assert.ok(html.includes('data-action="add-claude-profile"'));
    assert.ok(html.includes('Orka never sees your password or token.'));
  });

  it('starts on the profile in use, and other CLIs have no profile field', () => {
    assert.match(addAccountHtml(accounts(), { cli: 'claude-code' }), /data-action="account-login" data-cli="claude-code">/);
    const copilot = addAccountHtml(accounts(), { cli: 'copilot' });
    assert.ok(copilot.includes('copilot login'));
    assert.ok(!copilot.includes('data-profile'));
    assert.ok(!copilot.includes('add-claude-profile'));
  });

  it('goes back to the list for a CLI that is not installed', () => {
    assert.ok(addAccountHtml(accounts(), { cli: 'codex' }).includes('Sign in with which CLI?'));
  });
});

describe('Settings > Accounts', () => {
  it('shows each account with the vendor commands, and only Install for a missing CLI', () => {
    const html = accountsTabHtml(accounts());
    const codex = html.slice(html.indexOf('data-cli="codex"'), html.indexOf('data-cli="copilot"'));
    assert.ok(codex.includes('data-action="install-cli" data-id="codex"'));
    assert.ok(!codex.includes('account-login'));
    assert.match(html, /data-action="account-logout" data-cli="copilot"[^>]*title="copilot logout"/);
    assert.ok(html.includes('CLAUDE_CONFIG_DIR=C:/Users/you/.claude-work'));
    assert.ok(html.includes('data-action="add-claude-profile"'));
  });

  it('marks the profile in use, and removes only an added profile', () => {
    const html = accountsTabHtml(accounts());
    assert.equal((html.match(/data-action="remove-claude-profile"/g) ?? []).length, 1);
    assert.match(html, /data-action="remove-claude-profile" data-cli="claude-code" data-profile="work"/);
    assert.equal((html.match(/>new sessions</g) ?? []).length, 1);
    assert.equal((html.match(/data-action="account-use-profile"/g) ?? []).length, 1);
    // One profile only: nothing to choose between.
    const single = accountsTabHtml([claude('', 'Default profile', 'signed_in', true)]);
    assert.ok(!single.includes('>new sessions<') && !single.includes('account-use-profile'));
  });
});
