import {
  AcpAgentPool,
  AGENT_CLIS,
  type AgentCliEntry,
  agentLaunchSpec,
  agentLogin,
  agentPolicy,
  checkAgentCli,
  customAgentEntry,
  type ExternalAgentRuntime,
  installHint,
  loginCommand,
  NOT_IN_CATALOG,
  pooledAgent,
  type AgentEvent,
  type AgentOption,
  type AIProvider,
  applyEvent,
  checkAppUpdate,
  createProvider,
  DEFAULT_SUBAGENTS,
  describeModel,
  emptySession,
  EXTERNAL_AGENTS,
  externalAgent,
  FileTaskStore,
  findExecutable,
  getLocale,
  inferModel,
  isChatModelId,
  isNewerVersion,
  listModels,
  loadSkills,
  buildCatalogServer,
  catalogAvailable,
  catalogCommandLine,
  catalogEntry,
  catalogRunKind,
  catalogServerName,
  findCatalogEntry,
  McpManager,
  type McpServerConfig,
  MODEL_CATALOG,
  type ModelInfo,
  newTaskId,
  normalizeLocale,
  type PermissionMode,
  type ProviderConfig,
  PROVIDER_KINDS,
  PROVIDER_PRESETS,
  PROVIDERS,
  type ProviderKind,
  releasePageUrl,
  resolveClaudeExecutable,
  type SessionView,
  setLocale,
  type Skill,
  SKILL_NAME,
  skillTemplate,
  systemLocale,
  t,
  type Tool,
  tooOldForAcp,
  VERSION,
} from '@orka/core';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { checkFolderPath } from './folderBrowser';
import type {
  AccountView,
  AgentCliView,
  AgentView,
  AppVersionView,
  ClaudeCodeStatus,
  ConfigView,
  EditorSelection,
  ExternalAgentView,
  FromWebview,
  ImageAttachment,
  LiveSessionView,
  McpServerView,
  ProviderView,
  SessionGroup,
  SessionOrganizeOp,
  SessionOrganizerView,
  SessionMessage,
  SessionModelView,
  SettingsTab,
  SkillView,
} from './protocol';
import { isSessionMessage } from './protocol';
import { RadarController, type RadarHooks, type RadarModel } from './radar';
import {
  type AgentChoice,
  type AppSettings,
  type CustomProviderDef,
  DESKTOP_SETTINGS,
  type Disposable,
  isAgentRef,
  isCustomRef,
  MODEL_SETTING,
  type ProviderRef,
  readMcpServers,
  readSettings,
  SHELL_CHOICES,
  WEBVIEW_SETTINGS,
} from './settings';
import {
  ACCOUNT_CLIS,
  ACCOUNT_COMMANDS,
  type AccountCli,
  type AccountStatus,
  copilotTokenVariable,
  isAccountCli,
  parseStatus,
  type ProbeRunner,
  profileId,
  runProbe,
} from './accounts';
import { type InstallRecipe, installRecipe, nodeIsRecent, nodeVersion } from './install';
import { RunGate, SharedAccounts } from './runGate';
import { EFFORT_SETTING, effortLevels, isOptionText, type SessionChoice, settingsEffort } from './sessionModel';
import { dropNotices, samePath, type SessionContext, SessionController } from './SessionController';
import type { AppShell, PickItem } from './shell';

const isModelId = (value: unknown): value is string => typeof value === 'string' && /^[\w.:/@-]{1,160}$/.test(value);
const secretKey = (ref: string) => `orka.apiKey.${ref}`;
const ENV_KEYS: Partial<Record<ProviderKind, string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};
const MODEL_CACHE_STATE = 'orka.modelCache';
const CLAUDE_UPDATE_STATE = 'orka.claudeCodeUpdatedAt';
/** How often model lists and Claude Code are refreshed in the background. */
const MODEL_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Tasks per folder in the desktop app's session list. */
const MAX_SESSION_TASKS = 30;
/** The user's own groups of sessions and the sessions they hid (desktop session list). */
const SESSION_ORGANIZER_STATE = 'orka.sessionOrganizer';
const MAX_SESSION_GROUPS = 50;
const ORGANIZER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP_UPDATE_STATE = 'orka.appUpdate';
/** How often a running app looks again whether the daily update check is due. */
const APP_UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
/** Sessions kept open at once in the desktop app; one more closes the least recently used idle one. */
const MAX_LIVE_SESSIONS = 8;

/** The last answer about Orka releases, and the version the user was already told about. */
interface AppUpdateState {
  /** The last attempt, answered or not: the next background check waits a day after it. */
  checkedAt?: number;
  etag?: string;
  latest?: string;
  url?: string;
  notified?: string;
  /** Why the last attempt got no answer (cleared by the next answer). */
  error?: string;
}
/** Global skills folder shared by the VS Code extension, the desktop app and the CLI. */
export const USER_SKILLS_DIR = path.join(homedir(), '.orka', 'skills');

export interface AppControllerOptions {
  /** Tests: Radar's network, clock, timers and feeds. */
  radar?: RadarHooks;
  /** Tests: what runs a CLI's account status command. */
  probe?: ProbeRunner;
}

/**
 * Connects the chat UI to the session of the current folder (its orchestrator, task, changes and
 * files: a SessionController), and owns what all sessions share: settings, secret storage,
 * providers, skills, MCP servers and Radar. The same controller runs in the VS Code extension and
 * in the desktop app; everything platform-specific goes through the AppShell. The main agent, the
 * supervisor and each sub-agent can run on any provider and model.
 */
export class AppController implements Disposable {
  private settings: AppSettings;
  /** API keys by provider ref (built-in kind or "custom:<id>"). */
  private readonly apiKeys = new Map<string, string>();
  /** Models reported by a provider's own model list (built-in providers). */
  private readonly discoveredModels = new Map<string, string[]>();
  private readonly disposables: Disposable[] = [];
  /** Provider instances by configuration, shared by all agent roles. */
  private readonly providers = new Map<string, AIProvider>();
  private providersStale = false;
  /** The config the page was last sent (with an init or alone), as JSON: the same one is not sent again. */
  private sentConfig?: string;
  /** Open sessions by id (at most one per folder), and the one the chat UI shows: the current folder's. */
  private readonly sessions = new Map<string, SessionController>();
  private activeId?: string;
  private readonly sessionContext: SessionContext;
  /** What the chat UI shows while no folder is open: notices only. */
  private idleView: SessionView = emptySession();
  private readonly idleTaskId = newTaskId();
  private claudeCodeStatus: ClaudeCodeStatus = { state: 'unknown' };
  /** Claude Code was ready when its check under way started (it counts as ready until that check says otherwise). */
  private claudeCodeWasReady = false;
  /** Agent CLIs that were ready when their check under way started. */
  private readonly agentsWereReady = new Set<string>();
  /** Built-in and user skills (all of them; disabled ones are filtered when a task starts). */
  private skills: Skill[] = [];
  private builtinSkillNames = new Set<string>();
  private skillErrors: string[] = [];
  /** MCP servers from the settings, kept running across tasks and shared by every session (a folder's .mcp.json servers are its session's). */
  private readonly mcp = new McpManager(() => this.postConfig());
  private appUpdateCheck?: Promise<void>;
  private appUpdateTimer?: ReturnType<typeof setInterval>;
  /** Sessions that may run at once: the process budget and one session per folder (and the folders inside it). */
  private readonly gate: RunGate;
  /**
   * Agent CLI processes (ACP), shared by the tasks of every folder; and what their last check found.
   * The cap stays above the session budget, so a session the gate lets run finds room for its agent.
   */
  private readonly acpPool = new AcpAgentPool({ max: () => Math.max(4, this.maxRunning() + 1) });
  private readonly agentStatus = new Map<string, AgentCliView['status']>();
  /** "No Supervisor next to this agent" was said once already. */
  private supervisorSkipNoted = false;
  /** Agent CLIs the "provider" setting named while turned off, already said once. */
  private readonly droppedMainNoted = new Set<string>();
  /** The desktop app's Radar (VS Code and the CLI have none). */
  private readonly radar?: RadarController;
  /**
   * What each CLI's own status command last said, by "<cli>" or "claude-code:<profile>": in memory
   * only, asked when the settings ask and after a sign-in terminal closes, never on a timer.
   */
  private readonly accountStatus = new Map<string, AccountStatus>();
  private readonly probe: ProbeRunner;

  constructor(
    private readonly shell: AppShell,
    options: AppControllerOptions = {},
  ) {
    this.probe = options.probe ?? runProbe;
    // One profile of a CLI at a time across every Orka window and app: they share <orka home>/accounts.
    this.gate = new RunGate(() => this.maxRunning(), new SharedAccounts(path.join(shell.orkaHome ?? (process.env.ORKA_HOME || path.join(homedir(), '.orka')), 'accounts')));
    this.settings = readSettings(shell.settings);
    this.sessionContext = this.createSessionContext();
    this.applyLocale();
    if (shell.kind === 'desktop' && shell.orkaHome) {
      this.radar = new RadarController(
        path.join(shell.orkaHome, 'radar'),
        this.settings.radar,
        {
          post: (message) => this.shell.post(message),
          model: () => this.radarModel(),
          createProvider: (ref, model) => this.radarProvider(ref, model),
          startSession: (text) => this.startRadarSession(text),
          openExternal: (url) => this.shell.openExternal(url),
          ...(shell.pickSaveFile
            ? { pickSaveFile: (suggested: string) => shell.pickSaveFile!({ title: t('Save the Radar report as Markdown'), suggested, filters: { Markdown: ['md'] } }) }
            : {}),
          info: (text) => void this.shell.message('info', text),
        },
        options.radar,
      );
    }
    shell.setMessageHandler((m) => void this.handleMessage(m).catch((e) => this.reportError(e)));
    this.disposables.push(
      shell.watch('skills', () => void this.reloadSkills()),
      shell.watch('mcpConfig', () => void this.readWorkspaceMcp().then(() => this.postConfig())),
      shell.settings.onDidChange(() => void this.onSettingsChanged()),
      shell.onDidChangeFolder(() => this.onFolderChanged()),
    );
    const secrets = shell.secrets.onDidChange?.((key) => {
      const ref = this.keyedProviders().find((r) => secretKey(r) === key);
      if (ref) void this.loadApiKey(ref).then(() => this.postConfig());
    });
    if (secrets) this.disposables.push(secrets);
    this.updateStatus();
  }

  async initialize(): Promise<void> {
    await Promise.all([...this.keyedProviders().map((ref) => this.loadApiKey(ref)), this.reloadSkills(false)]);
    this.onFolderChanged();
    void (this.settings.claudeCode.enabled ? this.checkClaudeCode() : Promise.resolve()).then(() => this.scheduledUpdates());
    void this.readWorkspaceMcp().then(() => this.postConfig());
    void this.checkAppUpdate();
    this.appUpdateTimer = setInterval(() => void this.checkAppUpdate(), APP_UPDATE_POLL_MS);
    this.appUpdateTimer.unref?.();
    // Every catalog agent too, so the main agent picker can say which are installed (a version
    // flag only, and only for a program found on PATH or at the user's path).
    for (const entry of this.agentEntries()) if (entry.kind === 'builtin' || this.settings.agentClis.enabled.includes(entry.id)) void this.checkAgent(entry.id);
    this.noteDroppedMainAgent();
    await this.radar?.initialize();
  }

  /** Says once that the "provider" setting names an agent CLI that is turned off, and what runs instead. */
  private noteDroppedMainAgent(): void {
    const id = this.settings.droppedMainAgent;
    if (!id || this.droppedMainNoted.has(id)) return;
    this.droppedMainNoted.add(id);
    const label = this.agentEntry(id)?.label ?? id;
    this.publishNotice('warning', t('Main agent {agent} is turned off; using {fallback}.', { agent: label, fallback: this.providerLabel(this.mainProvider()) }), 'agentClis');
  }

  private updateSetting(key: string, value: unknown, options?: { preferGlobal?: boolean }): Promise<void> {
    return this.shell.settings.update(key, value, options);
  }

  /**
   * UI language: the setting, or on "auto" the surrounding app's display language when it is not
   * English (a VS Code language pack), otherwise the operating system's regional language.
   */
  private applyLocale(): void {
    const setting = this.settings.language;
    if (setting !== 'auto') {
      setLocale(setting);
      return;
    }
    const appLanguage = this.shell.appLanguage;
    setLocale(appLanguage && normalizeLocale(appLanguage) !== 'en' ? appLanguage : systemLocale());
  }

  // ---------------------------------------------------------------- chat UI messages

  async handleMessage(message: FromWebview): Promise<void> {
    if (isSessionMessage(message)) {
      // The session the page named; none: the one shown. A session that is gone gets nothing,
      // so a message sent before a switch never acts on another session.
      const id: unknown = message.sessionId;
      if (id === undefined) {
        const session = this.activeSession;
        if (session) await session.handle(message);
        else await this.withoutSession(message);
      } else if (typeof id === 'string') {
        await this.sessions.get(id)?.handle(message);
      }
      return;
    }
    switch (message.type) {
      case 'ready':
        this.postInit();
        this.radar?.postAll();
        break;
      case 'newTask':
        await (message.other === true ? this.newTaskElsewhere(message.folder) : this.newTask(message.folder));
        break;
      case 'setMode':
        await this.updateSetting('permissionMode', message.mode);
        break;
      case 'setAgent':
        await this.setAgent(message.agent, message.provider, message.model);
        break;
      case 'customModel':
        await this.promptCustomModel(message.agent);
        break;
      case 'setSetting':
        await this.applyWebviewSetting(message.key, message.value);
        break;
      case 'setApiKey':
        await this.promptApiKey(message.provider);
        break;
      case 'clearApiKey':
        await this.clearApiKey(message.provider);
        break;
      case 'addProvider':
        await this.addProvider(message.preset);
        break;
      case 'removeProvider':
        await this.removeProvider(message.id);
        break;
      case 'loadModels':
        await this.loadModels(message.provider, true);
        break;
      case 'checkClaudeCode':
        await this.checkClaudeCode();
        break;
      case 'toggleAgentCli':
        await this.toggleAgentCli(message.id, message.enabled === true);
        break;
      case 'checkAgentCli':
        await this.checkAgent(message.id);
        break;
      case 'loginAgentCli':
        this.loginAgentCli(message.id);
        break;
      case 'pickAgentExecutable':
        await this.pickAgentExecutable(message.id);
        break;
      case 'resetAgentExecutable':
        await this.setAgentPath(message.id, undefined);
        break;
      case 'addCustomAgent':
        await this.addCustomAgent();
        break;
      case 'removeCustomAgent':
        await this.removeCustomAgent(message.id);
        break;
      case 'installCli':
        await this.installCli(message.id);
        break;
      case 'checkInstall':
        await this.checkInstalled(message.id);
        break;
      case 'checkAccounts':
        await this.checkAccounts();
        break;
      case 'checkAccount':
        await this.checkAccount(message.cli, message.profile);
        break;
      case 'loginAccount':
        this.loginAccount(message.cli, message.profile);
        break;
      case 'logoutAccount':
        await this.logoutAccount(message.cli, message.profile);
        break;
      case 'addClaudeProfile':
        await this.addClaudeProfile(message.name);
        break;
      case 'removeClaudeProfile':
        await this.removeClaudeProfile(message.id);
        break;
      case 'setClaudeProfile':
        await this.setClaudeProfile(message.id);
        break;
      case 'openAgentLink': {
        const entry = this.agentEntry(message.id);
        const policy = agentPolicy(entry?.policy ?? '');
        const url = message.link === 'terms' ? policy?.termsUrl : message.link === 'faq' ? policy?.faqUrl : entry?.docsUrl;
        if (url?.startsWith('https://')) await this.shell.openExternal(url);
        break;
      }
      case 'updateClaudeCode':
        await this.updateClaudeCode();
        break;
      case 'checkForUpdates':
        await this.checkForUpdates();
        break;
      case 'checkAppUpdate':
        await this.checkAppUpdate(true);
        break;
      case 'openRelease': {
        const update = this.appVersionView().update;
        if (update) await this.shell.openExternal(update.url);
        break;
      }
      case 'pickClaudeExecutable':
        await this.pickClaudeExecutable();
        break;
      case 'resetClaudeExecutable':
        await this.updateSetting('claudeCode.path', '');
        await this.checkClaudeCode();
        break;
      case 'openSettings':
        await this.shell.openSettings('all');
        break;
      case 'listTasks':
        await this.postHistory();
        break;
      case 'listSessions':
        await this.postSessions();
        break;
      case 'organizeSessions':
        await this.organizeSessions(message);
        break;
      case 'openTask':
        await this.openTask(message.id, message.folder);
        break;
      case 'deleteTask':
        await this.deleteTask(message.id, message.folder);
        break;
      case 'openFile':
        await this.shell.openFile(message.path, { preview: true });
        break;
      case 'toggleSkill':
        await this.toggleSkill(message.name, message.enabled);
        break;
      case 'openSkill':
        await this.openSkill(message.name);
        break;
      case 'customizeSkill':
        await this.customizeSkill(message.name);
        break;
      case 'newSkill':
        await this.newSkill();
        break;
      case 'openSkillsFolder':
        await this.openSkillsFolder();
        break;
      case 'reloadSkills':
        await this.reloadSkills();
        break;
      case 'selectFolder':
        await this.selectFolder(message.path);
        break;
      case 'openFolder':
        // A path from the page is used only when it is an absolute one; none: the system's dialog.
        if (message.path === undefined || message.path === '') await this.selectFolder(undefined);
        else {
          const target = checkFolderPath(message.path);
          if (target) await this.selectFolder(target);
        }
        break;
      case 'listFolders':
        await this.listFolders(message);
        break;
      case 'createFolder':
        await this.createFolder(message);
        break;
      case 'switchSession':
        await this.switchSession(message.sessionId);
        break;
      case 'closeSession':
        await this.closeSession(message.sessionId);
        break;
      case 'toggleMcpServer':
        await this.setMcpServerEnabled(message.name, message.enabled);
        break;
      case 'importMcp':
        await this.importMcpFromClaude();
        break;
      case 'restartMcp':
        this.mcp.restart();
        this.activeSession?.mcp.restart();
        break;
      case 'editMcpServers':
        await this.shell.openSettings('mcpServers');
        break;
      case 'addMcpFromCatalog':
        await this.addMcpFromCatalog(message.id, message.values);
        break;
      case 'openMcpCatalogLink': {
        const entry = catalogEntry(message.id);
        const url =
          message.link === 'setup' ? entry?.setup?.link : message.link === 'field' ? entry?.fields.find((f) => f.name === message.field)?.link : entry?.homepage;
        if (url?.startsWith('https://')) await this.shell.openExternal(url);
        break;
      }
      case 'radar':
        if (message.action === 'poll') await this.radar?.poll();
        else if (message.action === 'analyze') await this.radar?.analyze();
        else if (message.action === 'stop') this.radar?.stopAnalysis();
        else if (message.action === 'retry') await this.radar?.retry();
        else if (message.action === 'openNotes') await this.radar?.openNotes();
        else if (message.action === 'saveMarkdown') await this.radar?.saveMarkdown();
        break;
      case 'radarStartSession':
        if (typeof message.cluster === 'string') await this.radar?.startSession(message.cluster);
        break;
      case 'radarOpenLink':
        if (typeof message.url === 'string') await this.radar?.openLink(message.url);
        break;
      case 'dialogResult':
        // Answered inside the shell that asked.
        break;
    }
  }

  /** A session's message while no folder is open: a request or a hand-off says why nothing happens. */
  private async withoutSession(message: SessionMessage): Promise<void> {
    switch (message.type) {
      case 'send':
        await this.send(message.text);
        break;
      case 'handoff':
        await this.handOff(message.agent, message.text);
        break;
      case 'searchFiles':
        this.shell.post({ type: 'fileMatches', query: message.query, files: [] });
        break;
      case 'acceptChange':
      case 'revertChange':
      case 'revertHunk':
      case 'keepHunk':
        this.requireSession();
        break;
    }
  }

  private async applyWebviewSetting(key: string, value: unknown): Promise<void> {
    if (key.startsWith('model:')) {
      // A provider's default model (Settings > Providers).
      const ref = key.slice('model:'.length);
      if (isModelId(value)) await this.setDefaultModel(ref, value);
      return;
    }
    if (DESKTOP_SETTINGS.has(key) && this.shell.kind !== 'desktop') return;
    // Radar runs on a provider the user set up (the validator already refuses agent CLIs and Claude Code).
    if (key === 'radar.provider' && value !== '' && !this.allProviderRefs().includes(value as ProviderRef)) return;
    if (WEBVIEW_SETTINGS[key]?.(value)) await this.updateSetting(key, value);
  }

  // ---------------------------------------------------------------- the session shown

  /** The session the chat UI shows (undefined while no folder is open). */
  get activeSession(): SessionController | undefined {
    return this.activeId === undefined ? undefined : this.sessions.get(this.activeId);
  }

  private anyRunning(): boolean {
    return [...this.sessions.values()].some((s) => s.isRunning);
  }

  private requireSession(): SessionController {
    const session = this.activeSession;
    if (!session) throw new Error('No workspace folder is open.');
    return session;
  }

  /** The page shows the active session's task (or, without a folder, the notices only) from scratch. */
  private postInit(): void {
    const session = this.activeSession;
    if (session) session.postInit();
    else this.shell.post({ type: 'init', session: this.idleView, config: this.configForPage(), taskId: this.idleTaskId });
  }

  private createSessionContext(): SessionContext {
    return {
      shell: this.shell,
      settings: () => this.settings,
      isActive: (session) => session.id === this.activeId,
      show: (session) => void this.showSession(session),
      providerFor: (name, session) => this.providerFor(name, session),
      externalAgent: (root) => this.externalAgent(root),
      mcpTools: (session) => this.mcpTools(session),
      skills: () => this.skills,
      activeSkills: () => this.activeSkills(),
      reloadSkills: (post) => this.reloadSkills(post),
      inheritsNoModel: (name) => this.inheritsNoModel(name),
      readyToSend: (session) => this.readyToSend(session),
      mainReady: () => this.isReady(this.mainProvider()),
      isInstalled: (id, fresh) => this.isInstalled(id, fresh),
      agentEvent: (event) => this.onAgentEvent(event),
      configView: () => this.configForPage(),
      postConfig: () => this.postConfig(),
      postHistory: () => this.postHistory(),
      changed: () => {
        this.updateStatus();
        this.postLive();
      },
      userSaved: (session, real, before, after) => {
        for (const other of this.sessions.values()) if (other !== session) other.noteOutsideSave(real, before, after);
      },
      runFinished: () => {
        // Providers waiting for an idle moment are rebuilt once no session uses them.
        if (this.providersStale && !this.anyRunning()) this.disposeProviders();
        // A Claude Code update the user asked for while a session ran.
        if (this.claudeUpdateWaiting && !this.anyRunning()) void this.updateClaudeCode();
      },
      gate: this.gate,
      runAccounts: (session) => this.runAccounts(session),
      defaultChoice: () => this.defaultChoice(),
      sessionChoice: (session) => this.sessionChoice(session),
      setSessionModel: (session, change) => this.setSessionModel(session, change),
      useModelAsDefault: (session) => this.useModelAsDefault(session),
      agentOptionsChanged: (session) => {
        if (session.id === this.activeId) this.postConfig();
      },
      accountLabel: (account) => this.accountLabel(account),
    };
  }

  /** Sessions that may run at once: the setting in the desktop app; the VS Code panel has one session. */
  private maxRunning(): number {
    return this.shell.kind === 'desktop' ? this.settings.sessions.maxRunning : 1;
  }

  /**
   * Several sessions at once, each in its own folder, run in the desktop app's IDE layout only. The
   * VS Code panel and the classic layout show one session, and a folder change ends it.
   */
  private parallel(): boolean {
    return this.shell.kind === 'desktop' && this.settings.desktop.layout === 'ide';
  }

  /** The open session of a folder (at most one per folder). */
  private liveFor(folder: string): SessionController | undefined {
    return [...this.sessions.values()].find((s) => samePath(s.root, folder));
  }

  /**
   * The shell works in another folder (or the app starts): show that folder's session. With
   * parallel sessions, the one shown before keeps running in the background and the folder's open
   * session is shown as it is; otherwise the one shown before ends first (see endActive).
   */
  private onFolderChanged(): void {
    if (!this.parallel()) {
      this.endActive();
      // Idle sessions left from the IDE layout end too: the folder gets a new empty task, as a folder change gives.
      for (const session of [...this.sessions.values()]) {
        if (session.busy) continue;
        this.sessions.delete(session.id);
        void session.dispose();
      }
    }
    const folder = this.shell.currentFolder();
    if (!folder) {
      this.activeId = undefined;
      this.shell.attach(undefined, this.settings);
      this.idleView = emptySession();
      this.postInit();
      this.updateStatus();
      this.postLive();
      return;
    }
    let session = this.liveFor(folder.path);
    if (!session) {
      if (!this.makeRoom()) {
        void this.shell.message('info', t('Too many open sessions. Close one first.'));
        // The shell goes back to the session shown; its change shows that session again.
        const shown = this.activeSession;
        if (shown) void this.shell.selectFolder(shown.root);
        return;
      }
      session = new SessionController(this.sessionContext, folder.path);
      this.sessions.set(session.id, session);
    }
    this.activate(session);
  }

  /**
   * The session shown ends: it saves its task, lets go of an open hand-off, stops its processes and
   * answers open approvals "no".
   */
  private endActive(): void {
    const session = this.activeSession;
    if (!session) return;
    this.sessions.delete(session.id);
    this.activeId = undefined;
    void session.dispose();
  }

  /**
   * Idle sessions end, so the next ones get a host with the new settings: the session shown is
   * created again with an empty task (as a folder change does), the others close (their tasks stay
   * in the list). A running session, and in the IDE layout one with a hand-off open, keeps its host.
   */
  private renewHosts(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.busy || session.id === this.activeId) continue;
      this.sessions.delete(session.id);
      void session.dispose();
    }
    const shown = this.activeSession;
    // The VS Code panel and the classic layout renew a shown session with a hand-off, as before.
    if (shown && (this.parallel() ? shown.busy : shown.isRunning)) {
      this.postLive();
      return;
    }
    this.endActive();
    this.onFolderChanged();
  }

  /** The page shows this session from now on (from scratch: its whole transcript). */
  private activate(session: SessionController): void {
    const previous = this.activeSession;
    if (previous) previous.lastActive = Date.now();
    this.activeId = session.id;
    session.lastActive = Date.now();
    this.shell.attach(session.orchestrator, this.settings);
    session.postInit();
    this.updateStatus();
    this.postLive();
    void session.workspaceMcp().then(() => this.postConfig());
  }

  /**
   * Room for one more open session: at the cap, the least recently used idle session that is not
   * shown is closed (one without changes to review first); its task stays in the list. A session
   * that runs or has a hand-off open is never closed: false when every other session does.
   */
  private makeRoom(): boolean {
    if (this.sessions.size < MAX_LIVE_SESSIONS) return true;
    const oldest = this.closable();
    if (!oldest) return false;
    this.sessions.delete(oldest.id);
    void oldest.dispose();
    return true;
  }

  private hasRoom(): boolean {
    return this.sessions.size < MAX_LIVE_SESSIONS || !!this.closable();
  }

  /** The session makeRoom closes, if any. */
  private closable(): SessionController | undefined {
    const idle = [...this.sessions.values()].filter((s) => s.id !== this.activeId && !s.busy);
    return idle.sort((a, b) => Number(a.hasPendingWork) - Number(b.hasPendingWork) || a.lastActive - b.lastActive)[0];
  }

  /** Show another open session (desktop IDE layout); nothing of either session stops. */
  private async switchSession(id: unknown): Promise<void> {
    if (!this.parallel() || typeof id !== 'string') return;
    const session = this.sessions.get(id);
    if (!session || session.id === this.activeId) return;
    // The shell works in the session's folder; its change shows the session (onFolderChanged).
    if (!(await this.shell.selectFolder(session.root))) this.postConfig(true);
  }

  /**
   * Show a session that waits in the background ("Show" on its approval notice). In the IDE layout
   * the page switches, so a file with unsaved changes in its editor is asked about first. In the
   * classic layout this is a folder change, which ends the session shown (refused while that one runs).
   */
  private async showSession(session: SessionController): Promise<void> {
    if (this.sessions.get(session.id) !== session || session.id === this.activeId) return;
    if (this.parallel()) this.shell.post({ type: 'showSession', id: session.id });
    else await this.selectFolder(session.root);
  }

  /**
   * Close an idle session that is not shown (desktop IDE layout); its task stays in the list. One
   * with a hand-off open stays: the external agent still changes files in its folder.
   */
  private async closeSession(id: unknown): Promise<void> {
    if (!this.parallel() || typeof id !== 'string') return;
    const session = this.sessions.get(id);
    if (!session || session.id === this.activeId || session.isRunning) return;
    if (session.busy) {
      void this.shell.message('info', t('This session has a hand-off open. Close its terminal first, then close the session.'));
      return;
    }
    this.sessions.delete(session.id);
    await session.dispose();
    this.postLive();
    await this.postSessions();
  }

  /** The open sessions as the desktop session list shows them. */
  private liveViews(): LiveSessionView[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      folder: s.root,
      name: path.basename(s.root) || s.root,
      taskId: s.taskId,
      title: s.title(),
      state: s.state,
      approvals: s.approvals,
    }));
  }

  private postLive(): void {
    if (!this.parallel()) return;
    this.shell.post({ type: 'live', sessions: this.liveViews(), activeId: this.activeId, maxRunning: this.maxRunning() });
  }

  // ---------------------------------------------------------------- agent actions

  async send(text: string, files: string[] = [], skillNames: string[] = [], images: ImageAttachment[] = [], editor?: EditorSelection): Promise<void> {
    if (!text.trim()) return;
    const session = this.activeSession;
    if (!session) {
      void this.shell.message('warning', this.noFolderText());
      return;
    }
    await session.send(text, files, skillNames, images, editor);
  }

  /** The main agent's provider can take a request; when not, the session says why. */
  private readyToSend(session: SessionController): boolean {
    const main = this.mainProvider();
    const agent = this.agentFor(main);
    if (agent && !this.isReady(main)) {
      const status = this.agentStatus.get(agent.id);
      session.publishNotice(
        'error',
        status?.state === 'not_found'
          ? t('{agent} is not installed. Install it ({hint}), then check it again in Settings > Providers.', { agent: agent.label, hint: installHint(agent) || '?' })
          : t('{agent} could not be started: {error}', { agent: agent.label, error: status?.detail ?? '?' }),
        'agentClis',
      );
      return false;
    }
    if (!this.isReady(main)) {
      session.publishNotice(
        'error',
        t('No API key set for {provider}. Add one (kept in secure storage on this machine), or pick another provider for the main agent.', {
          provider: this.providerLabel(main),
        }),
        `setApiKey:${main}`,
      );
      return false;
    }
    if (agent && this.settings.supervisor.enabled && !this.supervisorSkipNoted && this.inheritsNoModel('supervisor')) {
      this.supervisorSkipNoted = true;
      session.publishNotice(
        'info',
        t('No Supervisor while {agent} is the main agent: it needs a model provider of its own. Add an API key, or pick a provider for the Supervisor in Settings > Agents.', {
          agent: agent.label,
        }),
      );
    }
    return true;
  }

  private noFolderText(): string {
    return this.shell.canOpenFolder ? t('Orka: open a folder first.') : t('Orka: open a folder or workspace first.');
  }

  /** Start a task from a command (or programmatically with `text`). */
  async ask(text?: string): Promise<void> {
    const prompt =
      text ??
      (await this.shell.input({
        title: t('Orka: run a task'),
        placeHolder: t('e.g. Add a ready state to the lobby and limit it to 4 players'),
      }));
    if (!prompt?.trim()) return;
    this.shell.reveal();
    await this.send(prompt);
  }

  stop(): void {
    this.activeSession?.stop();
  }

  async rewind(id: string): Promise<void> {
    await this.activeSession?.rewind(id);
  }

  /**
   * Archive the current task in the history and start an empty one. With a folder (the desktop
   * app's session list), the new task is in that recent folder; without any folder, one is picked.
   */
  async newTask(folder?: string): Promise<void> {
    if (folder !== undefined || !this.activeSession) {
      const target = folder === undefined ? undefined : this.recentFolder(folder);
      if (folder !== undefined && !target) return;
      // Another folder starts with a new task of its own.
      if (!target || !this.isCurrentFolder(target)) {
        const live = target === undefined ? undefined : this.liveFor(target);
        await this.selectFolder(target);
        if (!live || !target || !this.isCurrentFolder(target)) return;
        // The folder's open session is shown; one that runs goes on (its request is not stopped for a new task).
        if (live.isRunning) {
          this.noteRunningInFolder(live);
          return;
        }
      }
    }
    // Parallel sessions: "New session" in the folder of the session that runs is another session
    // there, which waits; the running one goes on (only Stop ends a request).
    const shown = this.activeSession;
    if (shown?.isRunning && this.parallel()) {
      this.noteRunningInFolder(shown);
      return;
    }
    await shown?.newTask();
  }

  /**
   * A new task in a folder that need not be a recent one (desktop "New session" > "Other folder…"):
   * a path chosen in the app's folder picker, or none: the system's dialog chooses. The folder's
   * session is shown with a new empty task, unless it runs.
   */
  private async newTaskElsewhere(folder?: string): Promise<void> {
    let target = folder === undefined ? undefined : checkFolderPath(folder);
    if (folder !== undefined && !target) return;
    // The dialog chooses first, so the open folder chosen there also starts a new task.
    if (!target && this.shell.chooseFolder) {
      const chosen = await this.shell.chooseFolder();
      if (!chosen) return;
      target = checkFolderPath(chosen);
      if (!target) return;
    }
    if (target && this.isCurrentFolder(target)) return this.newTask(target);
    const before = this.activeSession;
    await this.selectFolder(target);
    const shown = this.activeSession;
    // Nothing chosen, or the switch was refused (a notice says why).
    if (!shown || shown === before || shown.isEmpty) return;
    if (shown.isRunning) {
      this.noteRunningInFolder(shown);
      return;
    }
    await shown.newTask();
  }

  private noteRunningInFolder(session: SessionController): void {
    void this.shell.message(
      'info',
      t('A session is already running in {folder}. Orka runs one session at a time per folder; stop it or wait, then start a new one.', {
        folder: path.basename(session.root) || session.root,
      }),
    );
  }

  async compact(): Promise<void> {
    await this.activeSession?.compact();
  }

  acceptAll(): void {
    this.activeSession?.acceptAll();
  }

  async revertAll(): Promise<void> {
    await this.activeSession?.revertAll();
  }

  /** Keep one part of a change (the rest stays reviewable). */
  async keepHunk(absPath: string, index: number, header?: string): Promise<void> {
    await this.requireSession().keepHunk(absPath, index, header);
  }

  async openChangeDiff(absPath: string): Promise<void> {
    await this.shell.openChangeDiff(absPath);
  }

  /** Undo one part of a change; see SessionController.revertHunk. */
  async revertHunk(absPath: string, index: number, header?: string): Promise<void> {
    await this.requireSession().revertHunk(absPath, index, header);
  }

  async initMemory(): Promise<void> {
    await this.activeSession?.initMemory();
  }

  /** Continue the task in an external agent; see SessionController.handOff. */
  async handOff(agentId: string, text?: string): Promise<void> {
    if (!externalAgent(agentId)) return;
    const session = this.activeSession;
    if (!session) {
      void this.shell.message('warning', this.noFolderText());
      return;
    }
    await session.handOff(agentId, text);
  }

  /** Notices about the app itself (an update, a sign-in) go to the session shown. */
  private publishNotice(level: 'info' | 'warning' | 'error', message: string, action?: string): void {
    const session = this.activeSession;
    if (session) {
      session.publishNotice(level, message, action);
      return;
    }
    const event = { type: 'notice' as const, level, message, action };
    applyEvent(this.idleView, event);
    this.shell.post({ type: 'event', event });
  }

  // ---------------------------------------------------------------- skills

  /** Skills offered to new tasks: all loaded skills minus the disabled ones. */
  private activeSkills(): Skill[] {
    if (!this.settings.skills.enabled) return [];
    const disabled = new Set(this.settings.skills.disabled);
    return this.skills.filter((s) => !disabled.has(s.name));
  }

  async reloadSkills(post = true): Promise<void> {
    const builtinDir = this.shell.builtinSkillsDir;
    const [builtin, all] = await Promise.all([
      loadSkills([{ dir: builtinDir, source: 'builtin' }]),
      loadSkills([
        { dir: builtinDir, source: 'builtin' },
        { dir: USER_SKILLS_DIR, source: 'user' },
      ]),
    ]);
    this.builtinSkillNames = new Set(builtin.skills.map((s) => s.name));
    this.skills = all.skills;
    this.skillErrors = all.errors;
    if (post) this.postConfig();
  }

  private async toggleSkill(name: string, enabled: boolean): Promise<void> {
    if (!SKILL_NAME.test(name)) return;
    const disabled = new Set(this.settings.skills.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.updateSetting('skills.disabled', [...disabled].sort());
  }

  private async openSkill(name: string): Promise<void> {
    const skill = this.skills.find((s) => s.name === name);
    if (skill) await this.shell.openFile(skill.path, { preview: true });
  }

  /** Copy a built-in skill into the user folder, where it overrides the built-in one, and open it. */
  private async customizeSkill(name: string): Promise<void> {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return;
    const target = path.join(USER_SKILLS_DIR, `${name}.md`);
    if (skill.source === 'builtin' && !existsSync(target)) {
      await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
      await fs.copyFile(skill.path, target);
      await this.reloadSkills();
    }
    await this.shell.openFile(skill.source === 'user' ? skill.path : target);
  }

  async newSkill(): Promise<void> {
    const name = (
      await this.shell.input({
        title: t('New skill'),
        prompt: t('Name of the skill: lowercase letters, digits and dashes (e.g. "api-design").'),
        validate: (v) =>
          !SKILL_NAME.test(v.trim())
            ? t('Use lowercase letters, digits and dashes.')
            : this.skills.some((s) => s.name === v.trim() && s.source === 'user')
              ? t('A skill with this name already exists.')
              : undefined,
      })
    )?.trim();
    if (!name) return;
    await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
    const file = path.join(USER_SKILLS_DIR, `${name}.md`);
    // "wx": create only if missing, in one step (an existing skill is opened as it is).
    await fs.writeFile(file, skillTemplate(name), { encoding: 'utf8', flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await this.shell.openFile(file);
    await this.reloadSkills();
  }

  async openSkillsFolder(): Promise<void> {
    await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
    await this.shell.openExternal(USER_SKILLS_DIR);
  }

  // ---------------------------------------------------------------- MCP servers

  /** The active session's .mcp.json read again (nothing without a folder). */
  private async readWorkspaceMcp(): Promise<void> {
    await this.activeSession?.workspaceMcp();
  }

  /**
   * Tools of the MCP servers for a new task of this session (started on demand, kept running across
   * tasks): the settings' servers, which the app runs for every session, and the session folder's
   * .mcp.json servers once the user allowed them, which run in that session only (a task in another
   * folder neither stops nor sees them).
   */
  private async mcpTools(session: SessionController): Promise<Tool[]> {
    if (!this.settings.mcp.enabled) {
      this.mcp.sync({});
      session.mcp.sync({});
      return [];
    }
    const own = this.settings.mcp.servers;
    this.mcp.sync(own);
    session.mcp.sync(await session.trustedMcpServers(Object.keys(own), true));
    const [shared, workspace] = await Promise.all([this.mcp.tools(), session.mcp.tools()]);
    // Tool names are cleaned server names: two servers can still end up with one name.
    const names = new Set(shared.map((tool) => tool.name));
    return [...shared, ...workspace.filter((tool) => !names.has(tool.name))];
  }

  private async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    const servers = { ...this.settings.mcp.servers };
    if (servers[name]) {
      servers[name] = { ...servers[name], disabled: enabled ? undefined : true };
      await this.updateSetting('mcpServers', servers);
      return;
    }
    // A server of the active session's folder: switching it on means trusting the file, off means not.
    await this.activeSession?.setMcpTrust(name, enabled, Object.keys(servers));
    this.postConfig();
  }

  /** The settings' servers as the app runs them, and the active session folder's .mcp.json servers as that session runs them. */
  private mcpView(): ConfigView['mcp'] {
    const session = this.activeSession;
    const status = new Map([...(session?.mcp.status() ?? []), ...this.mcp.status()].map((s) => [s.name, s]));
    const workspace = session?.workspaceMcpServers ?? { servers: {}, hash: '' };
    const workspaceAllowed = !!session?.mcpTrusted;
    const view = (name: string, config: McpServerConfig, source: McpServerView['source']): McpServerView => {
      const s = status.get(name);
      return {
        name,
        source,
        transport: 'url' in config ? 'http' : 'stdio',
        target: 'url' in config ? config.url : [config.command, ...(config.args ?? [])].join(' '),
        enabled: source === 'workspace' ? workspaceAllowed : !config.disabled,
        state: s?.state ?? 'idle',
        tools: s?.tools ?? 0,
        error: s?.error,
        catalogId: findCatalogEntry(name, config, process.platform)?.id,
      };
    };
    const own = this.settings.mcp.servers;
    return {
      enabled: this.settings.mcp.enabled,
      platform: process.platform,
      servers: [
        ...Object.entries(own).map(([n, c]) => view(n, c, 'settings')),
        ...Object.entries(workspace.servers)
          .filter(([n]) => !(n in own))
          .map(([n, c]) => view(n, c, 'workspace')),
      ],
    };
  }

  /**
   * Add a server from Orka's bundled catalog. The page names only an entry and the values of that
   * entry's fields; the command, URL and everything else come from the catalog. A modal shows the
   * exact command or URL and what starting it means (a package runner downloads third-party code
   * on its first start) and only "Add and turn on" writes it, switched on, to the user-level MCP list.
   * Values never appear in a message or a log; secret ones are not shown again.
   */
  async addMcpFromCatalog(id: string, values: unknown): Promise<void> {
    const entry = catalogEntry(id);
    if (!entry) return;
    if (!catalogAvailable(entry, process.platform)) {
      void this.shell.message('info', t('{name} is not available on this system.', { name: entry.name }));
      return;
    }
    const given = values && typeof values === 'object' ? (values as Record<string, unknown>) : {};
    const built = buildCatalogServer(entry, given, process.platform);
    if (!built.ok) {
      const text = built.missing.length
        ? t('Fill in: {fields}', { fields: built.missing.join(', ') })
        : t('These values cannot be used (a line break, or too long): {fields}', { fields: built.invalid.join(', ') });
      void this.shell.message('warning', text);
      return;
    }
    const config = built.config;
    const servers = this.settings.mcp.servers;
    const name = catalogServerName(entry, Object.keys(servers));
    const lines: string[] = [];
    if ('url' in config) {
      lines.push(t('Address: {url}', { url: config.url }));
      if (config.headers) lines.push(t('Headers: {names} (values hidden)', { names: Object.keys(config.headers).join(', ') }));
    } else {
      lines.push(t('Command: {command}', { command: catalogCommandLine(config) }));
      if (config.env) lines.push(t('Environment: {names} (values hidden)', { names: Object.keys(config.env).join(', ') }));
    }
    const kind = catalogRunKind(entry, process.platform);
    lines.push(
      kind === 'download'
        ? t('On its first start, {runner} downloads this third-party server and runs it on your computer with your user rights. It is made by {vendor}, not by Orka.', {
            runner: 'command' in config ? config.command : '',
            vendor: entry.vendor,
          })
        : kind === 'program'
          ? t('Orka starts this program on your computer with your user rights. It is made by {vendor}, not by Orka.', { vendor: entry.vendor })
          : kind === 'local-url'
            ? t('Orka connects to a server running on this computer at this address.')
            : t('Orka sends the agents’ tool requests, and the headers you entered, to this address. It is run by {vendor}, not by Orka.', { vendor: entry.vendor }),
    );
    if (entry.fields.some((f) => f.secret && given[f.name])) lines.push(t('Secret values are stored in your Orka settings file and passed only to this server.'));
    lines.push(t('It is added to your MCP servers (user settings) as {name}, turned on, and starts with the next task.', { name }));
    const add = t('Add and turn on');
    const choice = await this.shell.message('warning', t('Add the MCP server {name}?', { name: entry.name }), { modal: true, detail: lines.join('\n\n') }, add);
    if (choice !== add) return;
    // The list as stored now (it may have changed while the dialog was open), entries Orka could not
    // read included, so nothing of the user's is dropped; a name taken meanwhile gets the next one.
    const stored = this.shell.settings.get<unknown>('mcpServers', {});
    const current = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    const finalName = catalogServerName(entry, [...Object.keys(current), ...Object.keys(this.settings.mcp.servers)]);
    await this.updateSetting('mcpServers', { ...current, [finalName]: config });
    void this.shell.message(
      'info',
      this.settings.mcp.enabled
        ? t('{name} was added to your MCP servers. It starts with the next task.', { name: finalName })
        : t('{name} was added, but MCP is off: turn it on in Settings > MCP.', { name: finalName }),
    );
  }

  /** Copy the MCP servers configured for Claude Code (~/.claude.json) into Orka's settings. */
  async importMcpFromClaude(): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(await fs.readFile(path.join(homedir(), '.claude.json'), 'utf8'));
    } catch {
      void this.shell.message('info', t('No Claude Code configuration (~/.claude.json) was found.'));
      return;
    }
    const root = this.activeSession?.root.replace(/\\/g, '/');
    const project = root ? Object.entries(data?.projects ?? {}).find(([p]) => p.toLowerCase() === root.toLowerCase())?.[1] : undefined;
    const found = readMcpServers({ ...(data?.mcpServers ?? {}), ...((project as any)?.mcpServers ?? {}) });
    const current = this.settings.mcp.servers;
    const added = Object.keys(found).filter((n) => !(n in current));
    if (!added.length) {
      void this.shell.message(
        'info',
        Object.keys(found).length ? t('All MCP servers from Claude Code are already in Orka.') : t('Claude Code has no MCP servers configured.'),
      );
      return;
    }
    await this.updateSetting('mcpServers', { ...current, ...Object.fromEntries(added.map((n) => [n, found[n]])) });
    void this.shell.message('info', t('Imported MCP servers from Claude Code: {names}. They start with the next task.', { names: added.join(', ') }));
  }

  // ---------------------------------------------------------------- workspace folder

  private async selectFolder(fsPath?: string): Promise<void> {
    if (fsPath && fsPath === this.activeSession?.root) return;
    // With parallel sessions the session shown goes on in the background; otherwise it ends.
    if (!this.parallel() && this.activeSession?.isRunning) {
      void this.shell.message('info', t('Stop the agent before switching folders.'));
      this.postConfig(true);
      return;
    }
    if (this.parallel() && fsPath && !this.liveFor(fsPath) && !this.hasRoom()) {
      void this.shell.message('info', t('Too many open sessions. Close one first.'));
      this.postConfig(true);
      return;
    }
    // The shell reports a change through onDidChangeFolder, which shows the folder's session.
    if (!(await this.shell.selectFolder(fsPath))) this.postConfig(true);
  }

  /**
   * The app's own folder picker (desktop): the subfolders of a folder. Only shells with a folder
   * browser answer; the path is checked first, and none means where the picker starts: the open
   * folder, else the most recent one, else home.
   */
  private async listFolders(message: Extract<FromWebview, { type: 'listFolders' }>): Promise<void> {
    const browser = this.shell.folderBrowser;
    const id = message.id;
    if (!browser || typeof id !== 'number' || !Number.isSafeInteger(id)) return;
    const places = message.places === true ? await browser.places(this.shell.folders().map((f) => f.path)) : undefined;
    const dir = message.path === undefined ? path.resolve(this.shell.currentFolder()?.path ?? this.shell.folders()[0]?.path ?? browser.home) : checkFolderPath(message.path);
    if (!dir) {
      this.shell.post({ type: 'folderListing', id, path: '', segments: [], entries: [], truncated: false, error: 'invalid', ...(places ? { places } : {}) });
      return;
    }
    const listing = await browser.list(dir, { hidden: message.hidden === true });
    this.shell.post({ type: 'folderListing', id, ...listing, ...(places ? { places } : {}) });
  }

  /** The folder picker's "New folder": one folder in the folder shown, never its parents. */
  private async createFolder(message: Extract<FromWebview, { type: 'createFolder' }>): Promise<void> {
    const browser = this.shell.folderBrowser;
    const id = message.id;
    if (!browser || typeof id !== 'number' || !Number.isSafeInteger(id)) return;
    const parent = checkFolderPath(message.parent);
    const result = parent ? await browser.create(parent, message.name) : { error: 'invalid' as const };
    this.shell.post('path' in result ? { type: 'folderCreated', id, path: result.path, name: path.basename(result.path) } : { type: 'folderCreated', id, error: result.error });
  }

  /** Command palette: choose the folder of a multi-root workspace the agent works in. */
  async pickWorkspaceFolder(): Promise<void> {
    const folders = this.shell.folders();
    if (folders.length < 2 && !this.shell.canOpenFolder) {
      void this.shell.message('info', t('This workspace has a single folder; the agent works there.'));
      return;
    }
    const current = this.activeSession?.root;
    const index = await this.shell.pick(
      folders.map((f) => ({ label: f.name, description: f.path === current ? t('current') : f.path })),
      { title: t('Folder the agent works in') },
    );
    if (index !== undefined) await this.selectFolder(folders[index].path);
  }

  // ---------------------------------------------------------------- task history

  private async postHistory(): Promise<void> {
    const session = this.activeSession;
    const tasks = session ? await session.store.list() : [];
    this.shell.post({ type: 'history', tasks, currentId: session && !session.isEmpty ? session.taskId : undefined });
    await this.postSessions();
  }

  /**
   * The desktop app's session list: the newest tasks of each recent folder, and of each folder with
   * an open session that dropped out of the recent list (so that session keeps its row).
   */
  private async postSessions(): Promise<void> {
    if (this.shell.kind !== 'desktop' || this.settings.desktop.layout !== 'ide') return;
    const folders = [...this.shell.folders()];
    for (const session of this.sessions.values()) {
      if (!folders.some((f) => samePath(f.path, session.root))) folders.push({ name: path.basename(session.root) || session.root, path: session.root });
    }
    const groups: SessionGroup[] = await Promise.all(
      folders.map(async (folder) => ({
        folder: folder.path,
        name: folder.name,
        tasks: (await new FileTaskStore(this.shell.storage(folder.path).tasks).list().catch(() => [])).slice(0, MAX_SESSION_TASKS),
      })),
    );
    this.shell.post({ type: 'sessions', groups, taskId: this.activeSession?.taskId, organizer: this.sessionOrganizer(), live: this.liveViews() });
  }

  /** The user's groups and hidden sessions, as saved (anything malformed is dropped). */
  private sessionOrganizer(): SessionOrganizerView {
    const raw = this.shell.globalState.get<Partial<SessionOrganizerView>>(SESSION_ORGANIZER_STATE) ?? {};
    const groups = (Array.isArray(raw.groups) ? raw.groups : [])
      .filter((g): g is { id: string; name: string } => !!g && typeof g.id === 'string' && ORGANIZER_ID.test(g.id) && typeof g.name === 'string')
      .slice(0, MAX_SESSION_GROUPS)
      .map((g) => ({ id: g.id, name: g.name.slice(0, 60) }));
    const ids = new Set(groups.map((g) => g.id));
    const assigned: Record<string, string> = {};
    for (const [taskId, groupId] of Object.entries(raw.assigned && typeof raw.assigned === 'object' ? raw.assigned : {})) {
      if (ORGANIZER_ID.test(taskId) && typeof groupId === 'string' && ids.has(groupId)) assigned[taskId] = groupId;
    }
    const hidden = (Array.isArray(raw.hidden) ? raw.hidden : []).filter((id): id is string => typeof id === 'string' && ORGANIZER_ID.test(id)).slice(0, 5000);
    return { groups, assigned, hidden };
  }

  private async saveSessionOrganizer(organizer: SessionOrganizerView): Promise<void> {
    await this.shell.globalState.update(SESSION_ORGANIZER_STATE, organizer);
    await this.postSessions();
  }

  /** Groups and hidden sessions in the desktop session list; ids from the UI are checked, names asked here. */
  private async organizeSessions(message: SessionOrganizeOp): Promise<void> {
    if (this.shell.kind !== 'desktop') return;
    const organizer = this.sessionOrganizer();
    const groupName = async (value?: string) => {
      const name = await this.shell.input({
        title: value === undefined ? t('New group') : t('Rename group'),
        placeHolder: t('e.g. Lobby work'),
        value,
        validate: (v) => (!v.trim() ? t('Enter a name.') : v.trim().length > 60 ? t('At most {n} characters.', { n: 60 }) : undefined),
      });
      return name?.trim() || undefined;
    };
    const taskId = 'taskId' in message && typeof message.taskId === 'string' && ORGANIZER_ID.test(message.taskId) ? message.taskId : undefined;
    const named = 'groupId' in message && message.groupId !== undefined;
    const groupId = named && typeof message.groupId === 'string' && organizer.groups.some((g) => g.id === message.groupId) ? message.groupId : undefined;
    // A group the UI names but that does not exist (any more) changes nothing.
    if (named && !groupId) return;
    switch (message.op) {
      case 'createGroup': {
        if (organizer.groups.length >= MAX_SESSION_GROUPS) {
          void this.shell.message('info', t('At most {n} groups.', { n: MAX_SESSION_GROUPS }));
          return;
        }
        const name = await groupName();
        if (!name) return;
        const id = `g-${newTaskId()}`;
        organizer.groups.push({ id, name });
        if (taskId) organizer.assigned[taskId] = id;
        break;
      }
      case 'renameGroup': {
        const group = organizer.groups.find((g) => g.id === groupId);
        if (!group) return;
        const name = await groupName(group.name);
        if (!name) return;
        group.name = name;
        break;
      }
      case 'deleteGroup':
        if (!groupId) return;
        organizer.groups = organizer.groups.filter((g) => g.id !== groupId);
        for (const [task, group] of Object.entries(organizer.assigned)) if (group === groupId) delete organizer.assigned[task];
        break;
      case 'moveToGroup':
        if (!taskId) return;
        if (groupId) organizer.assigned[taskId] = groupId;
        else delete organizer.assigned[taskId];
        break;
      case 'hide':
        if (!taskId) return;
        organizer.hidden = organizer.hidden.filter((id) => id !== taskId);
        if (message.hidden === true) organizer.hidden.push(taskId);
        break;
      default:
        return;
    }
    await this.saveSessionOrganizer(organizer);
  }

  /**
   * A folder named by the UI, if it is one of the recent folders or the folder of an open session
   * (the session list shows both; never any other path).
   */
  private recentFolder(folder: string): string | undefined {
    return this.shell.folders().find((f) => samePath(f.path, folder))?.path ?? [...this.sessions.values()].find((s) => samePath(s.root, folder))?.root;
  }

  private isCurrentFolder(folder: string): boolean {
    const root = this.activeSession?.root;
    return !!root && samePath(root, folder);
  }

  /** Open a task from the history; with a folder (desktop session list), first switch to that recent folder. */
  async openTask(id: string, folder?: string): Promise<void> {
    if (folder !== undefined) {
      const target = this.recentFolder(folder);
      if (!target) return;
      if (!this.isCurrentFolder(target)) {
        // The session that opens it: the folder's open one (parallel sessions), else the one shown, which ends.
        const live = this.parallel() ? this.liveFor(target) : undefined;
        const holder = this.parallel() ? live : this.activeSession;
        if (holder?.isRunning && live?.taskId !== id) {
          void this.shell.message('info', t('Stop the agent before opening another task.'));
          return;
        }
        await this.selectFolder(target);
        if (!this.isCurrentFolder(target)) return;
        // The task is that session's own: it is shown as it is.
        if (live && live.taskId === id) return;
      }
    }
    await this.activeSession?.open(id);
  }

  async deleteTask(id: string, folder?: string): Promise<void> {
    const target = folder === undefined ? undefined : this.recentFolder(folder);
    if (folder !== undefined && !target) return;
    // A task of another recent folder (desktop session list) is deleted from that folder's history,
    // through its open session when it has one.
    const elsewhere = target !== undefined && !this.isCurrentFolder(target);
    const session = elsewhere ? this.liveFor(target) : this.activeSession;
    const store = session?.store ?? (elsewhere ? new FileTaskStore(this.shell.storage(target).tasks) : undefined);
    if (!store) return;
    // A running session would save its conversation again when it ends, under a new id.
    if (session?.isRunning && id === session.taskId) {
      void this.shell.message('info', t('Stop the agent before deleting this task.'));
      return;
    }
    const deleteLabel = t('Delete');
    const choice = await this.shell.message('warning', t('Delete this task from the history? This cannot be undone.'), { modal: true }, deleteLabel);
    if (choice !== deleteLabel) return;
    await store.delete(id);
    if (session && id === session.taskId) session.forgetTask();
    // A deleted session leaves its group and the hidden list too.
    const organizer = this.sessionOrganizer();
    if (organizer.assigned[id] || organizer.hidden.includes(id)) {
      delete organizer.assigned[id];
      organizer.hidden = organizer.hidden.filter((h) => h !== id);
      await this.shell.globalState.update(SESSION_ORGANIZER_STATE, organizer);
    }
    await this.postHistory();
  }

  // ---------------------------------------------------------------- providers

  private customDef(ref: string): CustomProviderDef | undefined {
    return isCustomRef(ref) ? this.settings.customProviders.find((p) => `custom:${p.id}` === ref) : undefined;
  }

  /** Built-in kinds the user can pick: Claude Code only once they turned it on. */
  private builtInKinds(): ProviderKind[] {
    return PROVIDER_KINDS.filter((k) => k !== 'claude-code' || this.settings.claudeCode.enabled);
  }

  private allProviderRefs(): ProviderRef[] {
    return [...this.builtInKinds(), ...this.settings.customProviders.map((p) => `custom:${p.id}` as ProviderRef)];
  }

  /** Providers that may carry an API key. */
  private keyedProviders(): string[] {
    return [...PROVIDER_KINDS.filter((k) => PROVIDERS[k].auth === 'apiKey'), ...this.settings.customProviders.map((p) => `custom:${p.id}`)];
  }

  private providerLabel(ref: string): string {
    return this.agentFor(ref)?.label ?? this.customDef(ref)?.label ?? PROVIDERS[ref as ProviderKind]?.label ?? ref;
  }

  private defaultModel(ref: string): string {
    // An agent CLI uses whatever model the agent itself is set to.
    if (isAgentRef(ref)) return '';
    const custom = this.customDef(ref);
    if (custom) return custom.defaultModel;
    return this.settings.models[ref as ProviderKind] ?? '';
  }

  /** Built-in and custom agent CLIs, as catalog entries. */
  private agentEntries(): AgentCliEntry[] {
    return [...AGENT_CLIS, ...this.settings.agentClis.custom.map((c) => customAgentEntry(c))];
  }

  private agentEntry(id: string): AgentCliEntry | undefined {
    return this.agentEntries().find((e) => e.id === id);
  }

  /** "agent:gemini" -> its catalog entry, when the user turned it on. */
  private agentFor(ref: string): AgentCliEntry | undefined {
    if (!isAgentRef(ref)) return undefined;
    const id = ref.slice('agent:'.length);
    return this.settings.agentClis.enabled.includes(id) ? this.agentEntry(id) : undefined;
  }

  /** The third-party agent that runs the main agent's turns in `root`, when the main agent is one. */
  private externalAgent(root: string): ExternalAgentRuntime | undefined {
    const ref = this.mainProvider();
    if (!isAgentRef(ref)) return undefined;
    const entry = this.agentFor(ref);
    if (!entry) throw new Error(t('That agent CLI is turned off. Turn it on in Settings > Providers > Agent CLIs.'));
    return pooledAgent(this.acpPool, agentLaunchSpec(entry, root, this.settings.agentClis.paths[entry.id]));
  }

  /**
   * With an agent CLI as the main agent, the model the other roles (Supervisor, sub-agents, the
   * light and fallback models) inherit: Claude Code when it is on and ready, else the first
   * provider that works; undefined when none does.
   */
  private modelMain(): { provider: ProviderRef; model: string } | undefined {
    const ref: ProviderRef | undefined =
      this.settings.claudeCode.enabled && this.claudeCodeStatus.state === 'ready'
        ? 'claude-code'
        : this.allProviderRefs().find((r) => r !== 'claude-code' && this.isReady(r));
    return ref ? { provider: ref, model: this.defaultModel(ref) } : undefined;
  }

  /** An agent CLI is the main agent and `name` inherits its model, but no model provider works. */
  private inheritsNoModel(name: string): boolean {
    const choice = name === 'supervisor' ? this.settings.supervisor : this.settings.subagents.agents[name];
    return (!choice || choice.provider === 'inherit') && isAgentRef(this.mainProvider()) && !this.modelMain();
  }

  private isReady(ref: string): boolean {
    if (isAgentRef(ref)) {
      const entry = this.agentFor(ref);
      const state = entry ? this.agentStatus.get(entry.id)?.state : undefined;
      return !!entry && state !== 'not_found' && state !== 'error';
    }
    const custom = this.customDef(ref);
    if (custom) return !custom.requiresKey || !!this.apiKey(ref);
    const info = PROVIDERS[ref as ProviderKind];
    return !!info && (info.auth === 'local' || !!this.apiKey(ref));
  }

  private apiKey(ref: string): string | undefined {
    return this.apiKeys.get(ref) || (ENV_KEYS[ref as ProviderKind] ?? []).map((name) => process.env[name]).find(Boolean) || undefined;
  }

  private async loadApiKey(ref: string): Promise<void> {
    const value = await this.shell.secrets.get(secretKey(ref)).catch(() => undefined);
    if (value) this.apiKeys.set(ref, value);
    else this.apiKeys.delete(ref);
  }

  /**
   * The main agent's provider. One the user picked is always used. Until they pick one, a CLI
   * that is ready comes first (CLI-first): the logged-in Claude Code CLI (when turned on), else
   * an agent CLI the user turned on whose check passed. API providers come after, as a fallback:
   * the default one when it has a key, else the first provider that has a key.
   */
  private mainProvider(): ProviderRef {
    const s = this.settings;
    if (s.providerExplicit) return s.provider;
    const cli = this.readyCli();
    if (cli) return cli;
    if (this.isReady(s.provider)) return s.provider;
    return this.allProviderRefs().find((ref) => ref !== 'claude-code' && this.isReady(ref)) ?? s.provider;
  }

  /** A provider that can still run: a model provider set up (Claude Code turned on), or an agent CLI turned on. */
  private providerSetUp(ref: string): boolean {
    return isAgentRef(ref) ? !!this.agentFor(ref) : this.allProviderRefs().includes(ref as ProviderRef);
  }

  /**
   * The first CLI that is ready right now: Claude Code when turned on, else an agent CLI the user
   * turned on. One that was ready stays ready while it is checked again: only a check that fails
   * moves the main agent.
   */
  private readyCli(): ProviderRef | undefined {
    const ready = (state: string | undefined, before: boolean) => state === 'ready' || (state === 'checking' && before);
    if (this.settings.claudeCode.enabled && ready(this.claudeCodeStatus.state, this.claudeCodeWasReady)) return 'claude-code';
    const id = this.settings.agentClis.enabled.find((a) => ready(this.agentStatus.get(a)?.state, this.agentsWereReady.has(a)) && this.agentEntry(a));
    return id ? (`agent:${id}` as ProviderRef) : undefined;
  }

  /**
   * Drop "no API key" notices that no longer apply (the key was added, or the main agent now runs
   * on another provider), so the chat never shows a key warning for a provider that is not in use.
   */
  private pruneKeyNotices(): void {
    const main = this.mainProvider();
    const stale = (action: string) => {
      if (!action.startsWith('setApiKey:')) return false;
      const ref = action.slice('setApiKey:'.length);
      return ref !== main || this.isReady(ref);
    };
    // Every open session: one in the background shows its transcript again when it is shown.
    for (const session of this.sessions.values()) session.dropNotices(stale);
    if (!this.activeSession && dropNotices(this.idleView, stale)) this.postInit();
  }

  /**
   * Provider/model an agent ("main", "supervisor" or a sub-agent) will actually run on. With a
   * session's model menu choice, the main agent and the roles that inherit it run on its model and
   * effort (`effort` is set then).
   */
  private resolveAgent(name: string, session?: SessionChoice, pinned = false): { provider: ProviderRef; model: string; effort?: string } {
    const s = this.settings;
    // `pinned`: a run under way stays on the provider it started with while that is still set up
    // (a CLI that became ready meanwhile takes the main agent from the next run on).
    const mainRef = pinned && session && this.providerSetUp(session.provider) ? (session.provider as ProviderRef) : this.mainProvider();
    const own = session?.provider === mainRef ? session : undefined;
    const main = own ? { provider: mainRef, model: own.model || this.defaultModel(mainRef), effort: own.effort } : { provider: mainRef, model: this.defaultModel(mainRef) };
    if (name === 'main') return main;
    const choice: AgentChoice | undefined =
      name === 'supervisor' ? s.supervisor : name === 'fallback' ? s.fallback : name === 'light' ? s.light : s.subagents.agents[name];
    // An agent CLI runs only the main agent's turns: the others inherit a model (the Claude API
    // when none works, which then reports its missing key).
    if (!choice || choice.provider === 'inherit') return isAgentRef(mainRef) ? (this.modelMain() ?? { provider: 'claude', model: this.defaultModel('claude') }) : main;
    return { provider: choice.provider, model: choice.model || this.defaultModel(choice.provider) };
  }

  /**
   * `use`: a session's effort (undefined = the settings' default, '' = the provider's own) and
   * Claude Code profile (undefined = the settings' default).
   */
  private providerConfig(ref: string, model: string, use: { effort?: string; profile?: string } = {}): ProviderConfig {
    const s = this.settings;
    const level = <T extends string>(fallback: T | undefined): T | undefined => (use.effort === undefined ? fallback : (use.effort as T) || undefined);
    const key = () => {
      const value = this.apiKey(ref);
      if (!value) throw new Error(t('No API key set for {provider}. Run "Orka: Set API Key".', { provider: this.providerLabel(ref) }));
      return value;
    };
    if (isAgentRef(ref)) throw new Error(t('An agent CLI can only be the main agent.'));
    const custom = this.customDef(ref);
    if (custom) {
      return {
        kind: 'custom',
        id: custom.id,
        label: custom.label,
        baseURL: custom.baseUrl,
        apiKey: custom.requiresKey ? key() : this.apiKey(ref),
        model: model || undefined,
      };
    }
    switch (ref as ProviderKind) {
      case 'claude':
        return { kind: 'claude', apiKey: key(), model, effort: level(s.claude.effort) ?? s.claude.effort, refusalFallback: s.claude.refusalFallback };
      case 'openai':
        return { kind: 'openai', apiKey: key(), model, baseURL: s.openai.baseUrl, reasoningEffort: level(s.openai.reasoningEffort) };
      case 'gemini':
        return { kind: 'gemini', apiKey: key(), model, thinkingLevel: level(s.gemini.thinkingLevel) };
      case 'claude-code':
        if (!s.claudeCode.enabled) throw new Error(t('Claude Code is turned off. Turn it on in Settings > Providers.'));
        return { kind: 'claude-code', model, effort: level(s.claudeCode.effort), executable: s.claudeCode.path, configDir: this.claudeConfigDir(use.profile) };
      default:
        throw new Error(`Unknown provider "${ref}".`);
    }
  }

  /** A run of the session is under way: it stays on the provider it started with (resolveAgent's `pinned`). */
  private runUnderWay(session?: SessionController): boolean {
    return !!session?.runChoice && session.isRunning;
  }

  /**
   * A role's provider; for a session's run, on the choice the run started with (a change made in
   * the model menu meanwhile gets a provider of its own from the next request: a running process
   * is never stopped for it).
   */
  private providerFor(name: string, session?: SessionController): AIProvider {
    const choice = session ? (session.runChoice ?? this.sessionChoice(session)) : undefined;
    const { provider: ref, model, effort } = this.resolveAgent(name, choice, this.runUnderWay(session));
    if (!model && this.customDef(ref)) throw new Error(t('Pick a model for {provider} (Settings > Providers).', { provider: this.providerLabel(ref) }));
    const config = this.providerConfig(ref, model, { effort, profile: choice?.profile });
    const cacheKey = JSON.stringify(config);
    let provider = this.providers.get(cacheKey);
    if (!provider) {
      provider = createProvider(config);
      this.providers.set(cacheKey, provider);
    }
    return provider;
  }

  /**
   * The model Radar analyzes with: the provider picked for Radar; without a choice, Claude Code
   * when it is turned on and logged in (CLI-first), else the main agent's provider when that is a
   * model provider that is ready, else the first model API with a key. Claude Code runs Radar as a plain model: every built-in tool,
   * MCP server, settings file and slash command of the CLI is off (ClaudeCodeProvider), and Radar
   * offers no tools of its own, so there is nothing to run and nothing to ask permission for.
   * Never an agent CLI (its own tools cannot be turned off), and never one the user did not set up.
   */
  private radarModel(): RadarModel {
    const plain = (ref: string) => this.radarCanUse(ref);
    const chosen = this.settings.radar.provider;
    const label = (ref: string, model: string) => `${this.providerLabel(ref)} · ${this.modelLabel(ref, model)}`;
    // Claude Code counts as ready only once its check found it logged in.
    const ready = (ref: string) => (ref === 'claude-code' ? this.claudeCodeStatus.state === 'ready' : this.isReady(ref));
    if (!chosen) {
      const ref = ['claude-code', this.mainProvider(), ...this.allProviderRefs()].find((r) => plain(r) && ready(r) && this.defaultModel(r));
      return ref ? { provider: ref, model: this.defaultModel(ref), label: label(ref, this.defaultModel(ref)), inherited: true } : { problem: t('Pick a provider and model for Radar.') };
    }
    if (!plain(chosen)) return { problem: t('Pick a provider and model for Radar.') };
    if (chosen === 'claude-code' && !ready(chosen)) return { problem: t('{provider} is not ready.', { provider: this.providerLabel(chosen) }) };
    if (!this.isReady(chosen)) return { problem: t('{provider} needs an API key.', { provider: this.providerLabel(chosen) }) };
    const model = this.settings.radar.model || this.defaultModel(chosen);
    if (!model) return { problem: t('Pick a model for {provider} (Settings > Providers).', { provider: this.providerLabel(chosen) }) };
    return { provider: chosen, model, label: label(chosen, model), inherited: false };
  }

  /** A model provider the user set up, or Claude Code once turned on (never an agent CLI). */
  private radarCanUse(ref: string): boolean {
    return !isAgentRef(ref) && this.allProviderRefs().includes(ref as ProviderRef);
  }

  /**
   * A provider of its own for one analysis (disposed after it), on the user's own key or Claude Code
   * login. On Claude Code it holds the settings' profile in the run gate until it is disposed, so a
   * session on another profile waits for it, and it is refused while one runs.
   */
  private radarProvider(ref: string, model: string): AIProvider {
    if (isAgentRef(ref)) throw new Error(t('Radar cannot run on an agent CLI: its own tools cannot be turned off.'));
    const config = this.providerConfig(ref, model);
    if (ref !== 'claude-code') return createProvider(config);
    const hold = this.gate.holdAccounts('radar', [this.accountKey('claude-code', this.settings.accounts.claudeProfile)]);
    if (!hold.ok) {
      throw new Error(
        t('A session runs {account}. Orka runs one profile of a CLI at a time: analyze when it ends.', { account: this.accountLabel(hold.account) }),
      );
    }
    let provider: AIProvider;
    try {
      provider = createProvider(config);
    } catch (error) {
      hold.release();
      throw error;
    }
    return {
      id: provider.id,
      label: provider.label,
      model: provider.model,
      chat: (request, onEvent) => provider.chat(request, onEvent),
      dispose: () => {
        hold.release();
        provider.dispose?.();
      },
    };
  }

  /**
   * "Start a session" on a Radar proposal: a new task in the current folder with the proposal in the
   * message box. It is never sent: the user reads it, changes it and sends it under the usual
   * permission rules. A running request is not stopped for it, and a draft the user had typed stays
   * (the proposal goes after it).
   */
  private async startRadarSession(text: string): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      void this.shell.message('warning', this.noFolderText());
      return;
    }
    if (session.isRunning) {
      void this.shell.message('info', t('The agent is still working. Stop it first or wait until it finishes.'));
      return;
    }
    await session.newTask();
    session.post({ type: 'setInput', text, append: true });
  }

  private disposeProviders(): void {
    for (const provider of this.providers.values()) provider.dispose?.();
    this.providers.clear();
    this.providersStale = false;
  }

  private async setDefaultModel(ref: string, model: string): Promise<void> {
    const custom = this.customDef(ref);
    if (custom) {
      await this.updateCustomProvider(custom.id, { defaultModel: model });
    } else if (PROVIDER_KINDS.includes(ref as ProviderKind)) {
      await this.updateSetting(MODEL_SETTING[ref as ProviderKind], model);
    }
  }

  private async updateCustomProvider(id: string, patch: Partial<CustomProviderDef>): Promise<void> {
    const list = this.settings.customProviders.map((p) => (p.id === id ? { ...p, ...patch } : p));
    await this.updateSetting('customProviders', list, { preferGlobal: true });
  }

  /** Add an OpenAI-compatible provider from a preset (OpenRouter, DeepSeek, Ollama, ...) or a custom URL. */
  async addProvider(presetId?: string): Promise<void> {
    let preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    let label = preset?.label;
    let baseUrl = preset?.baseURL;
    let requiresKey = preset?.requiresKey ?? true;
    if (!preset) {
      label = (await this.shell.input({ title: t('Provider name'), placeHolder: t('e.g. My company gateway') }))?.trim();
      if (!label) return;
      baseUrl = (
        await this.shell.input({
          title: t('{provider}: base URL of its OpenAI-compatible API', { provider: label }),
          placeHolder: 'https://example.com/v1',
          validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : t('Enter an http(s) URL')),
        })
      )?.trim();
      if (!baseUrl) return;
      const choices = [t('Needs an API key'), t('No key (local server)')];
      const keyChoice = await this.shell.pick(
        choices.map((label) => ({ label })),
        { title: t('{provider}: authentication', { provider: label }) },
      );
      if (keyChoice === undefined) return;
      requiresKey = keyChoice === 0;
      preset = undefined;
    }
    const base = (presetId && preset ? preset.id : slug(label!)) || 'provider';
    let id = base;
    for (let n = 2; this.settings.customProviders.some((p) => p.id === id); n++) id = `${base}-${n}`;
    const def: CustomProviderDef = { id, label: label!, baseUrl: baseUrl!, requiresKey, models: [], defaultModel: '' };
    await this.updateSetting('customProviders', [...this.settings.customProviders, def], { preferGlobal: true });
    this.settings = readSettings(this.shell.settings);
    const ref = `custom:${id}`;
    if (requiresKey) await this.promptApiKey(ref);
    await this.loadModels(ref, false);
    this.postConfig();
  }

  async removeProvider(id: string): Promise<void> {
    const def = this.settings.customProviders.find((p) => p.id === id);
    if (!def) return;
    const removeLabel = t('Remove');
    const choice = await this.shell.message(
      'warning',
      t("Remove {provider}? Agents using it switch back to the main agent's provider.", { provider: def.label }),
      { modal: true },
      removeLabel,
    );
    if (choice !== removeLabel) return;
    await this.shell.secrets.delete(secretKey(`custom:${id}`));
    this.apiKeys.delete(`custom:${id}`);
    await this.updateSetting(
      'customProviders',
      this.settings.customProviders.filter((p) => p.id !== id),
      { preferGlobal: true },
    );
  }

  /** Fetch the provider's model list for the pickers. */
  async loadModels(ref: string, notify: boolean): Promise<void> {
    try {
      const models = await listModels(this.providerConfig(ref, this.defaultModel(ref)));
      const custom = this.customDef(ref);
      if (custom) {
        await this.updateCustomProvider(custom.id, { models, defaultModel: custom.defaultModel || models[0] || '' });
      } else {
        this.discoveredModels.set(ref, models);
        this.postConfig();
      }
      const cache = this.shell.globalState.get<Record<string, { at: number; models: string[] }>>(MODEL_CACHE_STATE, {});
      await this.shell.globalState.update(MODEL_CACHE_STATE, { ...cache, [ref]: { at: Date.now(), models } });
      if (notify) void this.shell.message('info', t('{provider}: {n} models available.', { provider: this.providerLabel(ref), n: models.length }));
    } catch (error) {
      if (notify) {
        void this.shell.message(
          'error',
          t('Could not load models from {provider}: {error}', { provider: this.providerLabel(ref), error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }

  private async setAgent(agent: string, provider: string, model: string): Promise<void> {
    // An agent CLI can be the main agent, never another role. Picking one for the main agent
    // turns it on (the picker lists every agent, also those that are off).
    const agentEntry = agent === 'main' && isAgentRef(provider) ? this.agentEntry(provider.slice('agent:'.length)) : undefined;
    const valid = provider === 'inherit' || !!agentEntry || this.allProviderRefs().includes(provider as ProviderRef);
    if (!valid || (model && !isModelId(model))) return;
    if (agent === 'main') {
      if (provider === 'inherit') return;
      if (agentEntry && !this.settings.agentClis.enabled.includes(agentEntry.id)) {
        await this.updateSetting('agentClis.enabled', [...this.settings.agentClis.enabled, agentEntry.id], { preferGlobal: true });
      }
      if (provider !== this.settings.provider || !this.settings.providerExplicit) await this.updateSetting('provider', provider);
      if (!agentEntry && model && model !== this.defaultModel(provider)) await this.setDefaultModel(provider, model);
      // The session shown follows the Agents panel's pick; the other sessions keep their own choice.
      const shown = this.activeSession;
      if (shown) shown.choice = { ...this.defaultChoice(), profile: shown.choice.profile };
      if (agentEntry) await this.noteAgentNotInstalled(agentEntry);
      this.postConfig();
      return;
    }
    if (agent === 'light') {
      await this.updateSetting('routing.provider', provider);
      await this.updateSetting('routing.model', provider === 'inherit' ? '' : model);
      return;
    }
    if (agent === 'fallback') {
      await this.updateSetting('fallback.provider', provider);
      await this.updateSetting('fallback.model', provider === 'inherit' ? '' : model);
      return;
    }
    if (agent === 'supervisor') {
      await this.updateSetting('supervisor.provider', provider);
      await this.updateSetting('supervisor.model', provider === 'inherit' ? '' : model);
      return;
    }
    if (!DEFAULT_SUBAGENTS.some((p) => p.name === agent)) return;
    const agents = { ...this.settings.subagents.agents, [agent]: { provider, model: provider === 'inherit' ? '' : model } };
    await this.updateSetting('subagents.agents', agents);
  }

  private async promptCustomModel(agent: string): Promise<void> {
    if (agent === 'radar') {
      if (!this.radar) return;
      // Radar's own provider, else the main agent's: asked also when that provider has no model yet,
      // which is when "Other…" is the only way to pick one.
      const current = this.radarModel();
      const chosen = this.settings.radar.provider;
      const provider = 'problem' in current ? chosen || this.mainProvider() : current.provider;
      if (!this.radarCanUse(provider)) return;
      const value = await this.shell.input({
        title: t('Model for Radar ({provider})', { provider: this.providerLabel(provider) }),
        value: 'problem' in current ? '' : current.model,
        prompt: t('Any model id the provider accepts.'),
      });
      if (!value?.trim() || !isModelId(value.trim())) return;
      if (chosen !== provider) await this.updateSetting('radar.provider', provider);
      await this.updateSetting('radar.model', value.trim());
      return;
    }
    if (agent.startsWith('provider:')) {
      const ref = agent.slice('provider:'.length);
      if (!this.allProviderRefs().includes(ref as ProviderRef)) return;
      const value = await this.shell.input({
        title: t('Default model for {provider}', { provider: this.providerLabel(ref) }),
        value: this.defaultModel(ref),
        prompt: t('Any model id the provider accepts.'),
      });
      if (value?.trim() && isModelId(value.trim())) await this.setDefaultModel(ref, value.trim());
      return;
    }
    const current = this.resolveAgent(agent);
    const value = await this.shell.input({
      title:
        agent === 'main'
          ? t('Model for the main agent ({provider})', { provider: this.providerLabel(current.provider) })
          : t('Model for the {agent} agent ({provider})', { agent, provider: this.providerLabel(current.provider) }),
      value: current.model,
      prompt: t('Any model id the provider accepts.'),
    });
    if (!value?.trim()) return;
    const choice =
      agent === 'main'
        ? current.provider
        : agent === 'supervisor'
          ? this.settings.supervisor.provider
          : (this.settings.subagents.agents[agent]?.provider ?? 'inherit');
    await this.setAgent(agent, choice === 'inherit' ? current.provider : choice, value.trim());
  }

  async promptApiKey(ref?: string): Promise<void> {
    const keyed = this.keyedProviders();
    let target = ref && keyed.includes(ref) ? ref : undefined;
    if (!target) {
      const index = await this.shell.pick(
        keyed.map((r) => ({
          label: this.providerLabel(r),
          description: this.apiKeys.has(r) ? t('key stored') : this.apiKey(r) ? t('using environment variable') : t('no key'),
        })),
        { title: t('Set API key for which provider?') },
      );
      target = index === undefined ? undefined : keyed[index];
    }
    if (!target) return;
    const value = await this.shell.input({
      title: t('{provider} API key', { provider: this.providerLabel(target) }),
      prompt: t('Kept in secure storage on this machine. It is only sent to that provider.'),
      password: true,
    });
    if (!value?.trim()) return;
    await this.shell.secrets.store(secretKey(target), value.trim());
    await this.loadApiKey(target);
    this.postConfig();
    void this.shell.message('info', t('{provider} key saved.', { provider: this.providerLabel(target) }));
  }

  async clearApiKey(ref?: string): Promise<void> {
    let target = ref && this.apiKeys.has(ref) ? ref : undefined;
    if (!target) {
      const stored = this.keyedProviders().filter((r) => this.apiKeys.has(r));
      const index = await this.shell.pick(
        stored.map((r) => ({ label: this.providerLabel(r) })),
        { title: t('Remove the stored API key for...') },
      );
      target = index === undefined ? undefined : stored[index];
    }
    if (!target) return;
    const removeLabel = t('Remove');
    const confirm = await this.shell.message('warning', t('Remove the stored {provider} key?', { provider: this.providerLabel(target) }), { modal: true }, removeLabel);
    if (confirm !== removeLabel) return;
    await this.shell.secrets.delete(secretKey(target));
    this.apiKeys.delete(target);
    this.postConfig();
  }

  /** Detect the Claude Code CLI, its version and login state (shown in Settings > Providers). */
  async checkClaudeCode(): Promise<void> {
    this.claudeCodeWasReady = this.claudeCodeStatus.state === 'ready' || (this.claudeCodeStatus.state === 'checking' && this.claudeCodeWasReady);
    this.claudeCodeStatus = { state: 'checking' };
    this.postConfig();
    const executable = resolveClaudeExecutable(this.settings.claudeCode.path);
    if (!executable) {
      // The native installer is Anthropic's recommended way; npm still works for those who prefer it.
      const command = installRecipe('claude-code')!.command;
      this.claudeCodeStatus = { state: 'not_found', detail: t('Install it with: {command} (or: npm install -g @anthropic-ai/claude-code)', { command }) };
      this.postConfig();
      return;
    }
    // The chosen profile's account (CLAUDE_CONFIG_DIR), as the runs will use it.
    const configDir = this.claudeConfigDir();
    const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : undefined;
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(executable, args, { timeout: 20_000, windowsHide: true, env }, (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout))),
      );
    try {
      const version = (await run(['--version'])).trim().split(/\s/)[0];
      let auth: { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string } = {};
      try {
        auth = JSON.parse(await run(['auth', 'status']));
      } catch {
        /* older CLIs have no auth status command */
      }
      const plan = auth.subscriptionType ? `claude.ai (${auth.subscriptionType})` : auth.authMethod;
      this.claudeCodeStatus =
        auth.loggedIn === false
          ? { state: 'logged_out', version, executable, detail: t('Run "claude" in a terminal and log in.') }
          : { state: 'ready', version, executable, account: [auth.email, plan].filter(Boolean).join(' · ') || undefined };
    } catch (error) {
      this.claudeCodeStatus = { state: 'error', executable, detail: error instanceof Error ? error.message : String(error) };
    }
    this.postConfig();
  }

  private async pickClaudeExecutable(): Promise<void> {
    const picked = await this.shell.pickFile({
      title: t('Select the claude executable'),
      filters: process.platform === 'win32' ? { Executable: ['exe', 'cmd'] } : undefined,
    });
    if (!picked) return;
    await this.updateSetting('claudeCode.path', picked);
    await this.checkClaudeCode();
  }

  /** Pick the main agent's provider, then its model version (grouped by family). */
  async selectProvider(): Promise<void> {
    const refs = this.allProviderRefs();
    const providerIndex = await this.shell.pick(
      refs.map((ref) => ({
        label: this.providerLabel(ref),
        description: `${this.modelLabel(ref, this.defaultModel(ref)) || t('no model yet')}${this.isReady(ref) ? '' : ` - ${t('needs API key')}`}`,
        picked: ref === this.mainProvider(),
      })),
      { title: t('Main agent provider') },
    );
    if (providerIndex === undefined) return;
    const ref = refs[providerIndex];
    const label = this.providerLabel(ref);
    const current = this.defaultModel(ref);
    const models = this.modelsFor(ref);
    if (current && !models.some((m) => m.id === current)) models.unshift(describeModel(ref, current, t('Current')));
    const items: Array<PickItem & { id?: string }> = [];
    let family = '';
    for (const m of models) {
      if (m.family !== family) {
        family = m.family;
        items.push({ label: t(family), separator: true });
      }
      items.push({ label: t(m.label), description: m.id === m.label ? undefined : m.id, detail: m.note ? t(m.note) : undefined, picked: m.id === current, id: m.id });
    }
    items.push({ label: '', separator: true }, { label: t('Other…'), description: t('type a model id'), id: '__other__' });
    const modelIndex = await this.shell.pick(items, { title: t('{provider} model', { provider: label }), matchOnDescription: true });
    const picked = modelIndex === undefined ? undefined : items[modelIndex]?.id;
    if (!picked) return;
    let model = picked;
    if (model === '__other__') {
      model = (await this.shell.input({ title: t('{provider} model id', { provider: label }), value: current }))?.trim() ?? '';
      if (!model) return;
    }
    await this.setAgent('main', ref, model);
    if (!this.isReady(ref)) await this.promptApiKey(ref);
  }

  async selectMode(): Promise<void> {
    const modes: Array<{ label: string; description: string; mode: PermissionMode }> = [
      { label: t('Ask'), description: t('Ask before every change, command and plan'), mode: 'ask' },
      { label: t('Balanced'), description: t('Edit files automatically; ask for risky actions'), mode: 'balanced' },
      { label: t('Autonomous'), description: t('Work independently; only destructive actions ask'), mode: 'autonomous' },
    ];
    const index = await this.shell.pick(
      modes.map((m) => ({ label: m.label, description: m.description, picked: m.mode === this.settings.mode })),
      { title: t('Permission mode') },
    );
    if (index !== undefined) await this.updateSetting('permissionMode', modes[index].mode);
  }

  showAgents(): void {
    this.shell.reveal();
    this.shell.post({ type: 'showAgents' });
  }

  showSettings(tab?: SettingsTab, mcp?: 'servers' | 'catalog'): void {
    this.shell.reveal();
    this.shell.post({ type: 'showSettings', tab, ...(mcp ? { mcp } : {}) });
  }

  showHistory(): void {
    this.shell.reveal();
    this.shell.post({ type: 'showHistory' });
    void this.postHistory();
  }

  /**
   * Models for the pickers, with version labels grouped by family: the built-in catalog first,
   * then whatever the provider itself reported (Load list). OpenRouter-style ids ("vendor/model")
   * are grouped by vendor.
   */
  private modelsFor(ref: string): ModelInfo[] {
    const custom = this.customDef(ref);
    const catalog = custom ? [] : (MODEL_CATALOG[ref] ?? []);
    const reported = (custom ? custom.models : (this.discoveredModels.get(ref) ?? [])).filter((id) => custom || isChatModelId(id));
    const out = [...catalog];
    for (const id of reported) {
      if (out.some((m) => m.id === id)) continue;
      const vendor = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
      // A model released after this build still lands in its family ("claude-opus-6" -> Claude Opus / Opus 6).
      const inferred = inferModel(vendor ? id.slice(vendor.length + 1) : id);
      out.push(
        inferred
          ? { ...inferred, id, family: vendor ? `${vendor} · ${inferred.family}` : inferred.family, note: 'new' }
          : { id, label: vendor ? id.slice(vendor.length + 1) : id, family: vendor || 'From the provider' },
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- keeping up with the providers

  /**
   * Refresh the model lists of providers with a key once a day, so new model versions show up in
   * the pickers without an update of Orka. Results are cached across sessions.
   */
  private async refreshModelLists(force = false): Promise<void> {
    const cache = { ...this.shell.globalState.get<Record<string, { at: number; models: string[] }>>(MODEL_CACHE_STATE, {}) };
    for (const [ref, entry] of Object.entries(cache)) if (!this.customDef(ref)) this.discoveredModels.set(ref, entry.models);
    this.postConfig();
    const due = (ref: string) => force || !cache[ref] || Date.now() - cache[ref].at > MODEL_REFRESH_MS;
    const refs = this.keyedProviders().filter((ref) => this.isReady(ref) && due(ref));
    await Promise.all(
      refs.map(async (ref) => {
        try {
          const models = await listModels(this.providerConfig(ref, this.defaultModel(ref)));
          if (!models.length) return;
          cache[ref] = { at: Date.now(), models };
          const custom = this.customDef(ref);
          if (custom) await this.updateCustomProvider(custom.id, { models, defaultModel: custom.defaultModel || models[0] || '' });
          else this.discoveredModels.set(ref, models);
        } catch {
          /* offline or key problem: keep the cached list */
        }
      }),
    );
    await this.shell.globalState.update(MODEL_CACHE_STATE, cache);
    this.postConfig();
  }

  private claudeCodeUpdate?: Promise<boolean>;
  /** "claude update" was asked for while a session ran: it runs when the last run ends. */
  private claudeUpdateWaiting = false;

  /**
   * Run "claude update" (a model can need a newer Claude Code than the one installed). Idle CLI
   * sessions are closed first so the executable can be replaced.
   */
  async updateClaudeCode(quiet = false): Promise<boolean> {
    if (this.claudeCodeUpdate) return this.claudeCodeUpdate;
    const executable = resolveClaudeExecutable(this.settings.claudeCode.path);
    if (!executable) {
      if (!quiet) this.publishNotice('error', t('Claude Code CLI not found.'));
      return false;
    }
    // Never swap the executable under a running agent: a quiet (scheduled) check simply waits, an
    // update the user asked for runs once no session runs any more.
    if (this.anyRunning()) {
      if (quiet) return false;
      if (!this.claudeUpdateWaiting) this.publishNotice('info', t('Claude Code will be updated when no session is running.'));
      this.claudeUpdateWaiting = true;
      return false;
    }
    this.claudeUpdateWaiting = false;
    this.disposeProviders();
    const before = this.claudeCodeStatus.version;
    if (!quiet) this.publishNotice('info', t('Updating Claude Code…'));
    this.claudeCodeUpdate = new Promise<{ ok: boolean; output: string }>((resolve) =>
      execFile(executable, ['update'], { timeout: 5 * 60_000, windowsHide: true }, (error, stdout, stderr) =>
        resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim() }),
      ),
    ).then(async ({ ok, output }) => {
      await this.shell.globalState.update(CLAUDE_UPDATE_STATE, Date.now());
      await this.checkClaudeCode();
      const after = this.claudeCodeStatus.version;
      if (ok && after && after !== before) {
        const text = t('Claude Code was updated to {version}.', { version: after });
        if (quiet) this.shell.notify?.(`Orka: ${text}`);
        else this.publishNotice('info', `${text} ${t('Send your message again.')}`);
      } else if (ok) {
        if (!quiet) this.publishNotice('info', t('Claude Code is up to date ({version}).', { version: after ?? '?' }));
      } else if (!quiet) {
        const detail = output.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || '?';
        this.publishNotice('error', t('Claude Code could not be updated: {error}. Run "claude update" in a terminal.', { error: detail }));
      }
      return ok;
    });
    try {
      return await this.claudeCodeUpdate;
    } finally {
      this.claudeCodeUpdate = undefined;
      this.postConfig();
    }
  }

  /** Daily, in the background: fresh model lists from every provider, and the latest Claude Code. */
  private async scheduledUpdates(): Promise<void> {
    await this.refreshModelLists();
    const last = this.shell.globalState.get<number>(CLAUDE_UPDATE_STATE, 0);
    if (this.settings.claudeCode.enabled && this.settings.claudeCode.autoUpdate && Date.now() - last > MODEL_REFRESH_MS && this.claudeCodeStatus.state === 'ready') {
      await this.updateClaudeCode(true);
    }
  }

  // ---------------------------------------------------------------- agent CLIs (ACP)

  private async toggleAgentCli(id: string, enabled: boolean): Promise<void> {
    const entry = this.agentEntry(id);
    if (!entry) return;
    if (!enabled && this.settings.provider === `agent:${id}` && this.settings.agentClis.enabled.includes(id)) {
      // It is the main agent: turning it off moves the main agent elsewhere, so ask first.
      const turnOff = t('Turn off');
      const choice = await this.shell.message(
        'warning',
        t('{agent} is the main agent. Turn it off? The main agent then runs on the default provider.', { agent: entry.label }),
        { modal: true },
        turnOff,
      );
      if (choice !== turnOff) {
        this.postConfig(true); // the checkbox shows it on again
        return;
      }
      this.droppedMainNoted.add(id); // the user just chose this; no notice about it
    }
    const list = this.settings.agentClis.enabled.filter((x) => x !== id);
    if (enabled) list.push(id);
    await this.updateSetting('agentClis.enabled', list, { preferGlobal: true });
    if (enabled) await this.checkAgent(id);
  }

  /** After the agent was picked as the main agent: when it is not installed, say how to install it. */
  private async noteAgentNotInstalled(entry: AgentCliEntry): Promise<void> {
    const state = this.agentStatus.get(entry.id)?.state;
    if (!state || state === 'unknown' || state === 'checking') await this.checkAgent(entry.id);
    if (this.agentStatus.get(entry.id)?.state !== 'not_found') return;
    const hint = installHint(entry);
    const recipe = installRecipe(entry.id);
    this.publishNotice(
      'warning',
      recipe?.runnable
        ? t('{agent} is not installed. Install it from here, or yourself: {hint}', { agent: entry.label, hint: recipe.command })
        : hint
          ? t('{agent} is not installed. Install it ({hint}), then check it again in Settings > Providers.', { agent: entry.label, hint })
          : t('{agent} was not found at "{path}".', { agent: entry.label, path: this.settings.agentClis.paths[entry.id] || entry.bin }),
      recipe ? `install:${recipe.id}` : 'agentClis',
    );
  }

  // ---------------------------------------------------------------- installing CLIs

  /**
   * Install a CLI from Orka's fixed recipes. A runnable one asks first, showing the exact command,
   * where it comes from and where it goes; only "Install" runs it, in a terminal the user sees, in
   * the home folder. A manual one is shown to copy. Nothing runs without the click.
   */
  private async installCli(id: string): Promise<void> {
    const recipe = installRecipe(id);
    if (!recipe) return;
    const copy = t('Copy command');
    const docs = t('Open docs');
    if (!recipe.runnable) {
      const choice = await this.shell.message('info', t('Install {cli} yourself with: {command}', { cli: recipe.label, command: recipe.command }), {}, copy, docs);
      await this.installChoice(recipe, choice, copy, docs);
      return;
    }
    const install = t('Install');
    const choice = await this.shell.message('info', t('Install {cli}?', { cli: recipe.label }), { modal: true, detail: installDetail(recipe) }, install, copy, docs);
    if (choice !== install) {
      await this.installChoice(recipe, choice, copy, docs);
      return;
    }
    if (recipe.node) {
      const version = await nodeVersion();
      if (!nodeIsRecent(version, recipe.node)) {
        const site = 'https://nodejs.org/en/download';
        const open = t('Open nodejs.org');
        const text = version
          ? t('{cli} needs Node.js {min} or newer for npm; this machine has {version}. Update Node.js, then install again.', { cli: recipe.label, min: recipe.node, version })
          : t('{cli} needs Node.js {min} or newer for npm, and Node.js was not found. Install it, then install again.', { cli: recipe.label, min: recipe.node });
        if ((await this.shell.message('warning', text, {}, open)) === open) await this.shell.openExternal(site);
        return;
      }
    }
    this.shell
      .runInTerminal({
        name: t('Install {agent}', { agent: recipe.label }),
        cwd: homedir(),
        command: recipe.command,
        onClose: () => void this.checkInstalled(recipe.id),
      })
      .show();
    this.publishNotice('info', t('{cli} is being installed in a terminal. Orka checks it when the terminal closes, or when you click Check again.', { cli: recipe.label }), `checkInstall:${recipe.id}`);
  }

  /** "Copy command" or "Open docs" in an install dialog. */
  private async installChoice(recipe: InstallRecipe, choice: string | undefined, copy: string, docs: string): Promise<void> {
    if (choice === copy) {
      await this.shell.writeClipboard(recipe.command);
      this.shell.notify?.(t('Copied: {command}', { command: recipe.command }));
    } else if (choice === docs && recipe.docsUrl.startsWith('https://')) {
      await this.shell.openExternal(recipe.docsUrl);
    }
  }

  /**
   * After an install: is the program there now? Found: say so (Claude Code: offer to turn it on).
   * Not found: the running app's PATH may predate the install, so offer to choose the program.
   */
  private async checkInstalled(id: string): Promise<void> {
    const recipe = installRecipe(id);
    if (!recipe) return;
    let found: boolean;
    let version: string | undefined;
    if (recipe.verify.kind === 'claude-code') {
      await this.checkClaudeCode();
      found = this.claudeCodeStatus.state !== 'not_found';
      version = this.claudeCodeStatus.version;
    } else {
      await this.checkAgent(recipe.verify.id);
      const status = this.agentStatus.get(recipe.verify.id);
      found = !!status && status.state !== 'not_found';
      version = status?.version;
    }
    // An adapter that signs in with the vendor's other program (codex-acp: "codex login") needs that one too.
    const entry = recipe.verify.kind === 'agent' ? this.agentEntry(recipe.verify.id) : undefined;
    if (found && entry?.login?.bin && !agentLogin(entry, this.settings.agentClis.paths[entry.id])) {
      this.publishNotice(
        'warning',
        t('{program} was not found yet, so {cli} cannot sign in. If the installer finished, restart Orka so it sees the new PATH.', { program: entry.login.bin, cli: recipe.label }),
      );
      return;
    }
    if (found) {
      this.publishNotice('info', t('{cli} is installed ({version}).', { cli: recipe.label, version: version ?? '?' }));
      if (recipe.verify.kind === 'claude-code' && !this.settings.claudeCode.enabled) {
        const turnOn = t('Turn on');
        if ((await this.shell.message('info', t('Use Claude Code in Orka? It runs on your own Claude Code login.'), {}, turnOn)) === turnOn) {
          await this.updateSetting('claudeCode.enabled', true);
        }
      }
      return;
    }
    const choose = t('Choose file…');
    const choice = await this.shell.message(
      'warning',
      t('{cli} was not found yet. If the installer finished, restart Orka so it sees the new PATH, or choose the program.', { cli: recipe.label }),
      {},
      choose,
    );
    if (choice !== choose) return;
    if (recipe.verify.kind === 'claude-code') await this.pickClaudeExecutable();
    else await this.pickAgentExecutable(recipe.verify.id);
  }

  /** Is the agent's program there, and which version? (`--version` only; a sign-in problem shows on the first request.) */
  private async checkAgent(id: string): Promise<void> {
    const entry = this.agentEntry(id);
    if (!entry) return;
    const before = this.agentStatus.get(id)?.state;
    if (before === 'ready') this.agentsWereReady.add(id);
    else if (before !== 'checking') this.agentsWereReady.delete(id);
    this.agentStatus.set(id, { state: 'checking' });
    this.postConfig();
    const result = await checkAgentCli(entry, this.settings.agentClis.paths[id]).catch((error: unknown) => ({
      state: 'error' as const,
      detail: error instanceof Error ? error.message : String(error),
    }));
    this.agentStatus.set(id, result);
    this.postConfig();
  }

  /** The vendor's own sign-in, in a terminal the user types into; Orka never sees it. */
  private loginAgentCli(id: string): void {
    const entry = this.agentEntry(id);
    if (!entry?.login) return;
    const program = agentLogin(entry, this.settings.agentClis.paths[id]);
    if (!program) {
      const bin = entry.login.bin;
      this.publishNotice(
        'error',
        bin
          ? t('{program} was not found. Install it ({command}), then sign in again.', { program: bin, command: entry.login.installHint ?? '?' })
          : t('{agent} was not found. Install it ({command}) or set its path in the settings.', { agent: entry.label, command: installHint(entry) || '?' }),
      );
      return;
    }
    // The program by its full path, in the home folder: nothing in the open project can stand in for it.
    this.shell
      .runInTerminal({
        name: t('{agent}: sign in', { agent: entry.label }),
        cwd: homedir(),
        command: program,
        onClose: () => void this.checkAgent(id),
      })
      .show();
  }

  // ---------------------------------------------------------------- accounts

  /** The program a CLI's account commands run: Claude Code's executable, or the agent's sign-in program (Codex: the Codex CLI). */
  private accountProgram(cli: AccountCli): string | undefined {
    if (cli === 'claude-code') return resolveClaudeExecutable(this.settings.claudeCode.path) || undefined;
    const entry = this.agentEntry(cli);
    return entry ? agentLogin(entry, this.settings.agentClis.paths[cli])?.file : undefined;
  }

  /**
   * The extra environment for a CLI's account commands: a Claude Code profile's CLAUDE_CONFIG_DIR
   * ('' = the default profile, no variable). Undefined for a profile that does not exist, or a
   * profile asked of another CLI.
   */
  private accountEnv(cli: AccountCli, profile = ''): Record<string, string> | undefined {
    if (!profile) return {};
    if (cli !== 'claude-code') return undefined;
    const found = this.settings.accounts.claudeProfiles.find((p) => p.id === profile);
    return found ? { CLAUDE_CONFIG_DIR: found.dir } : undefined;
  }

  /** The folder Claude Code runs on for a profile (by default the settings' one), or undefined for the default profile. */
  private claudeConfigDir(profile = this.settings.accounts.claudeProfile): string | undefined {
    return this.settings.accounts.claudeProfiles.find((p) => p.id === profile)?.dir;
  }

  private accountKey(cli: AccountCli, profile = ''): string {
    return cli === 'claude-code' ? `claude-code:${profile}` : cli;
  }

  /**
   * The accounts a run would use now, for the gate: the Claude Code profile of the session's run
   * (by default the settings' one) when any role runs on Claude Code. A fallback runs on the same
   * profile: no role ever goes on with another account.
   */
  private runAccounts(session?: SessionController): string[] {
    const choice = session ? (session.runChoice ?? this.sessionChoice(session)) : undefined;
    const profile = choice ? choice.profile : this.settings.accounts.claudeProfile;
    return this.usesClaudeCode(choice, this.runUnderWay(session)) ? [`claude-code:${profile}`] : [];
  }

  /** Some role runs on Claude Code (with a session's choice: in that session; `pinned`: a run's own choice). */
  private usesClaudeCode(choice?: SessionChoice, pinned = false): boolean {
    const roles = ['main', 'supervisor', 'fallback', 'light', ...Object.keys(this.settings.subagents.agents)];
    return roles.some((name) => this.resolveAgent(name, choice, pinned).provider === 'claude-code');
  }

  // ---------------------------------------------------------------- the composer's model menu (per session)

  /** A new session's choice: a copy of the settings (the main agent's model and effort, Claude Code's profile). */
  private defaultChoice(): SessionChoice {
    const provider = this.mainProvider();
    return { provider, model: this.defaultModel(provider), effort: settingsEffort(this.settings, provider), profile: this.settings.accounts.claudeProfile };
  }

  /**
   * The session's choice as it holds now: when the main agent's provider changed since (in the
   * Agents panel, or a CLI became ready), it starts again from the settings for that provider (the
   * session keeps its own choice for when that provider comes back); a profile that was removed
   * becomes the default one, and a value the provider does not take its default.
   */
  private sessionChoice(session: SessionController): SessionChoice {
    const c = session.choice;
    const main = this.mainProvider();
    const profile = !c.profile || this.settings.accounts.claudeProfiles.some((p) => p.id === c.profile) ? c.profile : '';
    if (c.provider !== main) return { ...this.defaultChoice(), profile };
    const next: SessionChoice = {
      provider: main,
      model: isAgentRef(main) ? '' : c.model && isModelId(c.model) ? c.model : this.defaultModel(main),
      effort: effortLevels(main).includes(c.effort) ? c.effort : settingsEffort(this.settings, main),
      profile,
      ...(c.options ? { options: c.options } : {}),
    };
    session.choice = next;
    return next;
  }

  /** The model menu changed a session's model, effort or profile: from its next request on. */
  private async setSessionModel(session: SessionController, change: { model?: unknown; effort?: unknown; profile?: unknown; option?: unknown }): Promise<void> {
    const c = { ...this.sessionChoice(session) };
    if (change.option !== undefined) {
      // Only an option the session's agent CLI advertised, with a value it listed.
      const { id, value } = (change.option ?? {}) as { id?: unknown; value?: unknown };
      if (!isOptionText(id) || !isOptionText(value)) return;
      const option = this.advertisedOptions(session, c).find((o) => o.id === id);
      if (!option?.options.some((v) => v.value === value)) return;
      c.options = { ...c.options, [option.id]: value };
    }
    if (change.model !== undefined) {
      if (isAgentRef(c.provider) || typeof change.model !== 'string' || (change.model && !isModelId(change.model))) return;
      c.model = change.model || this.defaultModel(c.provider);
    }
    if (change.effort !== undefined) {
      if (typeof change.effort !== 'string' || !effortLevels(c.provider).includes(change.effort)) return;
      c.effort = change.effort;
    }
    if (change.profile !== undefined) {
      if (typeof change.profile !== 'string' || (change.profile && !this.settings.accounts.claudeProfiles.some((p) => p.id === change.profile))) return;
      c.profile = change.profile;
    }
    session.choice = c;
    if (session.id === this.activeId) this.postConfig();
  }

  /** "Use as default": the session's model, effort and profile become the settings' defaults; other sessions keep theirs. */
  private async useModelAsDefault(session: SessionController): Promise<void> {
    const c = this.sessionChoice(session);
    if (!isAgentRef(c.provider) && c.model && c.model !== this.defaultModel(c.provider)) await this.setDefaultModel(c.provider, c.model);
    const key = EFFORT_SETTING[c.provider];
    if (key && c.effort !== settingsEffort(this.settings, c.provider)) await this.updateSetting(key, c.effort);
    if (c.profile !== this.settings.accounts.claudeProfile) await this.updateSetting('accounts.claudeProfile', c.profile, { preferGlobal: true });
    this.postConfig();
  }

  /** The choices the session's agent CLI advertised, when the main agent is that agent (none otherwise). */
  private advertisedOptions(session: SessionController, choice: SessionChoice): AgentOption[] {
    const advertised = session.agentOptions;
    return advertised && isAgentRef(choice.provider) && choice.provider === `agent:${advertised.agent}` ? advertised.options : [];
  }

  /** The model menu of the session shown. */
  private sessionModelView(session: SessionController): SessionModelView {
    const c = this.sessionChoice(session);
    const provider = c.provider;
    const defaults = this.defaultChoice();
    const profiles = this.settings.accounts.claudeProfiles;
    const onClaudeCode = this.usesClaudeCode(c);
    return {
      provider,
      model: c.model,
      effort: c.effort,
      efforts: effortLevels(provider),
      defaultEffort: settingsEffort(this.settings, provider),
      profiles: onClaudeCode && profiles.length ? [{ id: '', name: t('Default profile') }, ...profiles.map((p) => ({ id: p.id, name: p.name }))] : [],
      profile: c.profile,
      differs: defaults.provider === provider && (defaults.model !== c.model || defaults.effort !== c.effort || defaults.profile !== c.profile),
      // What the agent's next prompt runs on: the session's pick where the agent lists it, else the agent's own value.
      agentOptions: this.advertisedOptions(session, c).map((o) => {
        const picked = c.options && Object.prototype.hasOwnProperty.call(c.options, o.id) ? c.options[o.id] : undefined;
        return picked !== undefined && o.options.some((v) => v.value === picked) ? { ...o, currentValue: picked } : o;
      }),
    };
  }

  /** "Claude Code (Work)" for "claude-code:work"; "Claude Code (Default profile)" for "claude-code:". */
  private accountLabel(account: string): string {
    const colon = account.indexOf(':');
    const cli = colon < 0 ? account : account.slice(0, colon);
    const profile = colon < 0 ? '' : account.slice(colon + 1);
    const label = cli === 'claude-code' ? 'Claude Code' : (this.agentEntry(cli)?.label ?? cli);
    if (cli !== 'claude-code') return label;
    const name = profile ? (this.settings.accounts.claudeProfiles.find((p) => p.id === profile)?.name ?? profile) : t('Default profile');
    return `${label} (${name})`;
  }

  /** Ask every CLI's own status command (and each Claude Code profile's) at once. */
  private async checkAccounts(): Promise<void> {
    const targets: Array<[AccountCli, string]> = ACCOUNT_CLIS.map((cli) => [cli, '']);
    for (const p of this.settings.accounts.claudeProfiles) targets.push(['claude-code', p.id]);
    for (const [cli, profile] of targets) this.accountStatus.set(this.accountKey(cli, profile), { state: 'checking' });
    this.postConfig();
    await Promise.all(targets.map(([cli, profile]) => this.probeAccount(cli, profile)));
    this.postConfig();
  }

  /** Ask one CLI's status command (`cli` and `profile` come from the page: only known ids are used). */
  private async checkAccount(cli: string, profile?: string): Promise<void> {
    if (!isAccountCli(cli) || !this.accountEnv(cli, profile)) return;
    this.accountStatus.set(this.accountKey(cli, profile), { state: 'checking' });
    this.postConfig();
    await this.probeAccount(cli, profile);
    this.postConfig();
  }

  /**
   * Run the CLI's own status command and keep what it said (in memory only). A CLI without one
   * stays "unknown" with what to do instead; Copilot also says when a token variable stands in
   * for its stored sign-in (the variable's name, never its value).
   */
  private async probeAccount(cli: AccountCli, profile = ''): Promise<void> {
    const key = this.accountKey(cli, profile);
    const env = this.accountEnv(cli, profile);
    const file = this.accountProgram(cli);
    const status = ACCOUNT_COMMANDS[cli].status;
    if (!env) return;
    if (!file) {
      this.accountStatus.set(key, { state: 'not_installed' });
      return;
    }
    if (!status) {
      const token = cli === 'copilot' ? copilotTokenVariable() : undefined;
      this.accountStatus.set(key, {
        state: 'unknown',
        label: token ? t('{name} is set: Copilot CLI signs in with that token instead.', { name: token }) : undefined,
        hint:
          cli === 'copilot'
            ? t('Copilot CLI has no status command: type /user in it to see the account.')
            : t('{cli} has no status command: its sign-in is chosen inside the CLI.', { cli: this.accountLabel(cli) }),
      });
      return;
    }
    // agy before 1.5.0 has no "models" command (nor "acp"): it needs an update first.
    const entry = cli === 'antigravity' ? this.agentEntry(cli) : undefined;
    const tooOld = entry && tooOldForAcp(entry, this.agentStatus.get(cli)?.version);
    if (tooOld) {
      this.accountStatus.set(key, { state: 'unknown', hint: tooOld });
      return;
    }
    const output = await this.probe(file, status, env).catch((error: unknown) => ({
      code: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }));
    this.accountStatus.set(key, parseStatus(cli, output));
  }

  /**
   * The vendor's own sign-in, in a terminal the user types into (for a Claude Code profile, with
   * its CLAUDE_CONFIG_DIR); its status is asked again when the terminal closes. Orka never sees
   * the password or the token.
   */
  private loginAccount(cli: string, profile?: string): void {
    if (!isAccountCli(cli)) return;
    this.runAccountCommand(cli, profile, ACCOUNT_COMMANDS[cli].login, t('{account}: sign in', { account: this.accountLabel(this.accountKey(cli, profile)) }));
  }

  /**
   * The vendor's own sign-out, after the user confirms. A CLI that signs out only from inside
   * itself is opened in a terminal, with what to type there.
   */
  private async logoutAccount(cli: string, profile?: string): Promise<void> {
    if (!isAccountCli(cli) || !this.accountEnv(cli, profile)) return;
    const commands = ACCOUNT_COMMANDS[cli];
    const account = this.accountLabel(this.accountKey(cli, profile));
    if (!commands.logout) {
      this.runAccountCommand(cli, profile, [], t('{account}: sign out', { account }));
      if (commands.logoutHint) this.publishNotice('info', t(commands.logoutHint));
      return;
    }
    const signOut = t('Sign out');
    if ((await this.shell.message('warning', t('Sign out of {account}?', { account }), { modal: true }, signOut)) !== signOut) return;
    this.runAccountCommand(cli, profile, commands.logout, t('{account}: sign out', { account }));
  }

  /** One of the CLI's own commands, by its full path, in the home folder, in a terminal the user sees. */
  private runAccountCommand(cli: AccountCli, profile: string | undefined, args: readonly string[], name: string): void {
    const env = this.accountEnv(cli, profile);
    if (!env) return;
    const file = this.accountProgram(cli);
    if (!file) {
      const recipe = installRecipe(cli);
      this.publishNotice(
        'warning',
        t('{cli} is not installed. Install it first, then sign in.', { cli: this.accountLabel(cli) }),
        recipe ? `install:${recipe.id}` : undefined,
      );
      return;
    }
    if (env.CLAUDE_CONFIG_DIR) mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    this.shell
      .runInTerminal({
        name,
        cwd: homedir(),
        command: { file, args: [...args] },
        env: Object.keys(env).length ? env : undefined,
        onClose: () => void this.checkAccount(cli, profile),
      })
      .show();
  }

  /**
   * A Claude Code profile: a name, and a config folder of its own (~/.claude-<id>) that Orka
   * creates empty; Claude Code keeps that account's sign-in there. Separate accounts are for
   * separate work, which the dialog says.
   */
  private async addClaudeProfile(given?: string): Promise<void> {
    const taken = new Set(this.settings.accounts.claudeProfiles.map((p) => p.id));
    const invalid = (v: string) => {
      const id = profileId(v);
      if (!id) return t('Enter a name with letters or digits.');
      if (taken.has(id)) return t('A profile with this name exists.');
      return undefined;
    };
    const notice = t("Separate accounts are for separate work, such as work and personal. Using them to get around a usage limit may break the vendor's terms.");
    let name = typeof given === 'string' ? given.trim().slice(0, 40) : '';
    if (name) {
      const add = t('Add profile');
      if (invalid(name) || (await this.shell.message('info', t('Add the Claude Code profile "{name}"?', { name }), { modal: true, detail: notice }, add)) !== add) return;
    } else {
      name = (await this.shell.input({ title: t('Add a Claude Code profile'), prompt: notice, placeHolder: t('e.g. Work'), validate: invalid }))?.trim().slice(0, 40) ?? '';
      if (!name || invalid(name)) return;
    }
    const id = profileId(name);
    const dir = path.join(homedir(), `.claude-${id}`);
    mkdirSync(dir, { recursive: true });
    await this.updateSetting('accounts.claudeProfiles', [...this.settings.accounts.claudeProfiles, { id, name, dir }], { preferGlobal: true });
    const signIn = t('Sign in');
    if ((await this.shell.message('info', t('Profile "{name}" added. Sign in to its account now?', { name }), {}, signIn)) === signIn) this.loginAccount('claude-code', id);
    else this.postConfig();
  }

  /**
   * Forget a Claude Code profile (not while a run uses it). Its folder stays: it holds that
   * account's sign-in, which only Claude Code touches.
   */
  private async removeClaudeProfile(id: string): Promise<void> {
    const profile = this.settings.accounts.claudeProfiles.find((p) => p.id === id);
    if (!profile) return;
    if (this.gate.profileInUse('claude-code') === id) {
      this.publishNotice('warning', t('A session runs on the profile {name}. Remove it when the run ends.', { name: profile.name }));
      return;
    }
    const remove = t('Remove');
    const text = t('Remove the profile {name}? Its folder {dir} stays, with its sign-in: sign out first, or delete the folder yourself.', { name: profile.name, dir: profile.dir });
    if ((await this.shell.message('warning', text, { modal: true }, remove)) !== remove) return;
    if (this.settings.accounts.claudeProfile === id) await this.updateSetting('accounts.claudeProfile', '', { preferGlobal: true });
    await this.updateSetting('accounts.claudeProfiles', this.settings.accounts.claudeProfiles.filter((p) => p.id !== id), { preferGlobal: true });
    this.accountStatus.delete(this.accountKey('claude-code', id));
    this.postConfig();
  }

  /**
   * The profile Claude Code runs on from the next run ('' = the default). Only by the user's
   * choice: no code path switches it on its own (a usage limit never does).
   */
  private async setClaudeProfile(id: string): Promise<void> {
    if (id && !this.settings.accounts.claudeProfiles.some((p) => p.id === id)) return;
    if (id === this.settings.accounts.claudeProfile) return;
    await this.updateSetting('accounts.claudeProfile', id, { preferGlobal: true });
    // The default for new sessions, and the session shown (other sessions keep their profile).
    const shown = this.activeSession;
    if (shown) shown.choice = { ...shown.choice, profile: id };
    const inUse = this.gate.profileInUse('claude-code');
    if (inUse !== undefined && inUse !== id) {
      this.publishNotice(
        'info',
        t('Running sessions finish on {old}. New runs use {new}; one profile of a CLI runs at a time, so they wait for those runs to end.', {
          old: this.accountLabel(`claude-code:${inUse}`),
          new: this.accountLabel(`claude-code:${id}`),
        }),
      );
    }
    void this.checkClaudeCode();
  }

  /** Settings > Accounts: one row per CLI, and per Claude Code profile. */
  private accountsView(): AccountView[] {
    const { claudeProfiles, claudeProfile } = this.settings.accounts;
    const row = (cli: AccountCli, profile?: AccountView['profile']): AccountView => {
      const commands = ACCOUNT_COMMANDS[cli];
      const entry = cli === 'claude-code' ? undefined : this.agentEntry(cli);
      const program = cli === 'claude-code' ? 'claude' : entry?.login?.bin ?? entry?.bin ?? cli;
      const line = (args: readonly string[]) => [program, ...args].join(' ');
      return {
        cli,
        label: cli === 'claude-code' ? 'Claude Code' : (entry?.label ?? cli),
        profile,
        status: this.accountStatus.get(this.accountKey(cli, profile?.id)) ?? { state: 'unknown' },
        loginCommand: line(commands.login),
        logoutCommand: commands.logout ? line(commands.logout) : undefined,
        logoutHint: commands.logoutHint ? t(commands.logoutHint) : undefined,
        installable: !!installRecipe(cli)?.runnable,
      };
    };
    const claude = [
      row('claude-code', { id: '', name: t('Default profile'), dir: '', chosen: !claudeProfile }),
      ...claudeProfiles.map((p) => row('claude-code', { ...p, chosen: p.id === claudeProfile })),
    ];
    return [...claude, ...ACCOUNT_CLIS.filter((cli) => cli !== 'claude-code' && this.agentEntry(cli)).map((cli) => row(cli))];
  }

  private async pickAgentExecutable(id: string): Promise<void> {
    const entry = this.agentEntry(id);
    if (!entry) return;
    const file = await this.shell.pickFile({
      title: t('Choose the {agent} program', { agent: entry.label }),
      filters: process.platform === 'win32' ? { [t('Programs')]: ['exe', 'cmd', 'bat'] } : undefined,
    });
    if (file) await this.setAgentPath(id, file);
  }

  /** Executable paths are machine settings: a repository's own settings can never point them elsewhere. */
  private async setAgentPath(id: string, file: string | undefined): Promise<void> {
    if (!this.agentEntry(id)) return;
    const paths = { ...this.settings.agentClis.paths };
    if (file) paths[id] = file;
    else delete paths[id];
    await this.updateSetting('agentClis.paths', paths, { preferGlobal: true });
    await this.checkAgent(id);
  }

  /** A custom ACP agent: a name and the exact command line Orka will run, confirmed by the user. */
  private async addCustomAgent(): Promise<void> {
    const name = (
      await this.shell.input({
        title: t('Add an ACP agent'),
        prompt: t('A name for it'),
        placeHolder: t('e.g. My agent'),
        validate: (v) => (!v.trim() ? t('Enter a name.') : v.trim().length > 60 ? t('At most {n} characters.', { n: 60 }) : undefined),
      })
    )?.trim();
    if (!name) return;
    const line = (
      await this.shell.input({
        title: t('Add an ACP agent'),
        prompt: t('The command that starts its ACP server (program and arguments)'),
        placeHolder: t('e.g. my-agent --acp'),
        validate: (v) => (!splitCommandLine(v).length ? t('Enter a command.') : undefined),
      })
    )?.trim();
    if (!line) return;
    const [command, ...args] = splitCommandLine(line);
    const entry = customAgentEntry({ name, command, args });
    if (this.agentEntries().some((e) => e.id === entry.id)) {
      void this.shell.message('warning', t('An agent called {name} already exists.', { name }));
      return;
    }
    const add = t('Add');
    const choice = await this.shell.message(
      'warning',
      t('Orka will run exactly this program as an agent in your project: {command}. Only add agents you trust, and follow their terms.', { command: line }),
      { modal: true },
      add,
    );
    if (choice !== add) return;
    await this.updateSetting('agentClis.custom', [...this.settings.agentClis.custom, { name, command, args }], { preferGlobal: true });
    await this.updateSetting('agentClis.enabled', [...this.settings.agentClis.enabled.filter((x) => x !== entry.id), entry.id], { preferGlobal: true });
    await this.checkAgent(entry.id);
  }

  private async removeCustomAgent(id: string): Promise<void> {
    const custom = this.settings.agentClis.custom.filter((c) => customAgentEntry(c).id !== id);
    if (custom.length === this.settings.agentClis.custom.length) return;
    await this.updateSetting('agentClis.custom', custom, { preferGlobal: true });
    await this.updateSetting('agentClis.enabled', this.settings.agentClis.enabled.filter((x) => x !== id), { preferGlobal: true });
    if (this.settings.agentClis.paths[id]) await this.setAgentPath(id, undefined);
    this.agentStatus.delete(id);
  }

  private agentClisView(): AgentCliView[] {
    const s = this.settings.agentClis;
    return this.agentEntries().map((entry) => {
      const policy = agentPolicy(entry.policy);
      const custom = entry.kind === 'custom' ? s.custom.find((c) => customAgentEntry(c).id === entry.id) : undefined;
      return {
        id: entry.id,
        label: entry.label,
        vendor: entry.vendor,
        custom: entry.kind === 'custom',
        enabled: s.enabled.includes(entry.id),
        status: this.agentStatus.get(entry.id) ?? { state: 'unknown' },
        path: s.paths[entry.id] ?? '',
        commandLine: custom ? [custom.command, ...custom.args].join(' ') : undefined,
        note: policy ? t(policy.note) : '',
        termsUrl: policy?.termsUrl ?? '',
        faqUrl: policy?.faqUrl ?? '',
        docsUrl: entry.docsUrl,
        installHint: installHint(entry),
        loginCommand: loginCommand(entry, s.paths[entry.id], this.agentStatus.get(entry.id)?.executable),
        preview: !!policy?.preview,
      };
    });
  }

  private appVersionView(): AppVersionView {
    const saved = this.shell.globalState.get<AppUpdateState>(APP_UPDATE_STATE) ?? {};
    // Only a release page Orka builds itself for that version is ever opened.
    const url = saved.latest ? [releasePageUrl(`v${saved.latest}`), releasePageUrl(saved.latest)].find((u) => u && u === saved.url) : undefined;
    const update = saved.latest && url && isNewerVersion(saved.latest, VERSION) ? { version: saved.latest, url } : undefined;
    return {
      version: VERSION,
      checkUpdates: this.settings.checkUpdates,
      update,
      checkedAt: saved.checkedAt,
      error: typeof saved.error === 'string' ? saved.error.slice(0, 200) : undefined,
      checking: !!this.appUpdateCheck,
    };
  }

  /**
   * Is there a newer Orka release? Asked once a day in the background (setting updates.check, or
   * ORKA_NO_UPDATE_CHECK=1 to turn it off), or now from the settings. It only tells: the release
   * page opens in the browser if the user wants it; nothing is downloaded.
   */
  async checkAppUpdate(manual = false): Promise<void> {
    if (this.appUpdateCheck) return this.appUpdateCheck;
    const saved = this.shell.globalState.get<AppUpdateState>(APP_UPDATE_STATE) ?? {};
    if (!manual && (!this.settings.checkUpdates || process.env.ORKA_NO_UPDATE_CHECK || Date.now() - (saved.checkedAt ?? 0) < MODEL_REFRESH_MS)) return;
    this.appUpdateCheck = this.runAppUpdateCheck(saved, manual);
    this.postConfig();
    try {
      await this.appUpdateCheck;
    } catch (error) {
      if (manual) this.reportError(error);
    } finally {
      this.appUpdateCheck = undefined;
      this.postConfig();
    }
  }

  private async runAppUpdateCheck(saved: AppUpdateState, manual: boolean): Promise<void> {
    const result = await checkAppUpdate({ currentVersion: VERSION, etag: saved.etag });
    // At most one attempt a day, answered or not; not_modified: the saved answer still holds.
    const next: AppUpdateState = { ...saved, checkedAt: Date.now(), error: result.status === 'error' ? result.error || '?' : undefined };
    if (result.status === 'newer' || result.status === 'current') Object.assign(next, { etag: result.etag, latest: result.latest, url: result.url });
    await this.shell.globalState.update(APP_UPDATE_STATE, next);
    if (result.status === 'error') {
      if (manual) void this.shell.message('warning', t('Could not check for a new Orka version: {error}', { error: result.error ?? '?' }));
      return;
    }
    const update = this.appVersionView().update;
    if (!update) {
      if (manual) void this.shell.message('info', t('Orka is up to date ({version}).', { version: VERSION }));
      return;
    }
    // In the background, each new version is announced once.
    if (!manual && next.notified === update.version) return;
    await this.shell.globalState.update(APP_UPDATE_STATE, { ...next, notified: update.version });
    const download = t('Download');
    void this.shell
      .message('info', t('Orka {version} is available (you have {current}).', { version: update.version, current: VERSION }), {}, download)
      .then((choice) => (choice === download ? this.shell.openExternal(update.url) : undefined));
  }

  /** "Check for updates" (button or command): every provider's model list and Claude Code, now. */
  async checkForUpdates(): Promise<void> {
    const updateClaudeCode = this.settings.claudeCode.enabled && resolveClaudeExecutable(this.settings.claudeCode.path);
    await Promise.all([this.refreshModelLists(true), updateClaudeCode ? this.updateClaudeCode() : Promise.resolve(false)]);
    const models = this.keyedProviders().filter((r) => this.isReady(r)).length;
    void this.shell.message(
      'info',
      models
        ? t('Orka: model lists refreshed from {n} providers.', { n: models })
        : t('Orka: no provider with a key to refresh models from; built-in lists are used.'),
    );
  }

  /** A model that needs a newer Claude Code: update it right away when the user allows that. */
  private onAgentEvent(event: AgentEvent): void {
    const outdated =
      (event.type === 'notice' && event.action === 'claudeUpdate') ||
      (event.type === 'supervisor' && event.status === 'error' && /or newer is required/i.test(event.message ?? ''));
    if (outdated && this.settings.claudeCode.enabled && this.settings.claudeCode.autoUpdate && !this.claudeCodeUpdate) void this.updateClaudeCode();
  }

  // ---------------------------------------------------------------- external agents

  /** Whether each external agent is installed, looked up at most every 30 seconds. */
  private installed = new Map<string, { found: boolean; at: number }>();

  private isInstalled(id: string, fresh = false): boolean {
    const agent = externalAgent(id);
    if (!agent) return false;
    const cached = this.installed.get(id);
    if (!fresh && cached && Date.now() - cached.at < 30_000) return cached.found;
    const found = !!findExecutable(agent.command);
    this.installed.set(id, { found, at: Date.now() });
    return found;
  }

  private externalAgentsView(): ExternalAgentView[] {
    return EXTERNAL_AGENTS.map((a) => ({
      id: a.id,
      label: a.label,
      description: t(a.description),
      installed: this.isInstalled(a.id),
      active: this.activeSession?.handoffAgentId === a.id,
    }));
  }

  /** "Opus 5.5" for a known id, the id itself otherwise. */
  private modelLabel(ref: string, id: string): string {
    const label = this.modelsFor(ref).find((m) => m.id === id)?.label;
    return label ? t(label) : id;
  }

  // ---------------------------------------------------------------- state plumbing

  private async onSettingsChanged(): Promise<void> {
    const previousShell = this.settings.shell;
    const claudeCodeWasEnabled = this.settings.claudeCode.enabled;
    this.settings = readSettings(this.shell.settings);
    if (this.settings.claudeCode.enabled && !claudeCodeWasEnabled) void this.checkClaudeCode();
    this.applyLocale();
    this.shell.settingsChanged?.(this.settings);
    await Promise.all(this.keyedProviders().filter((r) => !this.apiKeys.has(r)).map((r) => this.loadApiKey(r)));
    // Each session keeps its own "always allow" answers; the mode and the rules are the same for all.
    for (const session of this.sessions.values()) {
      session.permissions.setMode(this.settings.mode);
      session.permissions.setOverrides(this.settings.overrides);
    }
    // Provider settings may have changed: rebuild providers once nothing is using them.
    if (this.anyRunning()) this.providersStale = true;
    else this.disposeProviders();
    // A new shell takes a new host: idle sessions make way for new ones (a running one goes on).
    if (previousShell !== this.settings.shell) this.renewHosts();
    this.radar?.apply(this.settings.radar);
    this.updateStatus();
    this.postConfig();
    this.noteDroppedMainAgent();
  }

  private reportError(error: unknown): void {
    void this.shell.message('error', `Orka: ${error instanceof Error ? error.message : String(error)}`);
  }

  private configView(): ConfigView {
    const s = this.settings;
    // What runs is what the session shown would run on (its model menu choice).
    const shownChoice = this.activeSession ? this.sessionChoice(this.activeSession) : undefined;
    const agentView = (name: string, choice: AgentChoice, extra: Partial<AgentView> = {}): AgentView => {
      const { provider, model } = this.resolveAgent(name, shownChoice);
      return { name, provider: choice.provider, model: choice.model, effective: { provider, model }, ...extra };
    };
    const keyInfo = (ref: string): ProviderView['key'] => {
      const stored = this.apiKeys.get(ref);
      if (stored) return { source: 'stored', hint: stored.length > 8 ? `${stored.slice(0, 6)}••••${stored.slice(-4)}` : '••••' };
      const env = (ENV_KEYS[ref as ProviderKind] ?? []).find((name) => process.env[name]);
      return env ? { source: 'env', hint: env } : undefined;
    };
    const session = this.activeSession;
    const root = session?.root;
    const folders = this.shell.folders();
    const disabledSkills = new Set(s.skills.disabled);
    const skills: SkillView[] = this.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: !disabledSkills.has(skill.name),
      overridesBuiltin: skill.source === 'user' && this.builtinSkillNames.has(skill.name),
    }));
    const builtIns: ProviderView[] = this.builtInKinds().map((k) => ({
      kind: k,
      label: PROVIDERS[k].label,
      local: PROVIDERS[k].auth === 'local',
      ready: this.isReady(k),
      models: this.modelsFor(k),
      model: s.models[k],
      key: PROVIDERS[k].auth === 'apiKey' ? keyInfo(k) : undefined,
    }));
    const customs: ProviderView[] = s.customProviders.map((p) => {
      const ref = `custom:${p.id}`;
      return {
        kind: ref,
        label: p.label,
        local: !p.requiresKey,
        ready: this.isReady(ref),
        models: this.modelsFor(ref),
        model: p.defaultModel,
        key: keyInfo(ref),
        custom: { id: p.id, baseUrl: p.baseUrl, requiresKey: p.requiresKey },
      };
    });
    // Agent CLIs the user turned on, offered for the main agent only.
    const agents: ProviderView[] = this.agentEntries()
      .filter((e) => s.agentClis.enabled.includes(e.id))
      .map((e) => ({
        kind: `agent:${e.id}`,
        label: e.label,
        local: true,
        ready: this.isReady(`agent:${e.id}`),
        models: [{ id: '', label: t('Set in the agent'), family: t('Agent CLI') }],
        model: '',
        agent: true,
      }));
    return {
      locale: getLocale(),
      mode: s.mode,
      workspaceOpen: !!session,
      folders: folders.length > 1 || (this.shell.canOpenFolder && folders.length) ? folders : undefined,
      folder: root,
      canOpenFolder: this.shell.canOpenFolder,
      ...(this.shell.folderBrowser ? { canBrowseFolders: true } : {}),
      skillsEnabled: s.skills.enabled,
      skills,
      skillErrors: this.skillErrors,
      skillsFolder: USER_SKILLS_DIR,
      mcp: this.mcpView(),
      externalAgents: this.externalAgentsView(),
      pricing: s.pricing,
      providers: [...builtIns, ...customs, ...agents],
      sessionModel: session ? this.sessionModelView(session) : undefined,
      main: agentView('main', { provider: this.mainProvider(), model: this.defaultModel(this.mainProvider()) }),
      supervisor: agentView(
        'supervisor',
        s.supervisor,
        this.inheritsNoModel('supervisor') ? { unavailable: t('It sits out: next to an agent CLI it needs a model provider of its own. Add an API key, or pick a provider for it here.') } : {},
      ),
      fallback: agentView('fallback', s.fallback),
      light: agentView('light', s.light),
      subagentsEnabled: s.subagents.enabled,
      subagents: DEFAULT_SUBAGENTS.map((p) =>
        agentView(p.name, s.subagents.agents[p.name] ?? { provider: 'inherit', model: '' }, { description: p.description, access: p.access }),
      ),
      settings: {
        permissionMode: s.mode,
        permissions: {
          fileEdit: s.overrides.fileEdit ?? 'mode',
          terminal: s.overrides.terminal ?? 'mode',
          git: s.overrides.git ?? 'mode',
          delete: s.overrides.delete ?? 'mode',
          network: s.overrides.network ?? 'mode',
        },
        autoVerify: s.orchestrator.autoVerify,
        trackCommandChanges: { enabled: s.trackCommandChanges, unavailable: session?.snapshots.disabledReason },
        inlineReview: this.shell.kind === 'vscode' ? s.inlineReview : undefined,
        maxIterations: s.orchestrator.maxIterations,
        tokenBudget: s.orchestrator.tokenBudget ?? 0,
        language: s.language,
        commandTimeoutSeconds: Math.round(s.orchestrator.commandTimeoutMs / 1000),
        shell: s.shell ?? '',
        shellChoices: SHELL_CHOICES,
        customInstructions: s.orchestrator.customInstructions ?? '',
        compaction: s.orchestrator.compaction,
        subagentsMaxParallel: s.orchestrator.maxParallelSubagents ?? 3,
        parallelWorkers: s.orchestrator.parallelWorkers !== false,
        claude: { effort: s.claude.effort, refusalFallback: s.claude.refusalFallback },
        openai: { baseUrl: s.openai.baseUrl, reasoningEffort: s.openai.reasoningEffort ?? '' },
        gemini: { thinkingLevel: s.gemini.thinkingLevel ?? '' },
        claudeCode: {
          enabled: s.claudeCode.enabled,
          effort: s.claudeCode.effort ?? '',
          path: s.claudeCode.path ?? '',
          status: this.claudeCodeStatus,
          autoUpdate: s.claudeCode.autoUpdate,
          updating: !!this.claudeCodeUpdate,
          updatedAt: this.shell.globalState.get<number>(CLAUDE_UPDATE_STATE),
        },
        modelsRefreshedAt:
          Math.max(0, ...Object.values(this.shell.globalState.get<Record<string, { at: number }>>(MODEL_CACHE_STATE, {})).map((e) => e.at)) || undefined,
        supervisor: {
          enabled: s.supervisor.enabled,
          frequency: s.supervisor.frequency,
          maxInterventions: s.supervisor.maxInterventions,
          mode: s.supervisor.mode ?? 'parallel',
        },
        projectMemory: !root ? 'no_workspace' : existsSync(path.join(root, '.project-ai')) ? 'present' : 'missing',
        learnLessons: s.orchestrator.learnLessons !== false,
        presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseURL, requiresKey: p.requiresKey })),
      },
      app: this.appVersionView(),
      agentClis: this.agentClisView(),
      accounts: this.accountsView(),
      agentClisLeftOut: NOT_IN_CATALOG.map((a) => ({ id: a.id, reason: t(a.reason) })),
      ui: this.shell.kind === 'desktop' ? { layout: s.desktop.layout, theme: s.desktop.theme, maxRunning: s.sessions.maxRunning } : undefined,
    };
  }

  /** The config for a page's init: what the page has from then on. */
  private configForPage(): ConfigView {
    const config = this.configView();
    this.sentConfig = JSON.stringify(config);
    return config;
  }

  /**
   * The page gets the config when it changed (every check and setting posts it, mostly with
   * nothing new). `refresh`: sent even so, for the page to show it again over what the user just
   * changed in it (a choice that was refused or cancelled).
   */
  private postConfig(refresh = false): void {
    this.pruneKeyNotices();
    this.updateStatus();
    const config = this.configView();
    const json = JSON.stringify(config);
    if (refresh || json !== this.sentConfig) {
      this.sentConfig = json;
      this.shell.post({ type: 'config', config });
    }
    // Radar's model may have changed with the providers (a key added, a model list loaded).
    this.radar?.postState();
  }

  private updateStatus(): void {
    if (!this.shell.status) return;
    const running = this.anyRunning();
    const main = this.resolveAgent('main');
    const s = this.settings;
    const modeLabel = { ask: t('Ask'), balanced: t('Balanced'), autonomous: t('Autonomous') }[s.mode];
    const line = (name: string) => {
      const r = this.resolveAgent(name);
      return `${this.providerLabel(r.provider)} / ${r.model ? this.modelLabel(r.provider, r.model) : t('(no model)')}`;
    };
    const subs = s.subagents.enabled ? DEFAULT_SUBAGENTS.map((p) => `  ${p.name}: ${line(p.name)}`).join('\n') : `  ${t('(disabled)')}`;
    const sup = !s.supervisor.enabled
      ? `Supervisor: ${t('off')}`
      : this.inheritsNoModel('supervisor')
        ? `Supervisor: ${t('sits out (no model provider)')}`
        : `Supervisor: ${line('supervisor')}`;
    this.shell.status({
      running,
      text: `${this.providerLabel(main.provider)} · ${modeLabel}`,
      tooltip: [
        'Orka',
        `${t('Main agent')}: ${line('main')}`,
        sup,
        `Sub-agents:\n${subs}`,
        `${t('Permission mode')}: ${modeLabel}`,
        '',
        t('Click to configure agents.'),
      ].join('\n'),
    });
  }

  async dispose(): Promise<void> {
    clearInterval(this.appUpdateTimer);
    this.radar?.dispose();
    this.acpPool.dispose();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.activeId = undefined;
    await Promise.all(sessions.map((s) => s.dispose()));
    this.disposeProviders();
    this.mcp.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** What the install dialog says under its title: the exact command, its source, folder and docs. */
function installDetail(recipe: InstallRecipe): string {
  return [
    recipe.command,
    '',
    t('Official installer from {source}.', { source: recipe.sources.join(', ') }),
    recipe.folder ? t('It installs to {folder}.', { folder: recipe.folder }) : '',
    recipe.node ? t('Needs Node.js {min} or newer (npm); Orka checks it first.', { min: recipe.node }) : '',
    t('Docs: {url}', { url: recipe.docsUrl }),
    t('It runs in a terminal you can see, without administrator rights. Orka does not sign you in.'),
  ]
    .filter((line, i) => line || i === 1)
    .join('\n');
}

/** A command line typed by the user: words, or "quoted words" with spaces. */
function splitCommandLine(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((w) => w.length > 0);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}
