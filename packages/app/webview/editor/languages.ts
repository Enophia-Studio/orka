// Which grammar the editor uses for a file, by its extension. A hand-written map: no grammar is
// loaded on demand (@codemirror/language-data would put import() calls into the bundle). Anything
// not listed opens as plain text.
import { css, cssLanguage } from '@codemirror/lang-css';
import { html, htmlLanguage } from '@codemirror/lang-html';
import { javascript, javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { json, jsonLanguage } from '@codemirror/lang-json';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { yaml, yamlLanguage } from '@codemirror/lang-yaml';
import { StreamLanguage, type Language } from '@codemirror/language';
import { c, cpp, csharp, java, shader } from '@codemirror/legacy-modes/mode/clike';
import type { Extension } from '@codemirror/state';

export interface LanguageEntry {
  /** Shown in the status line. */
  name: string;
  /** The grammar alone, for highlighting lines outside an editor. */
  language: Language;
  /** What the editor loads: the grammar with its indentation and key bindings. */
  support(): Extension;
}

const lezer = (name: string, language: Language, support: () => Extension): LanguageEntry => ({ name, language, support });

/** Grammars of the older CodeMirror modes (C# for Unity, C-like languages), each built once. */
const streams = new Map<string, Language>();
function stream(name: string, mode: Parameters<typeof StreamLanguage.define>[0]): LanguageEntry {
  let language = streams.get(name);
  if (!language) {
    language = StreamLanguage.define(mode);
    streams.set(name, language);
  }
  const defined = language;
  return { name, language: defined, support: () => defined };
}

const ENTRIES: Record<string, () => LanguageEntry> = {
  js: () => lezer('JavaScript', javascriptLanguage, () => javascript()),
  jsx: () => lezer('JavaScript (JSX)', jsxLanguage, () => javascript({ jsx: true })),
  ts: () => lezer('TypeScript', typescriptLanguage, () => javascript({ typescript: true })),
  tsx: () => lezer('TypeScript (TSX)', tsxLanguage, () => javascript({ typescript: true, jsx: true })),
  json: () => lezer('JSON', jsonLanguage, () => json()),
  css: () => lezer('CSS', cssLanguage, () => css()),
  html: () => lezer('HTML', htmlLanguage, () => html()),
  markdown: () => lezer('Markdown', markdownLanguage, () => markdown({ base: markdownLanguage })),
  python: () => lezer('Python', pythonLanguage, () => python()),
  yaml: () => lezer('YAML', yamlLanguage, () => yaml()),
  csharp: () => stream('C#', csharp),
  c: () => stream('C', c),
  cpp: () => stream('C++', cpp),
  java: () => stream('Java', java),
  shader: () => stream('Shader', shader),
};

const BY_EXTENSION: Record<string, keyof typeof ENTRIES> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  json: 'json',
  // Unity's assembly definitions are JSON.
  asmdef: 'json',
  asmref: 'json',
  css: 'css',
  // Unity UI Toolkit style sheets.
  uss: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  yaml: 'yaml',
  yml: 'yaml',
  // Unity's text-serialized assets are YAML.
  asset: 'yaml',
  meta: 'yaml',
  prefab: 'yaml',
  unity: 'yaml',
  mat: 'yaml',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  shader: 'shader',
  hlsl: 'shader',
  cginc: 'shader',
  compute: 'shader',
  glsl: 'shader',
  vert: 'shader',
  frag: 'shader',
};

export function languageFor(path: string): LanguageEntry | undefined {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(BY_EXTENSION, extension) ? ENTRIES[BY_EXTENSION[extension]]() : undefined;
}
