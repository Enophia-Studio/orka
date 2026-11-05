// esbuild options for the chat UI, shared by every package that ships it.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `editor`: also build the desktop app's file editor (editor.js and editor.css, CodeMirror). Only
 * the desktop app and the browser preview ask for it; the VS Code extension never ships it.
 * @returns {import('esbuild').BuildOptions[]}
 */
export function webviewBuilds(outdir, { production = false, editor = false } = {}) {
  const builds = [
    {
      entryPoints: [path.join(here, 'webview/main.ts')],
      // The logo is inlined into the bundle (the UI's CSP allows data: images only).
      loader: { '.svg': 'text' },
      outfile: path.join(outdir, 'webview.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      sourcemap: !production,
      minify: production,
      // Lists the bundled packages for THIRD_PARTY_NOTICES.txt.
      metafile: true,
    },
    {
      entryPoints: [path.join(here, 'webview/styles.css')],
      outfile: path.join(outdir, 'webview.css'),
      bundle: true,
      minify: production,
    },
    // The desktop app's IDE layout (only its page loads it).
    {
      entryPoints: [path.join(here, 'webview/ide.css')],
      outfile: path.join(outdir, 'ide.css'),
      bundle: true,
      minify: production,
    },
  ];
  if (editor) {
    builds.push(
      {
        // One classic script, no code splitting: the page's CSP runs only scripts with its nonce.
        entryPoints: [path.join(here, 'webview/editor/index.ts')],
        outfile: path.join(outdir, 'editor.js'),
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        sourcemap: !production,
        minify: production,
        metafile: true,
      },
      {
        entryPoints: [path.join(here, 'webview/editor/editor.css')],
        outfile: path.join(outdir, 'editor.css'),
        bundle: true,
        minify: production,
      },
    );
  }
  return builds;
}
