import assert from 'node:assert/strict';
// The module object itself (an ES namespace import cannot be patched): the bundled app code reads through it.
const fs = require('node:fs') as typeof import('node:fs');
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ACCOUNT_CLIS, ACCOUNT_COMMANDS, copilotTokenVariable, parseStatus, type ProbeOutput, profileId, runProbe } from '../src/accounts';
import { AppController } from '../src/AppController';
import type { AccountView } from '../src/protocol';
import { MACHINE_SETTINGS } from '../src/settings';
import { FakeShell } from './fakeShell';

const REAL_HOME = homedir();
const APP_SRC = path.resolve(__dirname, '../../src');

let home: string;
let bin: string;
let controllers: AppController[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['PATH', 'Path', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-accounts-test-'));
  bin = path.join(home, 'bin');
  for (const dir of [bin, path.join(home, 'work', 'alpha'), path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  // Fake vendor programs on PATH (never run: the probe and the terminal are fakes).
  for (const name of ['codex', 'copilot', 'cursor-agent', 'claude']) writeFileSync(path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name), '');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PATH = bin;
  if (process.platform === 'win32') process.env.Path = bin;
  process.env.LOCALAPPDATA = path.join(home, 'local');
  // os.homedir() follows these: profile folders go to the test's home, never the real one.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const k of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[k];
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // Windows holds the folder while a program check started there (cwd: the home folder) winds down.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(home, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt >= 50 || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

type Call = { file: string; args: readonly string[]; env: Record<string, string> };

async function start(settings: Record<string, unknown> = {}, answer: (call: Call) => ProbeOutput = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls: Call[] = [];
  const shell = new FakeShell('desktop', home, [path.join(home, 'work', 'alpha')], { 'claudeCode.path': path.join(bin, 'claude.cmd'), ...settings });
  const controller = new AppController(shell, {
    probe: async (file, args, env) => {
      const call = { file, args, env };
      calls.push(call);
      return answer(call);
    },
  });
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller, calls };
}

const accounts = (shell: FakeShell): AccountView[] => shell.last('config')?.config.accounts ?? [];
const notices = (shell: FakeShell) => shell.posted.flatMap((m) => (m.type === 'event' && m.event.type === 'notice' ? [m.event] : []));
const base = (file: string) => path.basename(file).replace(/\.cmd$/i, '');

describe('account status commands', () => {
  it("reads Claude Code's JSON: signed in, signed out (exit 1), and anything else as unknown", () => {
    const json = (o: unknown, code = 0) => ({ code, stdout: JSON.stringify(o), stderr: '' });
    assert.deepEqual(parseStatus('claude-code', json({ loggedIn: true, email: 'a@b.c', authMethod: 'claude.ai', subscriptionType: 'max' })), {
      state: 'signed_in',
      label: 'a@b.c · claude.ai (max)',
    });
    assert.deepEqual(parseStatus('claude-code', json({ loggedIn: true, authMethod: 'api_key' })), { state: 'signed_in', label: 'api_key' });
    assert.deepEqual(parseStatus('claude-code', json({ loggedIn: false }, 1)), { state: 'signed_out' });
    assert.deepEqual(parseStatus('claude-code', { code: 1, stdout: '', stderr: 'error: unknown command "auth"' }), { state: 'unknown', label: 'error: unknown command "auth"' });
  });

  it('reads Codex and Cursor by exit code and wording, shows one line, and never guesses', () => {
    assert.deepEqual(parseStatus('codex', { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }), { state: 'signed_in', label: 'Logged in using ChatGPT' });
    assert.deepEqual(parseStatus('codex', { code: 1, stdout: '', stderr: 'Not logged in' }), { state: 'signed_out', label: 'Not logged in' });
    assert.equal(parseStatus('codex', { code: 2, stdout: '', stderr: 'boom' }).state, 'unknown');
    assert.deepEqual(parseStatus('cursor', { code: 0, stdout: '✓ Logged in as a@b.c', stderr: '' }), { state: 'signed_in', label: '✓ Logged in as a@b.c' });
    assert.equal(parseStatus('cursor', { code: 1, stdout: 'Not logged in', stderr: '' }).state, 'signed_out');
    assert.equal(parseStatus('cursor', { code: 0, stdout: '{}', stderr: '' }).state, 'unknown');
    assert.equal(parseStatus('codex', { code: 0, stdout: `${'x'.repeat(500)}\nsecond`, stderr: '' }).label?.length, 160);
  });

  it('reads "agy models": model lines mean signed in (only their count is kept), a failure means signed out', () => {
    const listed = { code: 0, stdout: 'Fetching available models...\r\ngemini-3-pro\tGemini 3 Pro\r\ngemini-3-flash\tGemini 3 Flash\r\n', stderr: '' };
    assert.deepEqual(parseStatus('antigravity', listed), { state: 'signed_in', label: 'Signed in (2 models available)' });
    assert.deepEqual(parseStatus('antigravity', { code: 0, stdout: 'Fetching available models...\na\tA\n', stderr: '' }), { state: 'signed_in', label: 'Signed in (1 model available)' });
    assert.doesNotMatch(JSON.stringify(parseStatus('antigravity', listed)), /gemini-3|Gemini 3/, 'the model list is not kept');

    const hint = 'Sign in by running agy in a terminal (Sign in… opens it).';
    assert.deepEqual(parseStatus('antigravity', { code: 1, stdout: 'Fetching available models...\n', stderr: '\u001b[31mError: not signed in\u001b[0m\n' }), {
      state: 'signed_out',
      label: 'Error: not signed in',
      hint,
    });
    // Exit 0 without a model line, or a long first line: signed out, and no line shown.
    assert.deepEqual(parseStatus('antigravity', { code: 0, stdout: 'Fetching available models...\n', stderr: '' }), { state: 'signed_out', label: undefined, hint });
    assert.deepEqual(parseStatus('antigravity', { code: 2, stdout: `${'x'.repeat(200)}\n`, stderr: '' }), { state: 'signed_out', label: undefined, hint });
    // A program that could not start, or did not answer: unknown, as before.
    assert.equal(parseStatus('antigravity', { code: null, stdout: '', stderr: 'spawn agy ENOENT' }).state, 'unknown');
    assert.equal(parseStatus('antigravity', { code: null, stdout: '', stderr: '', timedOut: true }).state, 'unknown');
    // Gemini CLI has no such command.
    assert.equal(ACCOUNT_COMMANDS.gemini.status, undefined);
  });

  it('turns a status command that does not answer in time into unknown', () => {
    const status = parseStatus('claude-code', { code: null, stdout: '', stderr: '', timedOut: true });
    assert.equal(status.state, 'unknown');
    assert.match(status.label ?? '', /did not answer within 15 seconds/);
  });

  it('runs the program with the extra environment, in the home folder', async () => {
    const dir = path.join(home, '.claude-work');
    const out = await runProbe(process.execPath, ['-e', 'console.log(process.env.CLAUDE_CONFIG_DIR + "|" + process.cwd())'], { CLAUDE_CONFIG_DIR: dir });
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim().toLowerCase(), `${dir}|${homedir()}`.toLowerCase());
  });

  it("names the GitHub token variable Copilot CLI would use, never its value", () => {
    assert.equal(copilotTokenVariable({}), undefined);
    assert.equal(copilotTokenVariable({ GITHUB_TOKEN: 'x', GH_TOKEN: 'y' }), 'GH_TOKEN');
    assert.equal(copilotTokenVariable({ COPILOT_GITHUB_TOKEN: 'z', GH_TOKEN: 'y' }), 'COPILOT_GITHUB_TOKEN');
  });

  it('are the commands the vendors document, and their hints are translated', async () => {
    assert.deepEqual(Object.fromEntries(ACCOUNT_CLIS.map((cli) => [cli, [ACCOUNT_COMMANDS[cli].status, ACCOUNT_COMMANDS[cli].login, ACCOUNT_COMMANDS[cli].logout]])), {
      'claude-code': [['auth', 'status'], ['auth', 'login'], ['auth', 'logout']],
      antigravity: [['models'], [], undefined],
      codex: [['login', 'status'], ['login'], ['logout']],
      copilot: [undefined, ['login'], undefined],
      cursor: [['status'], ['login'], ['logout']],
      gemini: [undefined, [], undefined],
    });
    const { TR } = await import('../../core/src/i18n/tr');
    for (const cli of ACCOUNT_CLIS) {
      const hint = ACCOUNT_COMMANDS[cli].logoutHint;
      if (hint) assert.ok(TR[hint], `missing Turkish translation for: ${hint}`);
    }
    assert.ok(TR["Separate accounts are for separate work, such as work and personal. Using them to get around a usage limit may break the vendor's terms."]);
  });
});

describe('Settings > Accounts', () => {
  it("asks each installed CLI's own status command once, by its full path, and lists what it said", async () => {
    const { shell, controller, calls } = await start({}, (call) =>
      base(call.file) === 'claude' ? { code: 0, stdout: '{"loggedIn":true,"email":"me@x.y"}', stderr: '' } : { code: 1, stdout: '', stderr: 'Not logged in' },
    );
    await controller.handleMessage({ type: 'checkAccounts' });
    assert.deepEqual(
      calls.map((c) => [base(c.file), c.args.join(' '), c.env]).sort(),
      [
        ['claude', 'auth status', {}],
        ['codex', 'login status', {}],
        ['cursor-agent', 'status', {}],
      ],
    );
    for (const call of calls) assert.ok(path.isAbsolute(call.file));
    const rows = accounts(shell);
    const byCli = Object.fromEntries(rows.map((r) => [r.cli, r]));
    assert.deepEqual(byCli['claude-code'].status, { state: 'signed_in', label: 'me@x.y' });
    assert.deepEqual(byCli['claude-code'].profile, { id: '', name: 'Default profile', dir: '', chosen: true });
    assert.equal(byCli.codex.status.state, 'signed_out');
    assert.equal(byCli.copilot.status.state, 'unknown');
    assert.match(byCli.copilot.status.hint ?? '', /type \/user/);
    assert.equal(byCli.antigravity.status.state, 'not_installed');
    assert.equal(byCli.gemini.status.state, 'not_installed');
    assert.deepEqual([byCli.codex.loginCommand, byCli.codex.logoutCommand, byCli.codex.installable], ['codex login', 'codex logout', true]);
    assert.deepEqual([byCli['claude-code'].loginCommand, byCli.copilot.logoutCommand, byCli.copilot.installable], ['claude auth login', undefined, false]);
  });

  it('says when a GitHub token variable stands in for Copilot CLI\'s sign-in', async () => {
    process.env.GH_TOKEN = 'secret-value';
    const { shell, controller } = await start();
    await controller.handleMessage({ type: 'checkAccount', cli: 'copilot' });
    const row = accounts(shell).find((r) => r.cli === 'copilot')!;
    assert.match(row.status.label ?? '', /^GH_TOKEN is set/);
    assert.doesNotMatch(JSON.stringify(shell.posted), /secret-value/);
  });

  it('runs only known CLIs and profiles: any other id does nothing', async () => {
    const { shell, controller, calls } = await start();
    shell.answer = 'Sign out';
    for (const cli of ['claude', 'codex; calc', '../codex', 'custom:mine', '']) {
      await controller.handleMessage({ type: 'checkAccount', cli });
      await controller.handleMessage({ type: 'loginAccount', cli });
      await controller.handleMessage({ type: 'logoutAccount', cli });
    }
    await controller.handleMessage({ type: 'loginAccount', cli: 'claude-code', profile: 'nope' });
    await controller.handleMessage({ type: 'loginAccount', cli: 'codex', profile: 'work' });
    assert.deepEqual([calls.length, shell.terminals.length, shell.asked.length], [0, 0, 0]);
  });

  it("signs in and out with the vendor's own command, in a terminal the user sees, and checks again when it closes", async () => {
    const { shell, controller, calls } = await start();
    await controller.handleMessage({ type: 'loginAccount', cli: 'codex' });
    const [login] = shell.terminals;
    assert.deepEqual([base((login.command as { file: string }).file), (login.command as { args: readonly string[] }).args, login.cwd, login.env, login.shown], ['codex', ['login'], homedir(), undefined, true]);
    login.onClose!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.map((c) => c.args.join(' ')), ['login status']);

    await controller.handleMessage({ type: 'logoutAccount', cli: 'codex' });
    assert.equal(shell.terminals.length, 1, 'sign-out asks first');
    assert.equal(shell.asked.at(-1)?.text, 'Sign out of Codex (codex-acp)?');
    shell.answer = 'Sign out';
    await controller.handleMessage({ type: 'logoutAccount', cli: 'codex' });
    assert.deepEqual((shell.terminals[1].command as { args: readonly string[] }).args, ['logout']);

    // Copilot signs out inside the CLI: Orka opens it and says what to type.
    await controller.handleMessage({ type: 'logoutAccount', cli: 'copilot' });
    assert.deepEqual((shell.terminals[2].command as { args: readonly string[] }).args, []);
    assert.match(notices(shell).at(-1)?.message ?? '', /Type \/logout in Copilot CLI/);
  });

  it('asks an installed agy for its models, by its full path in the home folder, and shows the count', async () => {
    writeFileSync(path.join(bin, process.platform === 'win32' ? 'agy.cmd' : 'agy'), '');
    const { shell, controller, calls } = await start({}, (call) =>
      base(call.file) === 'agy' ? { code: 0, stdout: 'Fetching available models...\nm1\tModel One\nm2\tModel Two\nm3\tModel Three\n', stderr: '' } : { code: 1, stdout: '', stderr: '' },
    );
    await controller.handleMessage({ type: 'checkAccount', cli: 'antigravity' });
    assert.deepEqual(calls.map((c) => [base(c.file), c.args.join(' '), c.env]), [['agy', 'models', {}]]);
    assert.ok(path.isAbsolute(calls[0].file));
    assert.deepEqual(accounts(shell).find((r) => r.cli === 'antigravity')?.status, { state: 'signed_in', label: 'Signed in (3 models available)' });
    assert.doesNotMatch(JSON.stringify(shell.posted), /Model One/);
  });

  it('keeps the update hint for agy older than 1.5.0, without running it', async () => {
    writeFileSync(path.join(bin, process.platform === 'win32' ? 'agy.cmd' : 'agy'), '');
    const { shell, controller, calls } = await start();
    const agentStatus = (controller as unknown as { agentStatus: Map<string, { state: string; version?: string }> }).agentStatus;
    agentStatus.set('antigravity', { state: 'error', version: '1.4.7' });
    await controller.handleMessage({ type: 'checkAccount', cli: 'antigravity' });
    assert.equal(calls.length, 0);
    const status = accounts(shell).find((r) => r.cli === 'antigravity')?.status;
    assert.equal(status?.state, 'unknown');
    assert.match(status?.hint ?? '', /1\.4\.7 has no ACP mode yet; version 1\.5\.0 or newer is needed\. Update it with "agy update"/);
  });

  it('points to the installer when the CLI is not there', async () => {
    const { shell, controller } = await start();
    await controller.handleMessage({ type: 'loginAccount', cli: 'antigravity' });
    assert.equal(shell.terminals.length, 0);
    assert.deepEqual([notices(shell).at(-1)?.message, notices(shell).at(-1)?.action], ['Antigravity CLI is not installed. Install it first, then sign in.', 'install:antigravity']);
  });
});

describe('Claude Code profiles', () => {
  it('adds a profile folder (empty, made by Orka), signs in with CLAUDE_CONFIG_DIR, and runs on it only once chosen', async () => {
    const { shell, controller, calls } = await start();
    shell.inputAnswer = 'Work (ACME)';
    shell.answer = 'Sign in';
    await controller.handleMessage({ type: 'addClaudeProfile' });
    assert.match(shell.inputs.at(-1)?.prompt ?? '', /get around a usage limit may break the vendor's terms/);
    const dir = path.join(home, '.claude-work-acme');
    assert.ok(statSync(dir).isDirectory());
    assert.deepEqual(readdirSync(dir), [], 'Orka writes nothing into it');
    assert.deepEqual(shell.settings.data['accounts.claudeProfiles'], [{ id: 'work-acme', name: 'Work (ACME)', dir }]);
    const [login] = shell.terminals;
    assert.deepEqual([base((login.command as { file: string }).file), (login.command as { args: readonly string[] }).args, login.env], ['claude', ['auth', 'login'], { CLAUDE_CONFIG_DIR: dir }]);

    await controller.handleMessage({ type: 'checkAccount', cli: 'claude-code', profile: 'work-acme' });
    await controller.handleMessage({ type: 'checkAccount', cli: 'claude-code' });
    assert.deepEqual(calls.map((c) => c.env), [{ CLAUDE_CONFIG_DIR: dir }, {}], 'the variable only for the profile');

    const config = (controller as unknown as { providerConfig(ref: string, model: string): { configDir?: string } }).providerConfig.bind(controller);
    shell.settings.data['claudeCode.enabled'] = true;
    await shell.settings.update('claudeCode.enabled', true);
    assert.equal(config('claude-code', 'default').configDir, undefined, 'the default profile until one is chosen');
    await controller.handleMessage({ type: 'setClaudeProfile', id: 'work-acme' });
    assert.equal(config('claude-code', 'default').configDir, dir);
    assert.equal(accounts(shell).find((r) => r.profile?.id === 'work-acme')?.profile?.chosen, true);
    await controller.handleMessage({ type: 'setClaudeProfile', id: 'missing' });
    assert.equal(shell.settings.data['accounts.claudeProfile'], 'work-acme', 'an unknown profile is ignored');
  });

  it('refuses a name it already has, and forgets a removed profile but leaves its folder', async () => {
    const { shell, controller } = await start();
    shell.answer = 'Add profile';
    await controller.handleMessage({ type: 'addClaudeProfile', name: 'Work' });
    assert.match(shell.asked.find((a) => a.text.startsWith('Add the Claude Code profile'))?.detail ?? '', /usage limit/);
    await controller.handleMessage({ type: 'addClaudeProfile', name: 'work' });
    assert.equal((shell.settings.data['accounts.claudeProfiles'] as unknown[]).length, 1);
    await controller.handleMessage({ type: 'setClaudeProfile', id: 'work' });
    shell.answer = 'Remove';
    await controller.handleMessage({ type: 'removeClaudeProfile', id: 'work' });
    assert.deepEqual([shell.settings.data['accounts.claudeProfiles'], shell.settings.data['accounts.claudeProfile']], [[], '']);
    assert.ok(existsSync(path.join(home, '.claude-work')), 'the folder (and its sign-in) stays');
  });

  it('holds the chosen profile in the run gate only when a role runs on Claude Code', async () => {
    const { shell, controller } = await start({ provider: 'claude', 'claudeCode.enabled': true });
    const runAccounts = () => (controller as unknown as { runAccounts(): string[] }).runAccounts();
    assert.deepEqual(runAccounts(), []);
    await shell.settings.update('provider', 'claude-code');
    assert.deepEqual(runAccounts(), ['claude-code:']);
    await shell.settings.update('accounts.claudeProfiles', [{ id: 'work', name: 'Work', dir: path.join(home, '.claude-work') }]);
    await shell.settings.update('accounts.claudeProfile', 'work');
    assert.deepEqual(runAccounts(), ['claude-code:work']);
  });

  it('gives profile ids from names, and keeps profiles in machine settings only', () => {
    assert.deepEqual(['Work (ACME)', '  Personal  ', '---', 'a'.repeat(60)].map(profileId), ['work-acme', 'personal', '', 'a'.repeat(40)]);
    assert.ok(MACHINE_SETTINGS.has('accounts.claudeProfiles') && MACHINE_SETTINGS.has('accounts.claudeProfile'));
  });

  it('declares every machine setting in the VS Code extension as a machine setting (VS Code refuses to write an undeclared one)', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../vscode-extension/package.json'), 'utf8'));
    const properties: Record<string, { scope?: string }> = Object.assign({}, ...[manifest.contributes.configuration].flat().map((c: { properties: object }) => c.properties));
    const nls = JSON.parse(readFileSync(path.resolve(__dirname, '../../../vscode-extension/package.nls.tr.json'), 'utf8'));
    for (const key of ['accounts.claudeProfiles', 'accounts.claudeProfile']) {
      assert.equal(properties[`orka.${key}`]?.scope, 'machine', key);
      assert.ok(nls[`config.${key}`], `${key} has a Turkish description`);
    }
    for (const key of MACHINE_SETTINGS) assert.ok(properties[`orka.${key}`], `orka.${key} is declared`);
  });
});

describe('accounts: compliance', () => {
  it('never reads a vendor credential file or folder while checking, signing in, adding or choosing profiles', async () => {
    const forbidden = [REAL_HOME, home].flatMap((h) => ['.claude', '.codex', '.copilot', '.gemini', '.cursor', path.join('.config', 'github-copilot')].map((d) => path.join(h, d).toLowerCase()));
    const touches = (p: unknown) => {
      if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
      const full = path.resolve(String(p)).toLowerCase();
      // ~/.claude itself, and every profile folder ~/.claude-<id>.
      return forbidden.some((f) => full === f || full.startsWith(f + path.sep) || (full.startsWith(f + '-') && f.endsWith('.claude')));
    };
    const reads: string[] = [];
    const spied: Array<[Record<string, unknown>, string]> = [
      [fs as unknown as Record<string, unknown>, 'readFileSync'],
      [fs as unknown as Record<string, unknown>, 'readFile'],
      [fs as unknown as Record<string, unknown>, 'openSync'],
      [fs as unknown as Record<string, unknown>, 'open'],
      [fs as unknown as Record<string, unknown>, 'createReadStream'],
      [fs as unknown as Record<string, unknown>, 'readdirSync'],
      [fs.promises as unknown as Record<string, unknown>, 'readFile'],
      [fs.promises as unknown as Record<string, unknown>, 'open'],
      [fs.promises as unknown as Record<string, unknown>, 'readdir'],
    ];
    const originals = spied.map(([object, name]) => object[name] as (...args: unknown[]) => unknown);
    spied.forEach(([object, name], i) => {
      object[name] = (...args: unknown[]) => {
        if (touches(args[0])) reads.push(`${name} ${String(args[0])}`);
        return originals[i].apply(object, args);
      };
    });
    try {
      const { shell, controller } = await start({ 'claudeCode.enabled': true }, () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: '' }));
      shell.inputAnswer = 'Work';
      shell.answer = 'Sign in';
      await controller.handleMessage({ type: 'addClaudeProfile' });
      await controller.handleMessage({ type: 'setClaudeProfile', id: 'work' });
      await controller.handleMessage({ type: 'checkAccounts' });
      for (const cli of ACCOUNT_CLIS) await controller.handleMessage({ type: 'loginAccount', cli });
      await controller.handleMessage({ type: 'loginAccount', cli: 'claude-code', profile: 'work' });
      for (const terminal of shell.terminals) terminal.onClose?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(shell.terminals.length >= 4);
    } finally {
      spied.forEach(([object, name], i) => (object[name] = originals[i]));
    }
    assert.deepEqual(reads, []);
  });

  it('the app code never names a vendor credential file, and no usage-limit path changes the profile', () => {
    const files = walk(APP_SRC).filter((f) => f.endsWith('.ts'));
    const forbidden = [/\.credentials\.json/i, /oauth_creds/i, /auth\.json/i, /hosts\.yml/i, /\.codex[\\/]/i, /\.gemini[\\/]/i, /\.copilot[\\/]/i, /\.cursor[\\/]/i, /keytar|credential-manager/i];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${path.relative(APP_SRC, file)} mentions ${pattern}`);
    }
    // The profile changes only where the user picks or removes it (or saves a session's as the
    // default); sessions (and their usage-limit handling, fallback and notices) never touch it.
    const controller = readFileSync(path.join(APP_SRC, 'AppController.ts'), 'utf8');
    assert.equal(controller.match(/updateSetting\('accounts\.claudeProfile'/g)?.length, 3);
    // A session sets its own choice only when it starts and when it opens a saved task.
    assert.equal(readFileSync(path.join(APP_SRC, 'SessionController.ts'), 'utf8').match(/this\.choice =/g)?.length, 2);
    for (const name of ['SessionController.ts', 'runGate.ts']) assert.doesNotMatch(readFileSync(path.join(APP_SRC, name), 'utf8'), /claudeProfile|setClaudeProfile|CLAUDE_CONFIG_DIR/);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
