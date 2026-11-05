// The UI bundles as the apps build them: CodeMirror goes only into the desktop app's editor.js,
// never into webview.js (the VS Code panel), and editor.js stays within its size budget.
import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { highlightLines } from '../webview/editor/highlight';
import { languageFor } from '../webview/editor/languages';

// This file runs bundled from dist/test.
const APP = path.resolve(__dirname, '..', '..');
/** Minified editor.js at most (measured 0.64 MB with every grammar of 0.5). */
const EDITOR_BUDGET = 1.2 * 1024 * 1024;
const EDITOR_PACKAGES = /node_modules[\\/](@codemirror|@lezer|@marijn|style-mod|crelt|w3c-keyname)[\\/]/;

type Builds = (outdir: string, options?: { production?: boolean; editor?: boolean }) => esbuild.BuildOptions[];

async function builds(options: { production?: boolean; editor?: boolean }): Promise<esbuild.BuildOptions[]> {
  // A computed specifier: esbuild leaves it to Node instead of bundling the build script.
  const url = pathToFileURL(path.join(APP, 'webview-builds.mjs')).href;
  const { webviewBuilds } = (await import(url)) as { webviewBuilds: Builds };
  return webviewBuilds(path.join(tmpdir(), 'orka-bundles-test'), options);
}

const named = (all: esbuild.BuildOptions[], file: string) => all.find((b) => path.basename(String(b.outfile)) === file);

describe('UI bundles', () => {
  it('builds the editor only when asked, as the desktop app and the preview do', async () => {
    const plain = await builds({ production: true });
    assert.deepEqual(plain.map((b) => path.basename(String(b.outfile))), ['webview.js', 'webview.css', 'ide.css']);
    const desktop = await builds({ production: true, editor: true });
    assert.ok(named(desktop, 'editor.js') && named(desktop, 'editor.css'));
    // The VS Code extension builds the chat UI without the editor.
    const extension = readFileSync(path.join(APP, '..', 'vscode-extension', 'esbuild.mjs'), 'utf8');
    assert.match(extension, /webviewBuilds\('dist', \{ production \}\)/);
    assert.doesNotMatch(extension, /editor/);
  });

  it('keeps CodeMirror out of webview.js', async () => {
    const options = named(await builds({ production: true }), 'webview.js')!;
    const result = await esbuild.build({ ...options, write: false, metafile: true, sourcemap: false, logLevel: 'silent' });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.length > 10, 'the bundle has inputs');
    assert.deepEqual(
      inputs.filter((input) => EDITOR_PACKAGES.test(input)),
      [],
    );
  });

  it('keeps editor.js within its budget, with one copy of CodeMirror', async () => {
    const options = named(await builds({ production: true, editor: true }), 'editor.js')!;
    const result = await esbuild.build({ ...options, write: false, metafile: true, sourcemap: false, logLevel: 'silent' });
    const js = result.outputFiles.find((f) => f.path.endsWith('.js'))!;
    const report = await esbuild.analyzeMetafile(result.metafile);
    assert.ok(js.contents.length <= EDITOR_BUDGET, `editor.js is ${js.contents.length} bytes, over the budget:\n${report}`);
    // Two copies of @codemirror/state break every extension.
    const states = new Set(Object.keys(result.metafile.inputs).filter((i) => /@codemirror[\\/]state[\\/]/.test(i)).map((i) => i.replace(/[\\/]dist[\\/].*$/, '')));
    assert.equal(states.size, 1, [...states].join('\n'));
    // No grammar is loaded on demand: the page's CSP would not run another script anyway.
    assert.doesNotMatch(js.text, /\bimport\(/);
  });
});

describe("the editor's languages and highlighted lines", () => {
  it('picks a grammar by extension and leaves the rest plain', () => {
    assert.equal(languageFor('src/app.ts')?.name, 'TypeScript');
    assert.equal(languageFor('Assets/Scripts/Player.CS')?.name, 'C#');
    assert.equal(languageFor('Assets/Data/Level.asset')?.name, 'YAML');
    assert.equal(languageFor('README'), undefined);
    assert.equal(languageFor('notes.txt'), undefined);
    assert.equal(languageFor('odd.constructor'), undefined);
    assert.equal(languageFor('.env'), undefined);
  });

  it('highlights with classes only and escapes every text run', () => {
    const lines = ['const tag = "<script>alert(1)</script>";', 'if (a && b) { return 1; } // done'];
    const html = highlightLines('src/x.ts', lines)!;
    assert.equal(html.length, 2);
    assert.match(html[0], /<span class="tok-keyword">const<\/span>/);
    assert.ok(html[0].includes('&lt;script&gt;'), 'markup in the code is escaped');
    assert.ok(!html.join('').includes('<script'), 'never a tag of its own');
    assert.ok(html[1].includes('&amp;&amp;'));
    assert.doesNotMatch(html.join(''), /style=/);
    for (const tag of html.join('').match(/<[^>]+>/g) ?? []) assert.match(tag, /^(<span class="[\w -]+">|<\/span>)$/);
    // Without the markup it is the same text.
    const text = html.map((h) => h.split(/<[^>]*>/).join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    assert.deepEqual(text, lines);
  });

  it('highlights C# through the older modes, and gives up on long or unknown input', () => {
    const cs = highlightLines('Assets/Player.cs', ['public class Player : MonoBehaviour', '{', '    private int hp = 3;', '}'])!;
    assert.equal(cs.length, 4);
    assert.match(cs[0], /tok-keyword/);
    assert.equal(highlightLines('notes.txt', ['plain']), undefined);
    assert.equal(highlightLines('a.ts', Array.from({ length: 81 }, () => 'x;')), undefined);
    assert.equal(highlightLines('a.ts', ['one\ntwo']), undefined);
  });
});
