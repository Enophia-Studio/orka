import {
  type AgentEvent,
  type AIProvider,
  type ApprovalRequest,
  type ApprovalResponse,
  applyEvent,
  DEFAULT_SUBAGENTS,
  type EditorContext,
  emptySession,
  EXTERNAL_AGENTS,
  type ExternalAgentRuntime,
  externalAgent,
  FileTaskStore,
  Handoff,
  handoffBrief,
  hasHooks,
  type HooksConfig,
  hunkHeader,
  initProjectMemory,
  isSecretFile,
  lineText,
  type McpServerConfig,
  newTaskId,
  NO_HOOKS,
  type NodeHost,
  Orchestrator,
  type OrchestratorSettings,
  PermissionManager,
  readInsideWorkspace,
  type SessionView,
  ShadowGit,
  type Skill,
  slimSession,
  t,
  type TaskSnapshot,
  tn,
  type Tool,
  userRequests,
} from '@orka/core';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { ConfigView, EditorSelection, HunkView, ImageAttachment, SessionMessage, SessionPost, ToWebview } from './protocol';
import { type AppSettings, readMcpServers } from './settings';
import type { AppShell, StateStore, TerminalHandle } from './shell';
import { WorkspaceFiles } from './workspaceFiles';

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 200_000;
const HOOKS_TRUST_STATE = 'orka.hooksTrust';
/** The longest editor selection sent with a message (the context builder's own limit). */
const MAX_SELECTION_CHARS = 8_000;
const MAX_SELECTION_LINE = 10_000_000;
/**
 * The only files "Open in system app" opens: documents, images and media whose usual handlers
 * show them. Anything else may be run by the system when opened (a script, an installer, a help
 * file, a shortcut), and a name of a known type with a trailing dot or space does not match.
 */
const PASSIVE_FILE =
  /\.(txt|md|markdown|log|csv|tsv|json|jsonc|xml|ya?ml|toml|ini|pdf|rtf|docx|xlsx|pptx|odt|ods|odp|epub|png|jpe?g|gif|bmp|webp|ico|tiff?|psd|tga|exr|hdr|avif|heic|mp3|wav|ogg|oga|flac|m4a|aac|opus|mp4|m4v|mov|webm|mkv|avi|wmv|ttf|otf|woff2?|fbx|obj|gltf|glb|stl|dae|3ds|ply|zip|7z|rar|tar|gz|tgz)$/i;
const MAX_HUNKS = 40;
const MAX_HUNK_LINES = 80;
/** How long a new task waits for a stopped request to end (an agent CLI is stopped after 5 s). */
const STOP_WAIT_MS = 8_000;

/** A session as the session list shows it: waiting for an approval, working, or neither. */
export type LiveState = 'idle' | 'running' | 'approval';

/** What a session needs from the app around it: settings, providers, skills, and the app-wide views it updates. */
export interface SessionContext {
  readonly shell: AppShell;
  settings(): AppSettings;
  /** The page shows this session (only that one may post to it). */
  isActive(session: SessionController): boolean;
  /** Show this session (the user chose "Show" on its approval notice). */
  show(session: SessionController): void;
  providerFor(name: string): AIProvider;
  /** The agent CLI that runs the main agent's turns in this folder, when the main agent is one. */
  externalAgent(root: string): ExternalAgentRuntime | undefined;
  /** Tools of the MCP servers this session may use (started on demand). */
  mcpTools(session: SessionController): Promise<Tool[]>;
  /** Every loaded skill, disabled ones too (a skill the user names is used as named). */
  skills(): readonly Skill[];
  activeSkills(): Skill[];
  reloadSkills(post?: boolean): Promise<void>;
  inheritsNoModel(name: string): boolean;
  /** The main agent's provider can run a request; when not, says why in this session and returns false. */
  readyToSend(session: SessionController): boolean;
  /** The main agent's provider can run a request (nothing is said). */
  mainReady(): boolean;
  isInstalled(id: string, fresh?: boolean): boolean;
  /** The app's part of an agent event (a Claude Code update a model needs). */
  agentEvent(event: AgentEvent): void;
  configView(): ConfigView;
  postConfig(): void;
  postHistory(): Promise<void>;
  /** The session started or finished a run (status bar, the desktop session list). */
  changed(session: SessionController): void;
  /** A run of this session ended (providers waiting for an idle moment are rebuilt). */
  runFinished(session: SessionController): void;
}

/**
 * One task in one folder: its orchestrator, its host and processes, its history, change list,
 * approvals, hand-off and the desktop editor's files. The AppController owns the sessions and
 * everything shared between them (settings, providers, skills, MCP servers, Radar).
 */
export class SessionController {
  /** Not the task id: a session keeps its id while it opens other tasks of its folder. */
  readonly id = `s-${newTaskId()}`;
  readonly root: string;
  readonly host: NodeHost;
  readonly orchestrator: Orchestrator;
  /** Workspace snapshots around terminal commands and hand-offs (a private git dir). */
  readonly snapshots: ShadowGit;
  readonly store: FileTaskStore;
  readonly permissions: PermissionManager;
  /** The desktop app's Files tree and editor (VS Code has its own editor). */
  readonly files?: WorkspaceFiles;
  private task = { id: newTaskId(), createdAt: new Date().toISOString() };
  private session: SessionView = emptySession();
  private readonly pendingApprovals = new Map<string, (response: ApprovalResponse) => void>();
  /** An open hand-off to an external agent and the terminal it runs in. */
  private handoff?: { session: Handoff; terminal: TerminalHandle };
  /**
   * A hand-off is starting (its snapshot is taken) or being collected (its changes are read):
   * Save stays refused, or the user's save would be taken for the external agent's change.
   */
  private handoffBusy = 0;
  /** The folder's .mcp.json as last read (for the settings view). */
  private workspaceMcpCache: { servers: Record<string, McpServerConfig>; hash: string } = { servers: {}, hash: '' };
  /** The request that runs now: a new task waits for it to end in its own task. */
  private running?: Promise<unknown>;
  private startingTask?: Promise<void>;
  /** Saves under way, by path: one at a time per file. */
  private readonly saving = new Map<string, Promise<void>>();
  /** When the page last showed this session (the least recently used idle one is closed first). */
  lastActive = Date.now();

  constructor(
    private readonly ctx: SessionContext,
    folder: string,
  ) {
    const shell = ctx.shell;
    const settings = ctx.settings();
    this.host = shell.createHost({
      root: folder,
      shell: settings.shell,
      browserPath: settings.browserPath,
      approve: (r) => this.requestApproval(r),
    });
    this.root = this.host.workspaceRoot;
    this.files = shell.kind === 'desktop' ? new WorkspaceFiles(this.root) : undefined;
    const storage = shell.storage(folder);
    this.snapshots = new ShadowGit(folder, storage.snapshots);
    this.store = new FileTaskStore(storage.tasks);
    // The mode and the per-action rules are the app's (it passes changes on); "always allow" is this session's.
    this.permissions = new PermissionManager(settings.mode, settings.overrides);
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read by a getter below, so the setting applies at once
    const session = this;
    this.orchestrator = new Orchestrator({
      host: this.host,
      getProvider: () => ctx.providerFor('main'),
      getExternalAgent: () => ctx.externalAgent(this.root),
      getExtraTools: () => ctx.mcpTools(this),
      getLightProvider: () => (ctx.settings().light.provider === 'inherit' ? undefined : ctx.providerFor('light')),
      get commandSnapshots() {
        return ctx.settings().trackCommandChanges ? session.snapshots : undefined;
      },
      getFallbackProvider: () => (ctx.settings().fallback.provider === 'inherit' ? undefined : ctx.providerFor('fallback')),
      permissions: this.permissions,
      getSettings: () => this.orchestratorSettings(),
      subagents: {
        getProfiles: () => (ctx.settings().subagents.enabled ? DEFAULT_SUBAGENTS : []),
        getProvider: (name) => ctx.providerFor(name),
      },
      supervisor: {
        getProvider: () => ctx.providerFor('supervisor'),
        // Next to an agent CLI the Supervisor needs a model; without one it sits out (send() says so).
        getSettings: () => ({ ...ctx.settings().supervisor, enabled: ctx.settings().supervisor.enabled && !ctx.inheritsNoModel('supervisor') }),
      },
      skills: () => ctx.activeSkills(),
    });
    this.orchestrator.on((event) => this.onEvent(event));
  }

  get isRunning(): boolean {
    return this.orchestrator.isRunning;
  }

  /** What the session list shows for it. */
  get state(): LiveState {
    return this.pendingApprovals.size ? 'approval' : this.isRunning ? 'running' : 'idle';
  }

  /** Approvals waiting for the user. */
  get approvals(): number {
    return this.pendingApprovals.size;
  }

  /** Changes waiting for Keep or Revert, or an open hand-off: closing the session would put them out of sight. */
  get hasPendingWork(): boolean {
    return this.session.changes.length > 0 || !!this.handoff;
  }

  /** The task's title: its first message ('' before there is one). */
  title(): string {
    return this.session.items.some((i) => i.kind === 'user') ? this.taskTitle() : '';
  }

  get taskId(): string {
    return this.task.id;
  }

  /** The task has no messages yet (nothing to keep in the history). */
  get isEmpty(): boolean {
    return !this.orchestrator.history.length;
  }

  /** The external agent of the open hand-off, if any. */
  get handoffAgentId(): string | undefined {
    return this.handoff?.session.agent.id;
  }

  /** The folder's .mcp.json servers as last read. */
  get workspaceMcpServers(): { servers: Record<string, McpServerConfig>; hash: string } {
    return this.workspaceMcpCache;
  }

  /** To the page, named as this session's; nothing while the page shows another session. */
  post(message: SessionPost): void {
    if (!this.ctx.isActive(this)) return;
    this.ctx.shell.post({ ...message, sessionId: this.id } as ToWebview);
  }

  /** The page shows this session's task from scratch. */
  postInit(): void {
    this.post({ type: 'init', session: this.session, config: this.ctx.configView(), taskId: this.task.id });
  }

  async handle(message: SessionMessage): Promise<void> {
    const shell = this.ctx.shell;
    switch (message.type) {
      case 'send':
        await this.send(message.text, message.files, message.skills, message.images, message.editor);
        break;
      case 'stop':
        this.stop();
        break;
      case 'rewind':
        await this.rewind(message.id);
        break;
      case 'compact':
        await this.compact();
        break;
      case 'approve':
        this.resolveApproval(message.id, { approved: message.approved, feedback: message.feedback, alwaysAllow: message.always });
        break;
      case 'previewApproval':
        await shell.openApprovalPreview(this.previewKey(message.id));
        break;
      case 'openDiff':
        await shell.openChangeDiff(message.path);
        break;
      case 'acceptChange':
        this.orchestrator.changes.accept(message.path);
        break;
      case 'revertChange':
        await this.revert(message.path);
        break;
      case 'getHunks':
        await this.postHunks(message.path);
        break;
      case 'revertHunk':
        await this.revertHunk(message.path, message.index, message.header);
        break;
      case 'keepHunk':
        await this.keepHunk(message.path, message.index, message.header);
        break;
      case 'acceptAll':
        this.acceptAll();
        break;
      case 'revertAll':
        await this.revertAll();
        break;
      case 'handoff':
        await this.handOff(message.agent, message.text);
        break;
      case 'searchFiles':
        await this.searchFiles(message.query);
        break;
      case 'listDir':
        this.listDir(message.path);
        break;
      case 'readFile':
        this.readFile(message.path, message.knownHash);
        break;
      case 'saveFile':
        await this.saveFile(message.path, message.text, message.baseHash);
        break;
      case 'openExternalFile':
        await this.openExternalFile(message.path);
        break;
      case 'initMemory':
        await this.initMemory();
        break;
    }
  }

  // ---------------------------------------------------------------- desktop Files and editor

  private listDir(rel: unknown): void {
    if (!this.files || typeof rel !== 'string') return;
    const listing = this.files.list(rel);
    this.post(
      'error' in listing
        ? { type: 'dirEntries', path: rel, error: listing.error }
        : { type: 'dirEntries', path: rel, entries: listing.entries, ...(listing.truncated ? { truncated: true as const } : {}) },
    );
  }

  private readFile(rel: unknown, knownHash: unknown): void {
    if (!this.files || typeof rel !== 'string') return;
    const read = this.files.read(rel, typeof knownHash === 'string' ? knownHash : undefined);
    if ('error' in read) this.post({ type: 'fileContent', path: rel, ok: false, reason: read.error });
    else if ('unchanged' in read) this.post({ type: 'fileContent', path: rel, ok: true, unchanged: true, hash: read.hash });
    else this.post({ type: 'fileContent', path: rel, ok: true, ...read });
  }

  /**
   * Save the editor's text. Refused while an agent works or a hand-off is open: their change
   * tracking would take the save for the agent's. A saved file the agent changed is marked as
   * edited by the user, so Revert, Go back and hunk Revert leave the user's edit alone.
   */
  private async saveFile(rel: unknown, text: unknown, baseHash: unknown): Promise<void> {
    if (!this.files || typeof rel !== 'string') return;
    const key = rel.toLowerCase();
    const save = (this.saving.get(key) ?? Promise.resolve()).then(() => this.saveNow(rel, text, baseHash));
    const done = save.catch(() => undefined);
    this.saving.set(key, done);
    try {
      await save;
    } finally {
      if (this.saving.get(key) === done) this.saving.delete(key);
    }
  }

  private saveNow(rel: string, text: unknown, baseHash: unknown): void {
    const files = this.files;
    const orchestrator = this.orchestrator;
    if (!files) return;
    if (orchestrator.isRunning || this.handoff || this.handoffBusy > 0) {
      this.post({ type: 'saveRefused', path: rel, reason: 'running' });
      return;
    }
    const file = files.resolve(rel);
    if (!file) {
      this.post({ type: 'saveRefused', path: rel, reason: 'outside' });
      return;
    }
    const result = files.save(rel, text as string, baseHash as string);
    if (!result.ok) {
      this.post({ type: 'saveRefused', path: rel, reason: result.reason, ...(result.hash ? { hash: result.hash } : {}) });
      return;
    }
    // The tracker knows a file by the path the agent used, which may be another link to the same
    // file: note the save under each tracked path that leads to it (each path once).
    const paths = [file.abs, file.real];
    for (const tracked of orchestrator.changes.trackedPaths()) {
      const real = realPathOf(tracked);
      if (real && samePath(real, file.real)) paths.push(tracked);
    }
    const noted: string[] = [];
    for (const p of paths) {
      if (noted.some((n) => samePath(n, p))) continue;
      noted.push(p);
      orchestrator.changes.noteUserEdit(p, result.before, result.after);
    }
    orchestrator.addNote(`The user edited ${rel} by hand in the editor; re-read it before editing it again.`);
    this.post({ type: 'fileSaved', path: rel, hash: result.hash });
    // Changes and their hunks are published again, so hunk numbers match the saved file.
    orchestrator.changes.notify();
  }

  /**
   * "Open in system app" for a file of the folder: only a document, image or media file (never a
   * program or script, which that would run), and on macOS and Linux never one marked executable.
   */
  private async openExternalFile(rel: unknown): Promise<void> {
    if (!this.files || typeof rel !== 'string') return;
    const file = this.files.resolve(rel);
    if (!file) return;
    if (!PASSIVE_FILE.test(file.real) || (process.platform !== 'win32' && isExecutable(file.real))) {
      void this.ctx.shell.message('warning', t('Orka opens only documents, images and media with the system app, never programs or scripts: {file}.', { file: rel }));
      return;
    }
    await this.ctx.shell.openFile(file.real);
  }

  /**
   * The editor's file and selection as the agent's context, checked: a file inside the folder and
   * valid line numbers. {} when there is none (or the app has no Files editor); undefined when it
   * is not valid.
   */
  private editorSelection(editor: EditorSelection | undefined): EditorContext | undefined {
    if (!this.files || editor === undefined) return {};
    if (!editor || typeof editor !== 'object' || typeof editor.file !== 'string') return undefined;
    const file = this.files.resolve(editor.file);
    if (!file || !isFile(file.real)) return undefined;
    let selection: EditorContext['selection'];
    if (editor.selection !== undefined) {
      const { startLine, endLine, text } = editor.selection ?? {};
      const line = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_SELECTION_LINE;
      if (!line(startLine) || !line(endLine) || startLine > endLine || typeof text !== 'string') return undefined;
      selection = { startLine, endLine, text: text.slice(0, MAX_SELECTION_CHARS) };
    }
    return { ...this.ctx.shell.editorContext(this.root), activeFile: file.rel, ...(selection ? { selection } : {}) };
  }

  // ---------------------------------------------------------------- agent actions

  async send(text: string, files: string[] = [], skillNames: string[] = [], images: ImageAttachment[] = [], editor?: EditorSelection): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const orchestrator = this.orchestrator;
    if (orchestrator.isRunning) {
      void this.ctx.shell.message('info', t('The agent is still working. Stop it first or wait until it finishes.'));
      return;
    }
    const fromEditor = this.editorSelection(editor);
    if (!fromEditor) {
      this.publishNotice('warning', t('Not sent: the selection from the editor does not name a file and lines in this folder.'));
      return;
    }
    if (!this.ctx.readyToSend(this)) return;
    // Files an external agent changed meanwhile become reviewable changes, and the agent hears about them.
    if (this.handoff) await this.collectHandoff(false);
    // A new task picks up skills added or edited since the last one.
    if (!orchestrator.history.length) await this.ctx.reloadSkills(false);
    const skills = this.ctx.skills();
    const invoked = [...new Set(skillNames)].map((name) => skills.find((s) => s.name === name)).filter((s): s is Skill => !!s);
    await this.confirmWorkspaceHooks();
    const attachments = await this.readAttachments(files);
    // A secret-looking file the user put into the context arms the secrets guard, as an agent's read of it would.
    if (fromEditor.activeFile && isSecretFile(fromEditor.activeFile)) orchestrator.noteSecretContext(fromEditor.activeFile);
    const context = fromEditor.activeFile ? fromEditor : this.ctx.shell.editorContext(this.root);
    const run = orchestrator.run(trimmed, context, attachments, { skills: invoked, images: validImages(images) });
    this.running = run;
    try {
      await run;
    } finally {
      if (this.running === run) this.running = undefined;
    }
  }

  stop(): void {
    this.orchestrator.stop();
  }

  /**
   * Go back to just before one of this task's messages: the conversation from there on is
   * removed, files the agents changed since are restored, and the message is put back in the box.
   */
  async rewind(id: string): Promise<void> {
    const orchestrator = this.orchestrator;
    const shell = this.ctx.shell;
    if (orchestrator.isRunning) {
      void shell.message('info', t('The agent is still working. Stop it first, then go back.'));
      return;
    }
    if (!orchestrator.rewindTargets.some((p) => p.id === id)) {
      void shell.message('info', t('Going back to this message is no longer possible: the task was compacted or reopened since.'));
      return;
    }
    const back = t('Go back');
    const keep = (await orchestrator.rewindPreview(id))?.keep ?? [];
    const choice = await shell.message(
      'warning',
      t('Go back to before this message? The conversation from here on is removed, and files the agents changed since return to how they were. The file changes stay reviewable in Changes.') +
        (keep.length ? ` ${t('Files you edited yourself are kept: {files}.', { files: keep.slice(0, 8).join(', ') })}` : ''),
      { modal: true },
      back,
    );
    if (choice !== back) return;
    const result = await orchestrator.rewind(id);
    if (!result) return;
    this.post({ type: 'setInput', text: result.text });
    this.publishNotice(
      'info',
      (result.restored.length
        ? t('Went back. Restored {n} file(s): {files}. Edit the message and send it again.', { n: result.restored.length, files: result.restored.slice(0, 8).join(', ') })
        : t('Went back. Edit the message and send it again.')) +
        (result.kept.length ? ` ${t('Kept {n} file(s) you edited: {files}.', { n: result.kept.length, files: result.kept.slice(0, 8).join(', ') })}` : ''),
    );
    await this.saveTask();
  }

  /** Archive the task in the history and start an empty one in this folder. */
  newTask(): Promise<void> {
    // A second click while the first one waits for the request to end starts no other task.
    this.startingTask ??= this.startNewTask().finally(() => (this.startingTask = undefined));
    return this.startingTask;
  }

  private async startNewTask(): Promise<void> {
    if (this.orchestrator.isRunning) {
      this.orchestrator.stop();
      // The stopped request ends in its own task and is saved there (an agent CLI gets a few
      // seconds to end its turn); a request that does not end in time is left out of both.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.running?.catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)))]);
      clearTimeout(timer);
    }
    await this.saveTask();
    this.task = { id: newTaskId(), createdAt: new Date().toISOString() };
    this.orchestrator.reset();
    await this.ctx.postHistory();
  }

  async compact(): Promise<void> {
    if (this.orchestrator.isRunning) return;
    if (!this.ctx.mainReady()) return;
    await this.orchestrator.compact();
    await this.saveTask();
  }

  acceptAll(): void {
    this.orchestrator.changes.acceptAll();
  }

  async revertAll(): Promise<void> {
    const orchestrator = this.orchestrator;
    const changes = await orchestrator.changes.list();
    if (!changes.length) return;
    // Files the user edited after the agent stay as they are; they are named afterwards.
    const edited = changes.filter((c) => c.userEdited).length;
    const count = changes.length - edited;
    if (count) {
      const revertLabel = t('Revert All');
      const question =
        tn('Revert the {n} AI-changed file?', 'Revert all {n} AI-changed files?', count) +
        (edited ? ` ${tn('{n} file you edited after the agent stays as it is.', '{n} files you edited after the agent stay as they are.', edited)}` : '');
      const choice = await this.ctx.shell.message('warning', question, { modal: true }, revertLabel);
      if (choice !== revertLabel) return;
    }
    const reverted = count ? await orchestrator.changes.revertAll() : [];
    if (reverted.length) orchestrator.addNote(`The user reverted your changes to these files: ${reverted.join(', ')}.`);
    const kept = orchestrator.changes.skippedUserEdited();
    if (kept.length) {
      this.publishNotice('info', t('Kept {n} file(s) you edited: {files}. Revert their parts in Changes.', { n: kept.length, files: kept.slice(0, 8).join(', ') }));
    }
  }

  private relPath(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/');
  }

  /**
   * Revert one file. A file the user edited after the agent is never reverted as a whole (that would
   * throw their edit away): only the agent's part is undone, when it can be told apart cleanly.
   */
  private async revert(absPath: string): Promise<void> {
    const orchestrator = this.orchestrator;
    const rel = this.relPath(absPath);
    if (!orchestrator.changes.isUserEdited(absPath)) {
      if (await orchestrator.changes.revert(absPath)) orchestrator.addNote(`The user reverted your changes to ${rel}.`);
      return;
    }
    const undo = t("Undo only the agent's part");
    const choice = await this.ctx.shell.message('warning', t('You edited {file} after the agent.', { file: rel }), { modal: true }, undo);
    if (choice !== undo) return;
    const result = await orchestrator.changes.revertAgentPart(absPath);
    if (result === 'reverted') {
      orchestrator.addNote(`The user undid your changes to ${rel} and kept their own edits. Re-read the file before editing it again.`);
      return;
    }
    const reasons: Record<Exclude<typeof result, 'reverted'>, string> = {
      conflict: t("Could not separate your edits from the agent's in {file} (they are on the same or neighbouring lines); nothing was changed.", { file: rel }),
      unavailable: t("Could not undo only the agent's part of {file}: that needs Git, and the file's text from before your edit, which a reopened large task does not keep. Nothing was changed.", {
        file: rel,
      }),
      changed: t('{file} changed after you saved it; nothing was changed. Try again.', { file: rel }),
      notApplicable: t('The agent created or deleted {file}, so its part cannot be undone apart from your edits; nothing was changed.', { file: rel }),
    };
    this.publishNotice('warning', reasons[result]);
  }

  /** Hunks of one changed file for the Changes panel. */
  private async postHunks(absPath: string): Promise<void> {
    const hunks = await this.orchestrator.changes.hunks(absPath).catch(() => []);
    const views: HunkView[] = hunks.slice(0, MAX_HUNKS).map((h) => ({
      header: hunkHeader(h),
      lines: h.lines.slice(0, MAX_HUNK_LINES).map((l) => ({ type: l.type, text: lineText(l.text) })),
      hidden: Math.max(0, h.lines.length - MAX_HUNK_LINES),
    }));
    this.post({ type: 'hunks', path: absPath, hunks: views });
  }

  /** Keep one part of a change (the rest stays reviewable). */
  async keepHunk(absPath: string, index: number, header?: string): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!Number.isInteger(index) || index < 0) return;
    const hunk = (await orchestrator.changes.hunks(absPath))[index];
    if (!hunk || !isShown(hunk, header) || !(await orchestrator.changes.acceptHunk(absPath, index))) {
      void this.ctx.shell.message('warning', t('That part of the change no longer exists; the file changed in the meantime.'));
    }
    await this.postHunks(absPath);
  }

  /**
   * Undo one part of a change. `header`: the hunk as the page showed it; when the change moved on
   * since, nothing is undone. A part that includes lines the user edited is left alone.
   */
  async revertHunk(absPath: string, index: number, header?: string): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!Number.isInteger(index) || index < 0) return;
    const hunk = (await orchestrator.changes.hunks(absPath))[index];
    if (hunk && isShown(hunk, header) && (await orchestrator.changes.hunkTouchesUserEdit(absPath, index))) {
      void this.ctx.shell.message('warning', t('This part includes lines you edited; it was left as is.'));
    } else if (!hunk || !isShown(hunk, header) || !(await orchestrator.changes.revertHunk(absPath, index, { header: hunkHeader(hunk) }))) {
      void this.ctx.shell.message('warning', t('That part of the change no longer exists; the file changed in the meantime.'));
    } else {
      orchestrator.addNote(`The user reverted part of your change to ${this.relPath(absPath)} (${hunkHeader(hunk)}). Re-read the file before editing it again.`);
    }
    await this.postHunks(absPath);
  }

  async initMemory(): Promise<void> {
    const created = await initProjectMemory(this.host);
    void this.ctx.shell.message(
      'info',
      created.length ? t('Created {files}. The agent reads these at the start of each task.', { files: created.join(', ') }) : t('.project-ai already exists.'),
    );
    await this.ctx.shell.openFile(path.join(this.root, '.project-ai', 'decisions.md'));
    this.ctx.postConfig();
  }

  // ---------------------------------------------------------------- attachments and file search

  private async readAttachments(files: string[]): Promise<Array<{ path: string; content: string }>> {
    const root = this.root;
    const out: Array<{ path: string; content: string }> = [];
    for (const rel of [...new Set(files)].slice(0, MAX_ATTACHMENTS)) {
      if (this.files) {
        const attached = this.readAttachment(this.files, rel);
        if (attached) out.push(attached);
        continue;
      }
      const abs = path.resolve(root, rel);
      const inside = path.relative(root, abs);
      if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
          this.publishNotice(
            'warning',
            stat.isFile()
              ? t('Skipped {file}: larger than 200 KB. The agent can still read it with its tools.', { file: rel })
              : t('Skipped {file}: not a file.', { file: rel }),
          );
          continue;
        }
        out.push({ path: inside.split(path.sep).join('/'), content: await this.host.readFile(abs) });
      } catch {
        this.publishNotice('warning', t('Could not attach {file}.', { file: rel }));
      }
    }
    return out;
  }

  /**
   * One attachment in the desktop app, read with the editor's checks: a link that leads out of the
   * folder is not followed. A secret-looking file arms the secrets guard.
   */
  private readAttachment(files: WorkspaceFiles, rel: string): { path: string; content: string } | undefined {
    const file = files.resolve(rel);
    if (!file) return undefined;
    let read: ReturnType<typeof readInsideWorkspace>;
    try {
      read = readInsideWorkspace(files.root, file.abs, MAX_ATTACHMENT_BYTES);
    } catch {
      read = { error: 'notFound' };
    }
    if ('error' in read) {
      if (read.error === 'tooLarge') this.publishNotice('warning', t('Skipped {file}: larger than 200 KB. The agent can still read it with its tools.', { file: rel }));
      else if (read.error === 'notFile') this.publishNotice('warning', t('Skipped {file}: not a file.', { file: rel }));
      else if (read.error === 'notFound') this.publishNotice('warning', t('Could not attach {file}.', { file: rel }));
      return undefined;
    }
    if (isSecretFile(file.rel)) this.orchestrator.noteSecretContext(file.rel);
    return { path: file.rel, content: read.bytes.toString('utf8') };
  }

  private async searchFiles(query: string): Promise<void> {
    const q = query.replace(/[\\[\]{}*?!]/g, '').trim();
    const files = q ? await this.ctx.shell.findFiles(this.root, q, 30).catch(() => []) : [];
    const rel = files.sort((a, b) => a.length - b.length).slice(0, 12);
    this.post({ type: 'fileMatches', query, files: rel });
  }

  // ---------------------------------------------------------------- MCP servers and hooks of the folder

  /** Servers from the folder's .mcp.json (the format Claude Code uses), if any. */
  async workspaceMcp(): Promise<{ servers: Record<string, McpServerConfig>; hash: string }> {
    try {
      const raw = await fs.readFile(path.join(this.root, '.mcp.json'), 'utf8');
      const servers = readMcpServers(JSON.parse(raw)?.mcpServers);
      this.workspaceMcpCache = { servers, hash: createHash('sha1').update(raw).digest('hex') };
    } catch {
      this.workspaceMcpCache = { servers: {}, hash: '' };
    }
    return this.workspaceMcpCache;
  }

  /** What is kept for this session's folder (never another folder's, though that one may be shown). */
  folderState(): StateStore {
    return this.ctx.shell.stateFor?.(this.root) ?? this.ctx.shell.workspaceState;
  }

  /** The agents' settings; hooks from the folder's own settings only once the user allowed them. */
  private orchestratorSettings(): OrchestratorSettings {
    const s = this.ctx.settings();
    if (!s.hooksFromWorkspace || !hasHooks(s.orchestrator.hooks)) return s.orchestrator;
    const trust = this.folderState().get<{ hash: string; allowed: boolean }>(HOOKS_TRUST_STATE);
    return trust?.hash === hooksHash(s.orchestrator.hooks) && trust.allowed ? s.orchestrator : { ...s.orchestrator, hooks: NO_HOOKS };
  }

  /**
   * Hooks defined in the open folder's settings run commands without asking, and a cloned
   * repository controls those settings: ask once for each version of them.
   */
  private async confirmWorkspaceHooks(): Promise<void> {
    const settings = this.ctx.settings();
    const hooks = settings.orchestrator.hooks;
    if (!settings.hooksFromWorkspace || !hasHooks(hooks)) return;
    const hash = hooksHash(hooks);
    const state = this.folderState();
    if (state.get<{ hash: string }>(HOOKS_TRUST_STATE)?.hash === hash) return;
    const commands = [...(hooks?.afterEdit ?? []), ...(hooks?.beforeFinish ?? [])].map((h) => h.command);
    const allow = t('Allow');
    const choice = await this.ctx.shell.message(
      'warning',
      t('This folder\'s settings define hooks that run commands on your machine while the agent works: {commands}. Allow them?', { commands: commands.join(' · ') }),
      { modal: true },
      allow,
      t('Not now'),
    );
    await state.update(HOOKS_TRUST_STATE, { hash, allowed: choice === allow });
  }

  // ---------------------------------------------------------------- task history

  private taskTitle(): string {
    const first = this.session.items.find((i) => i.kind === 'user');
    const text = first && first.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim() : t('Untitled task');
    return text.length > 90 ? `${text.slice(0, 87)}…` : text;
  }

  async saveTask(): Promise<void> {
    const state = this.orchestrator.snapshot();
    if (!state.messages.length) return;
    const snapshot: TaskSnapshot = {
      version: 1,
      id: this.task.id,
      title: this.taskTitle(),
      createdAt: this.task.createdAt,
      updatedAt: new Date().toISOString(),
      ...state,
      // The model history keeps full tool results; the replayed chat only needs a readable copy.
      view: slimSession(this.session),
    };
    try {
      await this.store.save(snapshot);
    } catch (error) {
      void this.ctx.shell.message('error', `Orka: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Open a task of this folder's history in place of the current one (saved first). */
  async open(id: string): Promise<void> {
    const orchestrator = this.orchestrator;
    if (orchestrator.isRunning) {
      void this.ctx.shell.message('info', t('Stop the agent before opening another task.'));
      return;
    }
    if (id === this.task.id) return;
    await this.saveTask();
    await this.ctx.reloadSkills(false);
    const snapshot = await this.store.load(id);
    if (!snapshot) {
      void this.ctx.shell.message('warning', t('That task could not be loaded.'));
      await this.ctx.postHistory();
      return;
    }
    orchestrator.restore(snapshot);
    this.task = { id: snapshot.id, createdAt: snapshot.createdAt };
    this.session = isSessionView(snapshot.view) ? { ...snapshot.view, running: false } : emptySession();
    this.session.usageByAgent = snapshot.usageByAgent;
    this.postInit();
    await this.ctx.postHistory();
  }

  /** The open task was deleted from the history: what follows is a new task. */
  forgetTask(): void {
    this.task = { id: newTaskId(), createdAt: new Date().toISOString() };
    if (!this.orchestrator.isRunning) this.orchestrator.reset();
  }

  // ---------------------------------------------------------------- approvals

  /**
   * The shell keeps approval previews of every session: a tool call id is unique within a task only
   * (two sessions can both wait on "call_1"), so the key names the session too.
   */
  private previewKey(id: string): string {
    return `${this.id}:${id}`;
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const shell = this.ctx.shell;
    shell.setApprovalPreview(this.previewKey(request.id), request.preview);
    const show = t('Show');
    if (!this.ctx.isActive(this)) {
      // A session in the background: one notice for its first waiting approval, none for the
      // approvals that follow while that one is not answered. Nothing goes into a transcript.
      if (!this.pendingApprovals.size) {
        void shell
          .message('info', t('A session in {folder} needs your approval: {title}', { folder: path.basename(this.root) || this.root, title: request.title }), {}, show)
          .then((c) => c === show && this.ctx.show(this));
      }
    } else if (!shell.visible) {
      shell.reveal();
      void shell.message('info', t('AI agent needs approval: {title}', { title: request.title }), {}, show).then((c) => c === show && shell.reveal());
    }
    const answer = new Promise<ApprovalResponse>((resolve) => this.pendingApprovals.set(request.id, resolve));
    this.ctx.changed(this);
    return answer;
  }

  private resolveApproval(id: string, response: ApprovalResponse): void {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    this.ctx.shell.clearApprovalPreview(this.previewKey(id));
    resolve(response);
    this.ctx.changed(this);
  }

  /** Every open approval is answered "no" (its run ended, or the session goes away). */
  private denyApprovals(): void {
    if (!this.pendingApprovals.size) return;
    for (const [id, resolve] of this.pendingApprovals) {
      resolve({ approved: false });
      this.ctx.shell.clearApprovalPreview(this.previewKey(id));
    }
    this.pendingApprovals.clear();
    this.ctx.changed(this);
  }

  // ---------------------------------------------------------------- hand-off to external agents

  /**
   * Continue the task in an external agent that has no API (Freebuff): open it in a terminal in
   * this folder with a task summary on the clipboard, and snapshot the workspace, so the files it
   * changes show up under Changes (Keep / Revert) when the user comes back.
   */
  async handOff(agentId: string, text?: string): Promise<void> {
    const agent = externalAgent(agentId);
    const orchestrator = this.orchestrator;
    const shell = this.ctx.shell;
    const root = this.root;
    if (!agent) return;
    if (orchestrator.isRunning) {
      void shell.message('info', t('The agent is still working. Stop it first or wait until it finishes.'));
      return;
    }
    if (this.handoff) {
      this.handoff.terminal.show();
      return;
    }
    if (!this.ctx.isInstalled(agent.id, true)) {
      const install = t('Install');
      const website = t('Website');
      const pick = await shell.message(
        'info',
        t('{agent} is not installed. Install it with: {command}', { agent: agent.label, command: agent.installCommand }),
        {},
        install,
        website,
      );
      if (pick === install) {
        shell.runInTerminal({ name: t('Install {agent}', { agent: agent.label }), cwd: root, command: agent.installCommand, onClose: () => this.ctx.postConfig() }).show();
      } else if (pick === website) {
        void shell.openExternal(agent.url);
      }
      return;
    }
    const session = new Handoff(agent, root, this.snapshots, orchestrator.changes);
    // From the snapshot on, a save would count as the external agent's change.
    this.handoffBusy++;
    let tracked: boolean;
    let brief: string | undefined;
    let terminal: TerminalHandle;
    try {
      tracked = await session.begin();
      const requests = [...userRequests(orchestrator.history), ...(text?.trim() ? [text.trim()] : [])];
      brief = handoffBrief({ requests, plan: orchestrator.currentPlan, changedFiles: (await orchestrator.changes.list()).map((c) => c.relPath) });
      if (brief) await shell.writeClipboard(brief);
      terminal = shell.runInTerminal({
        name: agent.label,
        cwd: root,
        command: agent.command,
        onClose: () => {
          if (this.handoff?.session === session) void this.collectHandoff(true);
        },
      });
      this.handoff = { session, terminal };
    } finally {
      this.handoffBusy--;
    }
    terminal.show();
    const parts = [t('{agent} is open in the terminal.', { agent: agent.label })];
    if (brief) parts.push(t('The task summary is on the clipboard: paste it there.'));
    parts.push(
      tracked
        ? t('When you close that terminal or send Orka a message, the files {agent} changed show up under Changes.', { agent: agent.label })
        : t("Orka can't track what {agent} changes: {reason}.", { agent: agent.label, reason: session.untrackedReason ?? t('snapshots are off') }),
    );
    this.publishNotice('info', parts.join(' '));
    this.ctx.postConfig();
  }

  /** Pick up what the external agent changed; `ended` when its terminal was closed. */
  private async collectHandoff(ended: boolean): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    if (ended) this.handoff = undefined;
    const label = handoff.session.agent.label;
    // Save stays refused until the external agent's changes are read: a save meanwhile would count as theirs.
    this.handoffBusy++;
    let changed: Awaited<ReturnType<Handoff['collect']>>;
    try {
      changed = await handoff.session.collect(!ended).catch(() => []);
    } finally {
      this.handoffBusy--;
    }
    if (changed.length) {
      const files = changed.map((c) => c.path);
      this.orchestrator.addNote(
        `The user worked on this task in ${label} (another coding agent) and it changed: ${files.join(', ')}. Read these files before building on them.`,
      );
      const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? ', …' : '');
      this.publishNotice('info', t('{agent} changed {n} file(s): {files}. Review them under Changes (Keep / Revert).', { agent: label, n: files.length, files: shown }));
    } else if (ended) {
      this.publishNotice('info', t('{agent} closed without changing any files.', { agent: label }));
    }
    if (ended) this.ctx.postConfig();
  }

  // ---------------------------------------------------------------- state plumbing

  private onEvent(event: AgentEvent): void {
    if (event.type === 'reset') this.session = emptySession();
    applyEvent(this.session, event);
    this.post({ type: 'event', event });
    this.ctx.agentEvent(event);
    // Out of quota with no fallback: offer to go on in a free external agent.
    if (event.type === 'run_finished' && event.reason === 'error' && !this.handoff && USAGE_LIMIT.test(this.orchestrator.lastError ?? '')) {
      const agent = EXTERNAL_AGENTS[0];
      this.publishNotice('info', t('The provider hit a usage limit. You can continue this task in {agent} for free.', { agent: agent.label }), `handoff:${agent.id}`);
    }
    // The session list follows its state, its task and title (the first message comes after run_started).
    if (event.type === 'run_started' || event.type === 'run_finished' || event.type === 'user_message' || event.type === 'reset') this.ctx.changed(this);
    if (event.type === 'run_finished') {
      // Any approval still open belongs to a finished run.
      this.denyApprovals();
      this.ctx.runFinished(this);
      void this.saveTask().then(() => this.ctx.postHistory());
    }
  }

  publishNotice(level: 'info' | 'warning' | 'error', message: string, action?: string): void {
    const event = { type: 'notice' as const, level, message, action };
    applyEvent(this.session, event);
    this.post({ type: 'event', event });
  }

  /** Remove the notices `stale` picks by their action; the page gets the transcript again when any went. */
  dropNotices(stale: (action: string) => boolean): void {
    if (dropNotices(this.session, stale)) this.postInit();
  }

  /**
   * The session goes away (another folder, or the app closes): its task is saved, an open hand-off
   * is let go, its processes stop and open approvals are answered "no".
   */
  async dispose(): Promise<void> {
    // The task's state is read before anything is stopped.
    const saved = this.saveTask();
    // A hand-off belongs to the workspace and change list being dropped.
    this.handoff = undefined;
    this.orchestrator.dispose();
    this.host.stopAllProcesses();
    this.denyApprovals();
    await saved;
  }
}

/** Remove the notices `stale` picks by their action; true when any went. */
export function dropNotices(view: SessionView, stale: (action: string) => boolean): boolean {
  const before = view.items.length;
  view.items = view.items.filter((item) => item.kind !== 'notice' || !item.action || !stale(item.action));
  return view.items.length !== before;
}

/** Two paths name the same file or folder (Windows paths ignore case). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** Where a path really leads, or undefined when it cannot be resolved. */
function realPathOf(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** A file with an execute bit (macOS and Linux); one that cannot be read counts as executable. */
function isExecutable(p: string): boolean {
  try {
    return (statSync(p).mode & 0o111) !== 0;
  } catch {
    return true;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Errors that mean the provider's quota or session limit is used up. */
const USAGE_LIMIT = /usage limit|rate.?limit|session limit|quota|\b429\b|too many requests/i;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
/** Base64 length of about 5 MB of image data (the Claude API's per-image limit). */
const MAX_IMAGE_BASE64 = 6_900_000;

/** Images from the chat UI, checked before they reach a model: type, size, count, and a well-formed thumbnail. */
export function validImages(images: unknown): ImageAttachment[] {
  if (!Array.isArray(images)) return [];
  const out: ImageAttachment[] = [];
  for (const raw of images.slice(0, MAX_IMAGES)) {
    const i = raw as Partial<ImageAttachment>;
    if (!i || typeof i.data !== 'string' || !IMAGE_TYPES.has(String(i.mediaType))) continue;
    if (i.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(i.data)) continue;
    const thumb = typeof i.thumb === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(i.thumb) && i.thumb.length < 80_000 ? i.thumb : undefined;
    out.push({ name: String(i.name ?? 'image').slice(0, 80), mediaType: i.mediaType as ImageAttachment['mediaType'], data: i.data, thumb });
  }
  return out;
}

function isSessionView(value: unknown): value is SessionView {
  return !!value && typeof value === 'object' && Array.isArray((value as SessionView).items);
}

function hooksHash(hooks: HooksConfig | undefined): string {
  return createHash('sha1').update(JSON.stringify(hooks ?? {})).digest('hex');
}

/** A hunk is the one the page showed with `header` (any hunk, when no header was sent). */
function isShown(hunk: Parameters<typeof hunkHeader>[0], header: unknown): boolean {
  return header === undefined || (typeof header === 'string' && hunkHeader(hunk) === header);
}
