// The desktop app's file editor: CodeMirror 6, built into editor.js and loaded by the desktop page
// (and the preview) before webview.js, which finds it as window.orkaEditor. The VS Code extension
// never ships it. Nothing happens at load besides setting the hook.
//
// The page's Content Security Policy allows style elements only with the page's nonce: every view
// gets it (EditorView.cspNonce) for CodeMirror's own base styles, and syntax colors are classes
// (tok-*) styled by editor.css, so no style attribute is ever written for them.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { Compartment, EditorState, Transaction, type Extension, type Text } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, type KeyBinding } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { EditorCursor, EditorHandle, EditorOpenOptions, OrkaEditor } from '../core/editorApi';
import { highlightLines } from './highlight';
import { languageFor } from './languages';

// Read while this script runs: currentScript is gone afterwards.
const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? '';

/** CodeMirror's Ctrl+K bindings (Ctrl+Shift+K deletes a line) are left out: Ctrl+K belongs to the session search. */
const withoutModK = (bindings: readonly KeyBinding[]) =>
  bindings.filter((b) => {
    const parts = (b.key ?? '').toLowerCase().split('-');
    return !(parts.includes('mod') && parts[parts.length - 1] === 'k');
  });

function open(parent: HTMLElement, options: EditorOpenOptions): EditorHandle {
  const readOnly = new Compartment();
  const language = languageFor(options.path);
  const cursorOf = (state: EditorState): EditorCursor => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1, selected: state.selection.main.to - state.selection.main.from };
  };
  const extensions: Extension[] = [
    EditorView.cspNonce.of(nonce),
    EditorState.phrases.of(options.phrases),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(classHighlighter),
    keymap.of([
      // Ctrl+S saves through the app (and the browser's own save dialog never opens).
      { key: 'Mod-s', preventDefault: true, run: () => (options.onSave(), true) },
      { key: 'Mod-l', run: () => (options.onSendSelection(), true) },
      ...withoutModK(searchKeymap),
      ...withoutModK(defaultKeymap),
      ...withoutModK(historyKeymap),
      indentWithTab,
      // Escape closes the search panel first (searchKeymap); otherwise it leaves the editor.
      { key: 'Escape', run: (view) => (searchPanelOpen(view.state) ? false : (options.onEscape(), true)) },
    ]),
    readOnly.of(EditorState.readOnly.of(options.readOnly)),
    EditorView.contentAttributes.of({ 'aria-label': options.path }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange();
      if (update.docChanged || update.selectionSet) options.onSelectionChange(cursorOf(update.state));
    }),
  ];
  if (language) extensions.push(language.support());

  const view = new EditorView({ parent, state: EditorState.create({ doc: options.text, extensions }) });
  let clean: Text = view.state.doc;

  return {
    getText: () => view.state.doc.toString(),
    replaceText(text) {
      const current = view.state.doc.toString();
      if (current === text) {
        clean = view.state.doc;
        // Typed text that now matches the file again: the buffer is clean.
        options.onChange();
      } else {
        // Only the part that differs is replaced, so the cursor and the scroll stay where they were.
        const max = Math.min(current.length, text.length);
        let start = 0;
        while (start < max && current.charCodeAt(start) === text.charCodeAt(start)) start++;
        let end = 0;
        while (end < max - start && current.charCodeAt(current.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
        const transaction = view.state.update({
          changes: { from: start, to: current.length - end, insert: text.slice(start, text.length - end) },
          // The file changed on disk: not something to undo.
          annotations: Transaction.addToHistory.of(false),
        });
        // Clean before the change is announced (onChange asks isDirty()).
        clean = transaction.newDoc;
        view.dispatch(transaction);
      }
    },
    markClean(text) {
      clean = text === undefined ? view.state.doc : view.state.toText(text);
    },
    isDirty: () => !view.state.doc.eq(clean),
    setReadOnly(value) {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(value)) });
    },
    selection() {
      const range = view.state.selection.main;
      if (range.empty) return undefined;
      const doc = view.state.doc;
      const start = doc.lineAt(range.from);
      let end = doc.lineAt(range.to);
      // A selection that ends at the start of a line does not take that line.
      if (range.to === end.from && end.number > start.number) end = doc.line(end.number - 1);
      return { startLine: start.number, endLine: end.number, text: view.state.sliceDoc(range.from, range.to) };
    },
    cursor: () => cursorOf(view.state),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

const editor: OrkaEditor = {
  version: 1,
  open,
  highlightLines,
  languageName: (path) => languageFor(path)?.name,
};

window.orkaEditor = editor;
