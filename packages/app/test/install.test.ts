import { agentCli, resolveAgentExecutable } from '@orka/core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppController } from '../src/AppController';
import { INSTALL_IDS, installRecipe } from '../src/install';
import { FakeShell } from './fakeShell';

let home: string;
let folder: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-install-test-'));
  folder = path.join(home, 'work', 'alpha');
  for (const dir of [folder, path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

async function start(settings: Record<string, unknown> = {}) {
  const shell = new FakeShell('desktop', home, [folder], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

/**
 * Runs `body` with PATH set to `dirs` only (none: nothing is found), and with no vendor install
 * folder (Antigravity's, under LOCALAPPDATA or the home folder) holding a real program.
 */
async function withPath(dirs: string[], body: () => Promise<void>): Promise<void> {
  const keys = ['PATH', 'Path', 'LOCALAPPDATA', 'HOME'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PATH = dirs.length ? dirs.join(path.delimiter) : path.join(home, 'empty-bin');
  if (process.platform === 'win32') {
    process.env.Path = process.env.PATH;
    process.env.LOCALAPPDATA = path.join(home, 'empty-local');
  } else {
    process.env.HOME = path.join(home, 'empty-home');
  }
  try {
    await body();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const notices = (shell: FakeShell) => shell.posted.flatMap((m) => (m.type === 'event' && m.event.type === 'notice' ? [m.event] : []));

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('install recipes', () => {
  it('are the vendors\' documented commands, exactly (a change here must be checked against their pages)', () => {
    const lines = (platform: NodeJS.Platform) => Object.fromEntries(INSTALL_IDS.map((id) => [id, [installRecipe(id, platform)!.runnable, installRecipe(id, platform)!.command]]));
    assert.deepEqual(lines('win32'), {
      'claude-code': [true, 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'],
      antigravity: [true, 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"'],
      codex: [true, 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex; npm install -g @agentclientprotocol/codex-acp"'],
      copilot: [false, 'winget install GitHub.Copilot'],
      cursor: [false, "irm 'https://cursor.com/install?win32=true' | iex"],
      gemini: [false, 'npm install -g @google/gemini-cli'],
    });
    for (const platform of ['linux', 'darwin'] as const) {
      assert.deepEqual(lines(platform), {
        'claude-code': [true, 'curl -fsSL https://claude.ai/install.sh | bash'],
        antigravity: [true, 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
        codex: [true, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh && npm install -g @agentclientprotocol/codex-acp'],
        copilot: [false, 'npm install -g @github/copilot'],
        cursor: [false, 'curl https://cursor.com/install -fsS | bash'],
        gemini: [false, 'npm install -g @google/gemini-cli'],
      });
    }
    assert.equal(installRecipe('codex')!.node, '16.0.0', 'npm runs part of the Codex install');
    for (const id of INSTALL_IDS) {
      const recipe = installRecipe(id)!;
      assert.match(recipe.docsUrl, /^https:\/\//, id);
      assert.doesNotMatch(recipe.command, /\bsudo\b|runas|-Verb\s+RunAs|--yes\b|\bnpx\b/i, `${id}: never elevated, never a one-off download`);
    }
  });

  it('come from a fixed list: any other id has none', () => {
    for (const id of ['claude', 'codex; rm -rf ~', '../codex', 'custom:mine', 'CODEX', '', 42, undefined, { id: 'codex' }]) assert.equal(installRecipe(id), undefined, String(id));
  });

  it("find a program in its vendor's install folder when PATH does not have it yet", () => {
    const entry = agentCli('antigravity')!;
    const base = mkdtempSync(path.join(tmpdir(), 'orka-agy-'));
    const savedHome = process.env.HOME;
    try {
      const env: NodeJS.ProcessEnv = { PATH: path.join(base, 'empty'), PATHEXT: '.EXE;.CMD' };
      let file: string;
      if (process.platform === 'win32') {
        env.LOCALAPPDATA = base;
        file = path.join(base, 'agy', 'bin', 'agy.exe');
      } else {
        process.env.HOME = base; // os.homedir() follows HOME
        file = path.join(base, '.local', 'bin', 'agy');
      }
      assert.equal(resolveAgentExecutable(entry, undefined, env), undefined);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
      assert.equal(path.resolve(resolveAgentExecutable(entry, undefined, env) ?? '').toLowerCase(), path.resolve(file).toLowerCase());
      assert.equal(resolveAgentExecutable(agentCli('copilot')!, undefined, env), undefined, 'only where the catalog names a folder');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('installing a CLI', () => {
  it('runs nothing until the user clicks Install in a dialog that shows the exact command', async () => {
    const { shell, controller } = await start();
    const recipe = installRecipe('claude-code')!;
    await controller.handleMessage({ type: 'installCli', id: 'claude-code' });
    assert.equal(shell.terminals.length, 0, 'cancelled: nothing runs');
    const asked = shell.asked.at(-1)!;
    assert.equal(asked.text, 'Install Claude Code?');
    assert.equal(asked.modal, true);
    assert.deepEqual(asked.actions, ['Install', 'Copy command', 'Open docs']);
    assert.equal(asked.detail?.split('\n')[0], recipe.command);
    assert.match(asked.detail ?? '', /Official installer from claude\.ai\./);
    assert.match(asked.detail ?? '', /Docs: https:\/\/code\.claude\.com\/docs\/en\/setup/);
    assert.match(asked.detail ?? '', /terminal you can see, without administrator rights\. Orka does not sign you in\./);

    shell.answer = 'Copy command';
    await controller.handleMessage({ type: 'installCli', id: 'claude-code' });
    assert.deepEqual(shell.clipboard, [recipe.command]);
    shell.answer = 'Open docs';
    await controller.handleMessage({ type: 'installCli', id: 'claude-code' });
    assert.deepEqual(shell.opened, ['https://code.claude.com/docs/en/setup']);
    assert.equal(shell.terminals.length, 0);

    shell.answer = 'Install';
    await controller.handleMessage({ type: 'installCli', id: 'claude-code' });
    assert.equal(shell.terminals.length, 1);
    const [terminal] = shell.terminals;
    assert.deepEqual([terminal.name, terminal.cwd, terminal.command, terminal.shown], ['Install Claude Code', homedir(), recipe.command, true]);
    assert.equal(notices(shell).at(-1)?.action, 'checkInstall:claude-code');
  });

  it('never asks or runs anything for an id outside the recipes', async () => {
    const { shell, controller } = await start();
    shell.answer = 'Install';
    for (const id of ['codex && calc', 'custom:fake', '../../bin/sh']) await controller.handleMessage({ type: 'installCli', id });
    assert.equal(shell.terminals.length, 0);
    assert.equal(shell.asked.length, 0);
  });

  it('shows a manual install to copy and never runs it', async () => {
    const { shell, controller } = await start();
    shell.answer = 'Install';
    await controller.handleMessage({ type: 'installCli', id: 'copilot' });
    const command = installRecipe('copilot')!.command;
    assert.equal(shell.asked.at(-1)?.text, `Install GitHub Copilot CLI yourself with: ${command}`);
    assert.deepEqual(shell.asked.at(-1)?.actions, ['Copy command', 'Open docs']);
    assert.equal(shell.terminals.length, 0);
  });

  it('checks for Node.js before an install that uses npm, and runs nothing without it', async () => {
    const { shell, controller } = await start();
    shell.answer = 'Install';
    await withPath([], () => controller.handleMessage({ type: 'installCli', id: 'codex' }));
    assert.equal(shell.terminals.length, 0);
    assert.match(shell.asked.at(-1)?.text ?? '', /^Codex \(codex-acp\) needs Node\.js 16\.0\.0 or newer for npm, and Node\.js was not found\./);
    assert.deepEqual(shell.asked.at(-1)?.actions, ['Open nodejs.org']);
    // This test's own Node.js is recent enough.
    await withPath([path.dirname(process.execPath)], () => controller.handleMessage({ type: 'installCli', id: 'codex' }));
    assert.equal(shell.terminals.length, 1);
    assert.equal(shell.terminals[0].command, installRecipe('codex')!.command);
  });

  it('checks the program when the terminal closes, and offers to choose it when PATH does not find it yet', async () => {
    await withPath([], async () => {
      const { shell, controller } = await start({ 'agentClis.enabled': [] });
      shell.answer = 'Install';
      await controller.handleMessage({ type: 'installCli', id: 'antigravity' });
      const [terminal] = shell.terminals;
      assert.ok(terminal.onClose, 'the terminal reports when it closes');
      const before = shell.posted.length;
      terminal.onClose!();
      await until(() => shell.asked.some((a) => a.text.startsWith('Antigravity CLI was not found yet.')), 'the check after the install');
      assert.deepEqual(shell.asked.at(-1)?.actions, ['Choose file…']);
      assert.ok(shell.posted.slice(before).some((m) => m.type === 'config'), 'the settings show the new state');
    });
  });

  it('after Claude Code is installed, offers to turn it on', async () => {
    // The node binary stands in for claude: "--version" answers, "auth status" does not (an older CLI).
    const { shell, controller } = await start({ 'claudeCode.path': process.execPath });
    shell.answer = 'Turn on';
    await controller.handleMessage({ type: 'checkInstall', id: 'claude-code' });
    assert.match(notices(shell).at(-1)?.message ?? '', /^Claude Code is installed \(v?\d+/);
    assert.equal(shell.asked.at(-1)?.text, 'Use Claude Code in Orka? It runs on your own Claude Code login.');
    assert.equal(shell.settings.get('claudeCode.enabled', false), true);
  });

  it('offers the install on the notice of an agent CLI picked as main agent that is not installed', async () => {
    await withPath([], async () => {
      const { shell, controller } = await start();
      await controller.handleMessage({ type: 'setAgent', agent: 'main', provider: 'agent:antigravity', model: '' });
      const notice = notices(shell).at(-1);
      assert.equal(notice?.action, 'install:antigravity');
      assert.match(notice?.message ?? '', /^Antigravity CLI is not installed\. Install it from here, or yourself: /);
    });
  });
});
