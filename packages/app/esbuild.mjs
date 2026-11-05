// Builds the chat UI into dist/ for the browser preview (npm run preview), with the desktop app's
// file editor for its ?ide view. The VS Code extension and the desktop app bundle the same sources
// into their own dist folders.
import * as esbuild from 'esbuild';
import { webviewBuilds } from './webview-builds.mjs';

await Promise.all(webviewBuilds('dist', { production: process.argv.includes('--production'), editor: true }).map((options) => esbuild.build(options)));
console.log('[esbuild] webview built');
