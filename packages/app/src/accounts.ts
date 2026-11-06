import { childEnv, killTree, resolveCommand, t, tn } from '@orka/core';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

/**
 * Which account each CLI is signed in with, as the CLI itself reports it. Orka asks only the
 * vendor's own status command (when there is one) and shows its answer; it never reads a vendor's
 * credential files, keychain entries or tokens, never stores what the command printed (it stays
 * in memory for the settings), and never signs in itself: sign-in and sign-out run the vendor's
 * own command in a terminal the user types into.
 */
export const ACCOUNT_CLIS = ['claude-code', 'antigravity', 'codex', 'copilot', 'cursor', 'gemini'] as const;
export type AccountCli = (typeof ACCOUNT_CLIS)[number];

export function isAccountCli(value: unknown): value is AccountCli {
  return typeof value === 'string' && (ACCOUNT_CLIS as readonly string[]).includes(value);
}

export interface AccountStatus {
  state: 'checking' | 'signed_in' | 'signed_out' | 'unknown' | 'not_installed';
  /** What the status command said, one line (an email, the sign-in method), kept in memory only. */
  label?: string;
  /** What the user can do instead when the CLI has no status command. */
  hint?: string;
}

/** The vendor commands for one CLI: its status (when it has one), sign-in and sign-out, as arguments of its own program. */
export interface AccountCommands {
  status?: readonly string[];
  login: readonly string[];
  /** Undefined: the CLI signs out from inside its own session (hint). */
  logout?: readonly string[];
  /** For a CLI without a sign-out command: what to type in it (English key for t()). */
  logoutHint?: string;
}

/**
 * Each CLI's commands, as its vendor documents them (November 2026): code.claude.com
 * authentication ("claude auth status|login|logout"), the Codex CLI reference ("codex login
 * status", "codex login", "codex logout"), Cursor's CLI authentication page ("agent status|login|
 * logout"), GitHub's "Authenticate Copilot CLI" ("copilot login"; /user and /logout inside the
 * CLI). Antigravity CLI has no status command either, but "agy models" (agy 1.5.0 and newer)
 * lists the models of the signed-in account and fails without a sign-in; it prints no account
 * name. Gemini CLI documents nothing: sign-in is a choice inside the interactive CLI.
 */
export const ACCOUNT_COMMANDS: Record<AccountCli, AccountCommands> = {
  'claude-code': { status: ['auth', 'status'], login: ['auth', 'login'], logout: ['auth', 'logout'] },
  codex: { status: ['login', 'status'], login: ['login'], logout: ['logout'] },
  cursor: { status: ['status'], login: ['login'], logout: ['logout'] },
  copilot: { login: ['login'], logoutHint: 'Type /logout in Copilot CLI to sign out; /user shows the account.' },
  antigravity: { status: ['models'], login: [], logoutHint: 'Sign out inside agy (see its docs).' },
  gemini: { login: [], logoutHint: 'Sign out inside Gemini CLI (see its docs).' },
};

/** What a status command printed, and how it ended. */
export interface ProbeOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Runs a status command: the program by its full path, with its arguments and extra environment. */
export type ProbeRunner = (file: string, args: readonly string[], env: Record<string, string>) => Promise<ProbeOutput>;

/** The longest a status command may take. */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * The real runner: in the home folder (nothing in a project can stand in for a program a shim
 * starts), with Orka's environment plus `env`, cut off after PROBE_TIMEOUT_MS.
 */
export const runProbe: ProbeRunner = (file, args, extra) => {
  const { file: program, args: argv, shell } = resolveCommand(file, [...args]);
  const env = childEnv({ ...process.env, ...extra });
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (output: ProbeOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    const child = spawn(program, argv, { cwd: homedir(), env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      killTree(child.pid);
      done({ code: null, stdout, stderr, timedOut: true });
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (data: Buffer) => (stdout = (stdout + data.toString('utf8')).slice(-20_000)));
    child.stderr.on('data', (data: Buffer) => (stderr = (stderr + data.toString('utf8')).slice(-20_000)));
    child.on('error', (error) => done({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
};

/** What a CLI's status command printed, as a status. */
export function parseStatus(cli: AccountCli, output: ProbeOutput): AccountStatus {
  if (output.timedOut) return { state: 'unknown', label: t('The status command did not answer within {n} seconds.', { n: PROBE_TIMEOUT_MS / 1000 }) };
  const text = `${output.stdout}\n${output.stderr}`;
  const line = firstLine(text);
  switch (cli) {
    case 'claude-code': {
      // JSON: {"loggedIn": true, "email": ..., "authMethod": ..., "subscriptionType": ...}; exit 1 when signed out.
      let auth: { loggedIn?: unknown; email?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined;
      try {
        const parsed: unknown = JSON.parse(output.stdout);
        if (parsed && typeof parsed === 'object') auth = parsed as typeof auth;
      } catch {
        auth = undefined;
      }
      if (!auth || typeof auth.loggedIn !== 'boolean') return { state: 'unknown', label: line };
      if (!auth.loggedIn) return { state: 'signed_out' };
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);
      const plan = str(auth.subscriptionType) ? `${str(auth.authMethod) ?? 'claude.ai'} (${str(auth.subscriptionType)})` : str(auth.authMethod);
      return { state: 'signed_in', label: [str(auth.email), plan].filter(Boolean).join(' · ') || undefined };
    }
    case 'codex':
      // "codex login status" exits 0 when signed in and prints the sign-in method.
      if (output.code === 0) return { state: 'signed_in', label: line };
      return /not logged in|logged out|no credentials/i.test(text) ? { state: 'signed_out', label: line } : { state: 'unknown', label: line };
    case 'cursor':
      if (/not (logged|signed) in|not authenticated|unauthenticated/i.test(text)) return { state: 'signed_out', label: line };
      if (output.code === 0 && /logged in|signed in|authenticated/i.test(text)) return { state: 'signed_in', label: line };
      return { state: 'unknown', label: line };
    case 'antigravity': {
      // "agy models": "Fetching available models..." then one "<id>\t<name>" line per model, exit 0.
      // Only the count is kept; agy names no account.
      const models = output.stdout.split(/\r?\n/).filter((l) => /^[^\t\s][^\t]*\t\S/.test(l)).length;
      if (output.code === 0 && models > 0) return { state: 'signed_in', label: tn('Signed in ({n} model available)', 'Signed in ({n} models available)', models) };
      const said = text
        .split(/\r?\n/)
        // Terminal escapes and other control characters out, and the progress line skipped.
        .map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
        .find((l) => l && !/^fetching available models/i.test(l));
      // A spawn error ("ENOENT ...") is no answer from agy.
      if (output.code === null) return { state: 'unknown', label: line };
      return { state: 'signed_out', label: said && said.length <= 120 ? said : undefined, hint: t('Sign in by running agy in a terminal (Sign in… opens it).') };
    }
    default:
      return { state: 'unknown', label: line };
  }
}

/** The first line with text, at most 160 characters. */
function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : undefined;
}

/**
 * The GitHub token variable Copilot CLI uses instead of its stored sign-in, in GitHub's order of
 * precedence: its name only, never its value.
 */
export function copilotTokenVariable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].find((name) => !!env[name]);
}

/** A Claude Code profile: a config folder of its own, for a separate account (CLAUDE_CONFIG_DIR). */
export interface ClaudeProfile {
  id: string;
  name: string;
  dir: string;
}

/** A profile id: lower-case letters, digits and dashes. */
export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The id a profile name gets, e.g. "Work (ACME)" → "work-acme". */
export function profileId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
