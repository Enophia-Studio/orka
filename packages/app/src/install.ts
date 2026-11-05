import { agentCli, childEnv, findExecutable, installHint, isNewerVersion } from '@orka/core';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

/**
 * How a CLI gets installed. Orka runs only the vendor's official installer, exactly as the
 * vendor's install page prints it, and only after the user clicked Install in a dialog that shows
 * that command; it runs in a terminal the user can see, in the home folder, never elevated and
 * never on its own. Nothing is updated automatically. The other CLIs are installed by hand: Orka
 * shows their command with a copy button.
 */
export interface InstallRecipe {
  id: InstallId;
  label: string;
  /** The exact line that runs in the terminal (in the user's shell), as the dialog shows it. */
  command: string;
  /** Orka runs it after the user's consent; false: the command is shown to copy, never run. */
  runnable: boolean;
  /** Where the installer comes from (shown in the dialog). */
  sources: readonly string[];
  docsUrl: string;
  /** Where the installer puts the program, as its docs say. */
  folder?: string;
  /** Part of it runs with npm: Node.js of at least this version has to be there first. */
  node?: string;
  /** What the check after the install looks at: Claude Code, or the agent CLI with this id. */
  verify: { kind: 'claude-code' } | { kind: 'agent'; id: string };
}

/** Every CLI Orka knows how to install: a fixed list, so no message can name another command. */
export const INSTALL_IDS = ['claude-code', 'antigravity', 'codex', 'copilot', 'cursor', 'gemini'] as const;
export type InstallId = (typeof INSTALL_IDS)[number];

export function isInstallId(value: unknown): value is InstallId {
  return typeof value === 'string' && (INSTALL_IDS as readonly string[]).includes(value);
}

/**
 * The recipe for `id` on this platform; undefined for an id not in INSTALL_IDS. Commands checked
 * against each vendor's page (November 2026): code.claude.com/docs/en/setup,
 * antigravity.google/docs/getting-started, github.com/openai/codex (README) and
 * github.com/agentclientprotocol/codex-acp.
 */
export function installRecipe(id: unknown, platform: NodeJS.Platform = process.platform): InstallRecipe | undefined {
  if (!isInstallId(id)) return undefined;
  const win = platform === 'win32';
  switch (id) {
    case 'claude-code':
      return {
        id,
        label: 'Claude Code',
        // The PowerShell installer, started from whichever shell the terminal has.
        command: win ? 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"' : 'curl -fsSL https://claude.ai/install.sh | bash',
        runnable: true,
        sources: ['claude.ai'],
        docsUrl: 'https://code.claude.com/docs/en/setup',
        folder: win ? '%USERPROFILE%\\.local\\bin' : '~/.local/bin',
        verify: { kind: 'claude-code' },
      };
    case 'antigravity':
      return {
        id,
        label: agentCli('antigravity')!.label,
        command: win ? 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        runnable: true,
        sources: ['antigravity.google'],
        docsUrl: 'https://antigravity.google/docs/getting-started',
        folder: win ? '%LOCALAPPDATA%\\agy\\bin' : '~/.local/bin',
        verify: { kind: 'agent', id },
      };
    case 'codex':
      // Two steps in one terminal: the Codex CLI (its sign-in, "codex login"), then the ACP adapter
      // Orka runs. npm needs Node.js; @openai/codex declares Node 16 or newer, codex-acp names none.
      return {
        id,
        label: agentCli('codex')!.label,
        command: win
          ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex; npm install -g @agentclientprotocol/codex-acp"'
          : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh && npm install -g @agentclientprotocol/codex-acp',
        runnable: true,
        sources: ['chatgpt.com', 'npmjs.com (@agentclientprotocol/codex-acp)'],
        docsUrl: 'https://github.com/openai/codex',
        node: '16.0.0',
        verify: { kind: 'agent', id },
      };
    default: {
      // Copilot, Cursor and Gemini CLI: by hand, with the command the catalog shows.
      const entry = agentCli(id)!;
      return { id, label: entry.label, command: installHint(entry, platform), runnable: false, sources: [], docsUrl: entry.docsUrl, verify: { kind: 'agent', id } };
    }
  }
}

/**
 * The installed Node.js version ("22.11.0"), or undefined when there is none on PATH. Runs only
 * `node --version`, by its full path, in the home folder.
 */
export function nodeVersion(timeoutMs = 10_000): Promise<string | undefined> {
  const node = findExecutable('node');
  if (!node) return Promise.resolve(undefined);
  return new Promise((resolve) =>
    execFile(node, ['--version'], { cwd: homedir(), env: childEnv({ ...process.env }), timeout: timeoutMs, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : /\d+\.\d+\.\d+/.exec(stdout)?.[0]),
    ),
  );
}

/** Node.js `version` is at least `min`. */
export function nodeIsRecent(version: string | undefined, min: string): boolean {
  return !!version && !isNewerVersion(min, version);
}
