// The connection to the app: VS Code's webview API, or the desktop app's stand-in for it.
import { type FromWebview, SESSION_MESSAGES } from '../../src/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

// VS Code allows one call per page.
const vscode = acquireVsCodeApi();

/** The session the page shows, as the app's last init named it. */
let sessionId: string | undefined;

export function setSessionId(id: string | undefined): void {
  sessionId = typeof id === 'string' ? id : undefined;
}

export function shownSessionId(): string | undefined {
  return sessionId;
}

/**
 * A message from the app is for the session shown: it names that session, or none (app-wide), or
 * the page does not know its session yet. A late reply or event of another session is not.
 */
export function forShownSession(message: object): boolean {
  const named = (message as { sessionId?: unknown }).sessionId;
  return named === undefined || sessionId === undefined || named === sessionId;
}

/**
 * Messages about the session shown name it, so the app never applies them to another one. A
 * message that already names a session (Stop on another open session) keeps that name.
 */
export const post = (message: FromWebview) =>
  vscode.postMessage(
    sessionId !== undefined && SESSION_MESSAGES.has(message.type) && (message as { sessionId?: unknown }).sessionId === undefined ? { ...message, sessionId } : message,
  );

/** What the UI keeps across reloads: the unsent draft and, in the desktop app, which side panels are closed. */
export interface UiState {
  draft?: string;
  sidebarClosed?: boolean;
  asideClosed?: boolean;
  /** Folded sections of the session list ("group:<id>", "folder:<path>"). */
  collapsedSections?: string[];
  /** The accounts in the session list's footer are folded open. */
  accountsOpen?: boolean;
  /** The tab of the side panel: the task's plan and changes, Files (desktop), or Radar. */
  asideTab?: 'task' | 'radar' | 'files';
  /**
   * The desktop editor in this folder: the file open (and whether it showed in place of the
   * conversation) and the folders open in the Files tree. Paths only, never a file's contents.
   */
  editor?: { folder: string; path?: string; shown?: boolean; expanded: string[] };
}

const initial = vscode.getState();
let state: UiState = initial && typeof initial === 'object' ? { ...(initial as UiState) } : {};

export function uiState(): Readonly<UiState> {
  return state;
}

/** How long changes gather before they are saved: typing saves a few times a second, not on every key. */
export const UI_STATE_SAVE_MS = 300;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Changes these fields. The whole state is saved (VS Code replaces it on every call) a moment
 * later, with whatever else changed meanwhile; uiState() has the change at once.
 */
export function saveUiState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  saveTimer ??= setTimeout(flushUiState, UI_STATE_SAVE_MS);
}

/** Saves a change still waiting now (the page is going away or out of sight). */
export function flushUiState(): void {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  vscode.setState(state);
}

// A reload or a closed window keeps the last keys typed.
globalThis.addEventListener?.('pagehide', flushUiState);
globalThis.document?.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushUiState();
});
