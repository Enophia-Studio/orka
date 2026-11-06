import { shLine, shQuote, terminalWindow, type TerminalProgram } from '@orka/app';
import { findBrowser, programPath } from '@orka/core';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** How a program ended; undefined when it is not installed. */
interface Ran {
  failed: boolean;
  code?: number;
  stdout: string;
  stderr: string;
}

function run(name: string, args: string[], env: Record<string, string> = {}): Promise<Ran | undefined> {
  const file = programPath(name);
  if (!file) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 10 * 60_000 }, (error, stdout, stderr) =>
      resolve({ failed: !!error, code: typeof error?.code === 'number' ? error.code : undefined, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

async function output(name: string, args: string[], env: Record<string, string> = {}): Promise<string | undefined> {
  const ran = await run(name, args, env);
  return ran && !ran.failed ? ran.stdout : undefined;
}

/**
 * What a dialog program answered: its output, undefined when the user cancelled, null when it could
 * not show the dialog (not installed, or it failed).
 */
export function dialogAnswer(platform: NodeJS.Platform, ran: Ran | undefined): string | undefined | null {
  if (!ran) return null;
  if (!ran.failed) return ran.stdout.trim() || undefined;
  // osascript says "User canceled. (-128)"; zenity exits with 1. PowerShell exits with 0 on a cancel.
  if (platform === 'darwin') return /\(-128\)/.test(ran.stderr) ? undefined : null;
  if (platform !== 'win32' && ran.code === 1) return undefined;
  return null;
}

/** PowerShell with Windows Forms (-STA), texts through environment variables, the answer base64-encoded UTF-8; null as in dialogAnswer. */
async function windowsDialogAnswer(script: string, env: Record<string, string>): Promise<string | undefined | null> {
  const ran = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; ${script}`], env);
  const text = dialogAnswer('win32', ran);
  return text ? Buffer.from(text, 'base64').toString('utf8') : text;
}

async function windowsDialog(script: string, env: Record<string, string>): Promise<string | undefined> {
  return (await windowsDialogAnswer(script, env)) ?? undefined;
}

/** osascript's arguments for the save dialog, in the folder of `suggested` with its name. */
export function macSaveDialogArgs(title: string, suggested: string): string[] {
  return [
    '-e',
    'on run argv',
    '-e',
    'POSIX path of (choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (POSIX file (item 3 of argv)))',
    '-e',
    'end run',
    title,
    path.basename(suggested),
    path.dirname(suggested),
  ];
}

/**
 * A topmost owner, so the dialog opens in front of Orka's window. It has to be shown (invisible,
 * 1x1): a dialog owned by a form that was never shown is not topmost, and as Orka's background
 * process may not take the foreground, it opened behind the window. Its taskbar button, named
 * after the dialog, is a way back to the dialog should anything cover it.
 */
const OWNER =
  "$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $true; Text = $env:ORKA_TITLE; FormBorderStyle = 'None'; StartPosition = 'CenterScreen'; Width = 1; Height = 1; Opacity = 0 }; $o.Show(); $o.Activate()";
const ANSWER = '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))';

let folderPicker: Promise<string | undefined> | undefined;

/** The operating system's folder picker; undefined when cancelled. One at a time: another click waits for the open one. */
export function pickFolder(title: string): Promise<string | undefined> {
  folderPicker ??= showFolderPicker(title).finally(() => (folderPicker = undefined));
  return folderPicker;
}

async function showFolderPicker(title: string): Promise<string | undefined> {
  let picked: string | undefined;
  if (process.platform === 'win32') {
    picked = await windowsDialog(
      `${OWNER}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:ORKA_TITLE; $d.ShowNewFolderButton = $true; if ($d.ShowDialog($o) -eq 'OK') { $p = $d.SelectedPath; ${ANSWER} }`,
      { ORKA_TITLE: title },
    );
  } else if (process.platform === 'darwin') {
    picked = (await output('osascript', ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', title]))?.trim();
  } else {
    picked = (await output('zenity', ['--file-selection', '--directory', `--title=${title}`]))?.trim();
  }
  return picked && existsSync(picked) && statSync(picked).isDirectory() ? picked : undefined;
}

/** The operating system's file picker; undefined when cancelled. */
export async function pickFile(title: string, filters?: Record<string, string[]>): Promise<string | undefined> {
  let picked: string | undefined;
  if (process.platform === 'win32') {
    const filter = [...Object.entries(filters ?? {}).map(([name, exts]) => `${name}|${exts.map((e) => `*.${e}`).join(';')}`), 'All files|*.*'].join('|');
    picked = await windowsDialog(
      `${OWNER}; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = $env:ORKA_TITLE; $d.Filter = $env:ORKA_FILTER; if ($d.ShowDialog($o) -eq 'OK') { $p = $d.FileName; ${ANSWER} }`,
      { ORKA_TITLE: title, ORKA_FILTER: filter },
    );
  } else if (process.platform === 'darwin') {
    picked = (await output('osascript', ['-e', 'on run argv', '-e', 'POSIX path of (choose file with prompt (item 1 of argv))', '-e', 'end run', title]))?.trim();
  } else {
    picked = (await output('zenity', ['--file-selection', `--title=${title}`]))?.trim();
  }
  return picked && existsSync(picked) ? picked : undefined;
}

/**
 * The operating system's save dialog, starting in the folder of `suggested` with its name; it asks
 * before replacing a file. Undefined when cancelled, null when the dialog could not be shown.
 */
export async function pickSaveFile(title: string, suggested: string, filters?: Record<string, string[]>): Promise<string | undefined | null> {
  let picked: string | undefined | null;
  if (process.platform === 'win32') {
    const filter = [...Object.entries(filters ?? {}).map(([name, exts]) => `${name}|${exts.map((e) => `*.${e}`).join(';')}`), 'All files|*.*'].join('|');
    picked = await windowsDialogAnswer(
      `${OWNER}; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.Title = $env:ORKA_TITLE; $d.Filter = $env:ORKA_FILTER; $d.InitialDirectory = $env:ORKA_DIR; $d.FileName = $env:ORKA_NAME; $d.OverwritePrompt = $true; if ($d.ShowDialog($o) -eq 'OK') { $p = $d.FileName; ${ANSWER} }`,
      { ORKA_TITLE: title, ORKA_FILTER: filter, ORKA_DIR: path.dirname(suggested), ORKA_NAME: path.basename(suggested) },
    );
  } else if (process.platform === 'darwin') {
    picked = dialogAnswer('darwin', await run('osascript', macSaveDialogArgs(title, suggested)));
  } else {
    picked = dialogAnswer(process.platform, await run('zenity', ['--file-selection', '--save', '--confirm-overwrite', `--title=${title}`, `--filename=${suggested}`]));
  }
  if (picked === null) return null;
  if (!picked || !path.isAbsolute(picked)) return undefined;
  // A file in a folder that exists, not a folder itself.
  return existsSync(path.dirname(picked)) && statSync(path.dirname(picked)).isDirectory() && !(existsSync(picked) && statSync(picked).isDirectory()) ? picked : undefined;
}

/** An error in a message box of its own (Windows only), for when there is no Orka window to show it in. */
export async function showErrorBox(title: string, text: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await windowsDialog(`${OWNER}; [void][System.Windows.Forms.MessageBox]::Show($o, $env:ORKA_TEXT, $env:ORKA_TITLE, 'OK', 'Error')`, { ORKA_TITLE: title, ORKA_TEXT: text });
}

/** A web page, file or folder with the system's default app. */
export function openExternal(target: string): Promise<boolean> {
  const file = programPath(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open');
  if (!file) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(file, [target], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * A new terminal window in `cwd` running `command`, left open for the user; `onClose` when the
 * window is closed (Windows, Linux). The command is Orka's own (e.g. "freebuff"), never model
 * output; a program (a vendor's sign-in) runs by its full path.
 */
export function openTerminalWindow(options: { title: string; cwd: string; command: string | TerminalProgram; env?: Record<string, string>; onClose?: () => void }): void {
  const { command } = options;
  // Only plain variable names: the extra variables are Orka's own (a Claude Code profile's folder).
  const extra = Object.entries(options.env ?? {}).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  let child: ChildProcess;
  if (process.platform === 'win32') {
    // windowsHide only hides the cmd that runs "start"; the console window it opens is shown.
    // The window's cmd.exe, and what it runs, inherit the variables.
    const { file, args, env } = terminalWindow(options.title, command, { ...process.env, ...Object.fromEntries(extra) });
    child = spawn(file, args, {
      cwd: options.cwd,
      env,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    // The terminal app by its full path: started in the folder, a bare name could be found there.
    const terminal = programPath(process.platform === 'darwin' ? 'osascript' : 'x-terminal-emulator');
    if (!terminal) {
      options.onClose?.();
      return;
    }
    if (process.platform === 'darwin') {
      // Terminal.app starts the user's own shell, which does not inherit Orka's environment.
      const exports = extra.map(([name, value]) => `export ${name}=${shQuote(value)} && `).join('');
      const script = `cd ${shQuote(options.cwd)} && ${exports}${typeof command === 'string' ? command : shLine(command)}`;
      child = spawn(terminal, ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)', '-e', 'end run', script], { stdio: 'ignore' });
      child.once('exit', () => undefined); // Terminal.app keeps the window; there is no close signal.
      return;
    }
    const line = typeof command === 'string' ? command : shLine(command);
    child = spawn(terminal, ['-e', '/bin/sh', '-c', `${line}; exec "\${SHELL:-sh}"`], {
      cwd: options.cwd,
      env: { ...process.env, ...Object.fromEntries(extra) },
      stdio: 'ignore',
    });
  }
  child.once('error', () => options.onClose?.());
  child.once('exit', () => options.onClose?.());
}

/**
 * Orka's window: Edge, Chrome or Chromium in app mode (no tabs or address bar) with its own
 * profile. Undefined when none is installed.
 */
export function openAppWindow(url: string, profileDir: string, browserPath?: string): ChildProcess | undefined {
  const exe = findBrowser(browserPath);
  if (!exe) return undefined;
  return spawn(exe, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,860'], {
    stdio: 'ignore',
    windowsHide: false,
  });
}
