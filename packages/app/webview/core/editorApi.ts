// The desktop app's file editor as the chat UI sees it: window.orkaEditor, set by editor.js
// (webview/editor/index.ts), which the desktop page loads before webview.js. Types only: the chat
// UI never imports CodeMirror, and in VS Code (or the classic layout) the hook is simply absent.

/** Where the cursor is, for the status line (1-based). */
export interface EditorCursor {
  line: number;
  col: number;
  /** Characters selected (0: none). */
  selected: number;
}

/** The selected lines (1-based, inclusive) and the selected text, as the buffer shows them. */
export interface EditorRange {
  startLine: number;
  endLine: number;
  text: string;
}

export interface EditorOpenOptions {
  /** Workspace-relative path; picks the language. */
  path: string;
  /** The file's text with \n line breaks. */
  text: string;
  readOnly: boolean;
  /** CodeMirror's own texts (the search panel), already translated: English text -> shown text. */
  phrases: Record<string, string>;
  /** The text changed (typing, undo, replaceText). */
  onChange(): void;
  /** Ctrl+S. */
  onSave(): void;
  /** Ctrl+L: send the selection to the agent. */
  onSendSelection(): void;
  /** The cursor or the selection moved. */
  onSelectionChange(cursor: EditorCursor): void;
  /** Escape with no search panel open. */
  onEscape(): void;
}

export interface EditorHandle {
  getText(): string;
  /** Put new text in (a file that changed on disk), keeping the cursor and the scroll where they can stay; the buffer is clean afterwards. */
  replaceText(text: string): void;
  /** The buffer matches the file: the given text (what was saved), or the text it has now. */
  markClean(text?: string): void;
  isDirty(): boolean;
  setReadOnly(readOnly: boolean): void;
  selection(): EditorRange | undefined;
  cursor(): EditorCursor;
  focus(): void;
  destroy(): void;
}

export interface OrkaEditor {
  version: 1;
  open(parent: HTMLElement, options: EditorOpenOptions): EditorHandle;
  /**
   * Lines of code as highlighted HTML (escaped text in <span class="tok-…"> only), one string per
   * line; undefined for an unknown language or more than 80 lines.
   */
  highlightLines(path: string, lines: string[]): string[] | undefined;
  /** "TypeScript", "C#"; undefined when the editor shows the file as plain text. */
  languageName(path: string): string | undefined;
}

declare global {
  interface Window {
    orkaEditor?: OrkaEditor;
  }
}
