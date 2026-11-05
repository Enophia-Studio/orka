// The desktop app's local server on its own (src/server.ts, bundled here): the page's security
// headers, the files it serves and what it keeps for a page that is not connected.
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

describe('Orka desktop server', () => {
  let dir;
  let UiServer;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orka-server-test-'));
    const outfile = path.join(dir, 'server.cjs');
    await esbuild.build({ entryPoints: [path.join(here, '..', 'src', 'server.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' });
    ({ UiServer } = require(outfile));
    writeFileSync(path.join(dir, 'editor.js'), 'window.orkaEditor = { version: 1 };');
    writeFileSync(path.join(dir, 'editor.css'), '.cm-editor {}');
  });
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /** A started server and a cookie that lets requests in. */
  async function start() {
    const server = new UiServer({ distDir: dir, onMessage: () => undefined, getState: () => null, setState: () => undefined });
    const port = await server.listen();
    const login = await request(port, new URL(server.startUrl).pathname + new URL(server.startUrl).search);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    return { server, port, cookie };
  }

  function request(port, pathname, headers = {}) {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        })
        .on('error', reject);
    });
  }

  /** What the event stream sends right after it is opened (the backlog), as messages. */
  function firstEvents(port, cookie) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { cookie } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        setTimeout(() => {
          req.destroy();
          resolve([...body.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])));
        }, 300);
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
    });
  }

  it("allows the page's nonce for styles, and loads the editor before the chat UI", async () => {
    const { server, port, cookie } = await start();
    try {
      const page = await request(port, '/', { cookie });
      assert.equal(page.status, 200);
      const csp = page.headers['content-security-policy'];
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce, csp);
      const styleSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('style-src'));
      assert.equal(styleSrc, `style-src 'self' 'nonce-${nonce}'`);
      assert.doesNotMatch(csp, /unsafe-inline|strict-dynamic/);
      const editor = page.body.indexOf(`<script nonce="${nonce}" src="/editor.js"></script>`);
      assert.ok(editor > 0 && editor < page.body.indexOf('src="/webview.js"'), 'editor.js comes first');
      assert.ok(page.body.indexOf('href="/editor.css"') < page.body.indexOf('href="/theme.css"'), 'the theme still wins');
      const js = await request(port, '/editor.js', { cookie });
      assert.equal(js.status, 200);
      assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal((await request(port, '/editor.css', { cookie })).headers['content-type'], 'text/css; charset=utf-8');
    } finally {
      server.close();
    }
  });

  it('keeps no file contents for a page that is not connected', async () => {
    const { server, port, cookie } = await start();
    try {
      server.post({ type: 'fileContent', path: 'a.txt', ok: true, text: 'secret', hash: 'h', size: 6, eol: 'lf', bom: false });
      server.post({ type: 'dirEntries', path: '', entries: [] });
      server.post({ type: 'fileSaved', path: 'a.txt', hash: 'h' });
      server.post({ type: 'saveRefused', path: 'a.txt', reason: 'running' });
      server.post({ type: 'setInput', text: 'kept' });
      assert.deepEqual(await firstEvents(port, cookie), [{ type: 'setInput', text: 'kept' }]);
    } finally {
      server.close();
    }
  });
});
