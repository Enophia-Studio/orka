// An AppShell for tests: settings, state and secrets in memory, folders on disk, and every message
// to the UI and every question to the user recorded.
import { type ApprovalRequest, type ApprovalResponse, type EditorContext, NodeHost } from '@orka/core';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ToWebview } from '../src/protocol';
import type { Disposable, SettingsStore } from '../src/settings';
import type { AppShell, Folder, FolderBrowser, InputOptions, SecretStore, StateStore, TerminalHandle } from '../src/shell';
import type { TerminalProgram } from '../src/terminal';

export class MemorySettings implements SettingsStore {
  private readonly listeners = new Set<() => void>();

  constructor(readonly data: Record<string, unknown> = {}) {}

  get<T>(key: string, fallback: T): T {
    return (this.data[key] ?? fallback) as T;
  }

  isSet(key: string): boolean {
    return this.data[key] !== undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    for (const listener of this.listeners) listener();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

export class MemoryState implements StateStore {
  readonly data = new Map<string, unknown>();

  get<T>(key: string, fallback?: T): T {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

class MemorySecrets implements SecretStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class FakeShell implements AppShell {
  readonly settings: MemorySettings;
  readonly secrets = new MemorySecrets();
  readonly globalState = new MemoryState();
  readonly workspaceState = new MemoryState();
  readonly builtinSkillsDir: string;
  /** The test's home folder stands in for ~/.orka (Radar keeps its files in radar/ there). */
  readonly orkaHome: string;
  readonly canOpenFolder: boolean;
  /** The desktop app's own folder picker; none by default (as in VS Code), set by the tests that use it. */
  folderBrowser?: FolderBrowser;
  readonly visible = true;
  readonly posted: ToWebview[] = [];
  readonly asked: Array<{ level: string; text: string; actions: string[]; detail?: string; modal?: boolean }> = [];
  readonly opened: string[] = [];
  readonly terminals: Array<{ name: string; cwd: string; command: string | TerminalProgram; env?: Record<string, string>; onClose?: () => void; shown: boolean }> = [];
  /** What writeClipboard() was given. */
  readonly clipboard: string[] = [];
  /** The action message() answers with, when it offers it. */
  answer?: string;
  /** What input() was asked, and what it answers. */
  readonly inputs: InputOptions[] = [];
  inputAnswer?: string;
  private folder?: string;
  private readonly folderListeners = new Set<() => void>();
  /** Desktop: each folder's own state (VS Code has workspaceState only). */
  readonly stateFor?: (root: string) => MemoryState;
  private readonly folderStates = new Map<string, MemoryState>();

  constructor(
    readonly kind: 'vscode' | 'desktop',
    private readonly home: string,
    /** Recent folders (desktop) or workspace folders (VS Code); the first one is open. */
    private readonly recent: string[],
    settings: Record<string, unknown> = {},
  ) {
    this.settings = new MemorySettings({ language: 'en', ...settings });
    this.builtinSkillsDir = path.join(home, 'builtin-skills');
    this.orkaHome = home;
    this.canOpenFolder = kind === 'desktop';
    this.folder = recent[0];
    if (kind === 'desktop') {
      this.stateFor = (root) => {
        const key = path.resolve(root).toLowerCase();
        let state = this.folderStates.get(key);
        if (!state) this.folderStates.set(key, (state = new MemoryState()));
        return state;
      };
    }
  }

  /** The newest message of this type sent to the UI. */
  last<T extends ToWebview['type']>(type: T): Extract<ToWebview, { type: T }> | undefined {
    return this.posted.filter((m): m is Extract<ToWebview, { type: T }> => m.type === type).at(-1);
  }

  storage(root: string): { tasks: string; snapshots: string } {
    const key = createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);
    return { tasks: path.join(this.home, 'tasks', key), snapshots: path.join(this.home, 'snapshots', `${key}.git`) };
  }

  setMessageHandler(): void {}

  post(message: ToWebview): void {
    this.posted.push(message);
  }

  reveal(): void {}

  currentFolder(): Folder | undefined {
    return this.folder ? { name: path.basename(this.folder), path: this.folder } : undefined;
  }

  folders(): Folder[] {
    return this.recent.map((p) => ({ name: path.basename(p), path: p }));
  }

  async selectFolder(fsPath?: string): Promise<boolean> {
    if (!fsPath || fsPath === this.folder) return false;
    this.folder = fsPath;
    for (const listener of this.folderListeners) listener();
    return true;
  }

  onDidChangeFolder(listener: () => void): Disposable {
    this.folderListeners.add(listener);
    return { dispose: () => this.folderListeners.delete(listener) };
  }

  async message(level: 'info' | 'warning' | 'error', text: string, options?: { modal?: boolean; detail?: string }, ...actions: string[]): Promise<string | undefined> {
    this.asked.push({ level, text, actions, detail: options?.detail, modal: options?.modal });
    return this.answer !== undefined && actions.includes(this.answer) ? this.answer : undefined;
  }

  async input(options: InputOptions): Promise<string | undefined> {
    this.inputs.push(options);
    return this.inputAnswer;
  }

  async pick(): Promise<number | undefined> {
    return undefined;
  }

  async pickFile(): Promise<string | undefined> {
    return undefined;
  }

  /** Files openFile() was asked to open. */
  readonly openedFiles: string[] = [];

  async openFile(absPath: string): Promise<void> {
    this.openedFiles.push(absPath);
  }

  async openExternal(target: string): Promise<boolean> {
    this.opened.push(target);
    return true;
  }

  async openSettings(): Promise<void> {}

  async writeClipboard(text: string): Promise<void> {
    this.clipboard.push(text);
  }

  runInTerminal(options: { name: string; cwd: string; command: string | TerminalProgram; env?: Record<string, string>; onClose?: () => void }): TerminalHandle {
    const terminal = { ...options, shown: false };
    this.terminals.push(terminal);
    return { show: () => void (terminal.shown = true) };
  }

  async openChangeDiff(): Promise<void> {}

  /** Approval previews kept, by key, and the keys openApprovalPreview() was asked for. */
  readonly previews = new Map<string, ApprovalRequest['preview']>();
  readonly previewsOpened: string[] = [];

  setApprovalPreview(id: string, preview: ApprovalRequest['preview']): void {
    if (preview) this.previews.set(id, preview);
  }

  clearApprovalPreview(id: string): void {
    this.previews.delete(id);
  }

  async openApprovalPreview(id: string): Promise<void> {
    this.previewsOpened.push(id);
  }

  createHost(options: { root: string; approve: (request: ApprovalRequest) => Promise<ApprovalResponse> }): NodeHost {
    return new NodeHost({ workspaceRoot: options.root, approve: options.approve });
  }

  editorContext(): EditorContext {
    return {};
  }

  async findFiles(): Promise<string[]> {
    return [];
  }

  watch(): Disposable {
    return { dispose: () => undefined };
  }

  attach(): void {}
}
