// Settings > MCP > Catalog: the page's HTML, and the app adding a server only after consent.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { catalogEntry } from '@orka/core/src/mcp/catalog';
import { AppController } from '../src/AppController';
import type { McpServerView } from '../src/protocol';
import { addedEntries, catalogFormHtml, catalogHtml, catalogListHtml, type CatalogState, filterCatalog, missingFields } from '../webview/features/mcpCatalog';
import { FakeShell } from './fakeShell';

const state = (patch: Partial<CatalogState> = {}): CatalogState => ({ query: '', category: '', open: new Set(), ...patch });

const server = (name: string, catalogId?: string): McpServerView => ({
  name,
  source: 'settings',
  transport: 'stdio',
  target: 'npx x',
  enabled: true,
  state: 'idle',
  tools: 0,
  exposed: 0,
  toolNames: [],
  limits: {},
  catalogId,
});

describe('MCP catalog page', () => {
  it('searches across names, vendors and descriptions, filters by category, and puts archived entries last', () => {
    assert.deepEqual(
      filterCatalog(state({ query: 'unity' })).map((e) => e.id),
      ['mcp-for-unity'],
    );
    assert.ok(filterCatalog(state({ query: 'microsoft' })).some((e) => e.id === 'playwright'));
    const browser = filterCatalog(state({ category: 'browser' }));
    assert.ok(browser.every((e) => e.category === 'browser'));
    assert.equal(browser.at(-1)!.id, 'puppeteer');
    assert.match(catalogListHtml(state({ query: 'zzz-nothing' }), [], 'win32'), /No servers match/);
  });

  it('shows badges, licence, Added for servers already in the list, and Not for this system', () => {
    const html = catalogListHtml(state(), [server('my-playwright', 'playwright')], 'linux');
    const row = (id: string) => html.split('data-entry="').find((part) => part.startsWith(`${id}"`))!;
    assert.match(row('playwright'), /Official/);
    assert.match(row('playwright'), /Apache-2\.0/);
    assert.match(row('playwright'), /Added/);
    assert.doesNotMatch(row('playwright'), /data-action="catalog-add"/);
    assert.match(row('godot-mcp'), /Community/);
    assert.match(row('godot-mcp'), /data-action="catalog-add" data-id="godot-mcp"/);
    assert.match(row('sentry'), /Licence not stated/);
    // Roblox Studio has no Linux build.
    assert.match(row('roblox-studio'), /Not for this system/);
    assert.match(row('puppeteer'), /Archived/);
    assert.deepEqual([...addedEntries([server('a', 'git'), server('b', 'git'), server('c')])], [['git', ['a', 'b']]]);
  });

  it('opens details with what it needs, the exact command or URL and the setup step', () => {
    const html = catalogListHtml(state({ open: new Set(['mcp-for-unity', 'git']) }), [], 'win32');
    assert.match(html, /Unity: add the MCP for Unity package to your project first/);
    assert.match(html, /data-action="catalog-link" data-id="mcp-for-unity" data-link="setup"/);
    assert.match(html, /http:\/\/localhost:8080\/mcp/);
    assert.match(html, /uvx mcp-server-git --repository \{REPOSITORY\}/);
    assert.match(html, /Unity 2021\.3 LTS or later/);
    // The search box keeps the query, escaped.
    const head = catalogHtml(state({ query: '"><img src=x onerror=alert(1)>' }), [], 'win32');
    assert.doesNotMatch(head, /<img/);
    assert.match(head, /value="&quot;&gt;&lt;img/);
  });

  it('asks for secrets in password fields that start empty, and prefills only non-secret defaults', () => {
    const form = catalogFormHtml(catalogEntry('toolbox-mysql')!);
    assert.match(form, /id="catalog-field-MYSQL_PASSWORD" type="password" data-catalog-field="MYSQL_PASSWORD" value=""/);
    assert.match(form, /id="catalog-field-MYSQL_PORT" type="text" data-catalog-field="MYSQL_PORT" value="3306"/);
    assert.match(form, /never shown again/);
    const marked = catalogFormHtml(catalogEntry('toolbox-mysql')!, ['MYSQL_HOST']);
    assert.match(marked, /data-catalog-field="MYSQL_HOST" value="" autocomplete="off" spellcheck="false" aria-invalid="true"/);
    assert.match(marked, /Fill in the required fields/);
    assert.deepEqual(missingFields(catalogEntry('toolbox-mysql')!, { MYSQL_HOST: ' ', MYSQL_PORT: '3306', MYSQL_DATABASE: 'db', MYSQL_USER: 'u', MYSQL_PASSWORD: 'p' }), ['MYSQL_HOST']);
    // A field with a page of its own links to it through the app.
    assert.match(catalogFormHtml(catalogEntry('brave-search')!), /data-action="catalog-link" data-id="brave-search" data-link="field" data-field="BRAVE_API_KEY"/);
  });
});

let home: string;
let controllers: AppController[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'orka-catalog-test-'));
  for (const dir of [path.join(home, 'work'), path.join(home, 'builtin-skills')]) mkdirSync(dir, { recursive: true });
  process.env.ORKA_NO_UPDATE_CHECK = '1';
});

afterEach(async () => {
  for (const controller of controllers) await controller.dispose();
  controllers = [];
  rmSync(home, { recursive: true, force: true });
});

async function start(settings: Record<string, unknown> = {}) {
  const shell = new FakeShell('desktop', home, [path.join(home, 'work')], settings);
  const controller = new AppController(shell);
  controllers.push(controller);
  await controller.initialize();
  return { shell, controller };
}

describe('adding from the MCP catalog', () => {
  const secret = 'ghp_TOPSECRET123';

  it('writes nothing until the user agrees in a dialog that shows the exact command, and never shows the secret', async () => {
    const { shell, controller } = await start({ mcpServers: { mine: { command: 'node', args: ['s.js'] } } });
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'github-docker', values: { GITHUB_PERSONAL_ACCESS_TOKEN: secret } });
    const consent = shell.asked.at(-1)!;
    assert.equal(consent.modal, true);
    assert.deepEqual(consent.actions, ['Add and turn on']);
    assert.match(consent.text, /GitHub MCP \(Docker\)/);
    assert.match(consent.detail!, /Command: docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr\.io\/github\/github-mcp-server/);
    assert.match(consent.detail!, /downloads this third-party server/);
    assert.match(consent.detail!, /Environment: GITHUB_PERSONAL_ACCESS_TOKEN \(values hidden\)/);
    // Declined (no answer): the list is as it was.
    assert.deepEqual(Object.keys(shell.settings.data.mcpServers as object), ['mine']);

    shell.answer = 'Add and turn on';
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'github-docker', values: { GITHUB_PERSONAL_ACCESS_TOKEN: secret, PATH: 'C:\\evil' } });
    const servers = shell.settings.data.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers['github-docker'], {
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: secret },
    });
    assert.ok(servers.mine, 'the other servers stay');
    // No dialog, notice or page message carries the secret.
    assert.ok(shell.asked.every((m) => !`${m.text} ${m.detail ?? ''}`.includes(secret)));
    assert.ok(shell.posted.every((m) => !JSON.stringify(m).includes(secret)));
    // The settings view shows it as added from the catalog.
    const added = () => shell.pageConfig()?.mcp.servers.some((s) => s.name === 'github-docker');
    for (let i = 0; i < 100 && !added(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const view = shell.pageConfig()!.mcp;
    assert.equal(view.servers.find((s) => s.name === 'github-docker')?.catalogId, 'github-docker');
    assert.equal(view.servers.find((s) => s.name === 'mine')?.catalogId, undefined);
    assert.equal(view.platform, process.platform);
    assert.match(shell.asked.at(-1)!.text, /github-docker was added to your MCP servers/);
  });

  it('adds a hosted server with its header, under a free name, and a server without fields straight to consent, keeping the rest of the list', async () => {
    // An entry Orka cannot read stays in the file as it is.
    const { shell, controller } = await start({ mcpServers: { github: { url: 'https://example.org/mcp' }, 'not valid!': { note: 'kept' } } });
    shell.answer = 'Add and turn on';
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'github', values: { Authorization: 'pat_1' } });
    assert.match(shell.asked.at(-2)!.detail!, /Address: https:\/\/api\.githubcopilot\.com\/mcp\/[\s\S]*Headers: Authorization \(values hidden\)[\s\S]*sends the agents’ tool requests/);
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'mcp-for-unity', values: {} });
    assert.match(shell.asked.at(-2)!.detail!, /connects to a server running on this computer/);
    const servers = shell.settings.data.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers['github-2'], { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer pat_1' } });
    assert.deepEqual(servers['mcp-for-unity'], { url: 'http://localhost:8080/mcp' });
    assert.deepEqual(servers.github, { url: 'https://example.org/mcp' });
    assert.deepEqual(servers['not valid!'], { note: 'kept' });
  });

  it('refuses unknown entries, missing or broken values, and entries for another system, without asking to add', async () => {
    const { shell, controller } = await start();
    shell.answer = 'Add and turn on';
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'not-in-catalog', values: {} });
    assert.equal(shell.asked.length, 0);
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'filesystem', values: {} });
    assert.match(shell.asked.at(-1)!.text, /Fill in: ALLOWED_DIR/);
    await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'brave-search', values: { BRAVE_API_KEY: 'a\nb' } });
    assert.match(shell.asked.at(-1)!.text, /cannot be used.*BRAVE_API_KEY/);
    if (process.platform === 'linux') {
      await controller.handleMessage({ type: 'addMcpFromCatalog', id: 'roblox-studio', values: {} });
      assert.match(shell.asked.at(-1)!.text, /not available on this system/);
    }
    assert.ok(shell.asked.every((m) => !m.actions.includes('Add and turn on')));
    assert.equal(shell.settings.data.mcpServers, undefined);
  });

  it("opens only the catalog's own https pages", async () => {
    const { shell, controller } = await start();
    await controller.handleMessage({ type: 'openMcpCatalogLink', id: 'mcp-for-unity', link: 'setup' });
    await controller.handleMessage({ type: 'openMcpCatalogLink', id: 'brave-search', link: 'field', field: 'BRAVE_API_KEY' });
    await controller.handleMessage({ type: 'openMcpCatalogLink', id: 'playwright', link: 'homepage' });
    await controller.handleMessage({ type: 'openMcpCatalogLink', id: 'nope', link: 'homepage' });
    await controller.handleMessage({ type: 'openMcpCatalogLink', id: 'playwright', link: 'field', field: 'x' });
    assert.deepEqual(shell.opened, [
      'https://github.com/CoplayDev/unity-mcp',
      'https://api-dashboard.search.brave.com/app/keys',
      'https://github.com/microsoft/playwright-mcp',
    ]);
  });
});
