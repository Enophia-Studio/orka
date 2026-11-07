import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TR } from '../src/i18n/tr';
import {
  buildCatalogServer,
  CATALOG_RUNNERS,
  catalogAvailable,
  catalogCommandLine,
  catalogEntry,
  catalogLaunch,
  catalogRunKind,
  catalogServerName,
  catalogStrings,
  catalogTarget,
  findCatalogEntry,
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
} from '../src/mcp/catalog';

/** Binaries a publisher documents as the server itself (not a package runner). */
const DOCUMENTED_BINARIES: Record<string, string[]> = {
  'roblox-studio': ['cmd.exe', '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP'],
};

const PLACEHOLDER = /<[^>]*>|\.\.\.|xxx|your[-_ ]?(key|token)|changeme|example\.com/i;

describe('MCP catalog', () => {
  it('has well-formed entries: unique ids, https pages, known categories and runners, no placeholders', () => {
    assert.ok(MCP_CATALOG.length >= 40, `${MCP_CATALOG.length} entries`);
    const ids = new Set<string>();
    for (const e of MCP_CATALOG) {
      const where = `entry ${e.id}`;
      assert.match(e.id, /^[a-z0-9][a-z0-9-]{0,39}$/, where);
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
      ids.add(e.id);
      assert.ok(e.name && e.description && e.vendor, where);
      assert.ok(MCP_CATALOG_CATEGORIES.includes(e.category), where);
      assert.ok(e.homepage.startsWith('https://'), `${where}: homepage ${e.homepage}`);
      if (e.setup) assert.ok(e.setup.link.startsWith('https://'), where);
      assert.ok(e.platforms === 'any' || e.platforms.length > 0, where);
      const names = new Set<string>();
      for (const f of e.fields) {
        assert.ok(!names.has(f.name), `${where}: duplicate field ${f.name}`);
        names.add(f.name);
        assert.ok(f.help, `${where}: ${f.name} has help`);
        if (f.link) assert.ok(f.link.startsWith('https://'), `${where}: ${f.name} link`);
        // A secret is never prefilled; a default is never a placeholder.
        if (f.secret) assert.equal(f.default, undefined, `${where}: secret ${f.name} has a default`);
        if (f.default !== undefined) assert.doesNotMatch(f.default, PLACEHOLDER, `${where}: ${f.name} default`);
        if (f.template) assert.ok(f.template.includes('{value}') && f.target === 'header', `${where}: ${f.name} template`);
        if (f.target === 'header') assert.match(f.name, /^[A-Za-z][A-Za-z0-9-]*$/, `${where}: header name`);
        if (f.target === 'env') assert.match(f.name, /^[A-Za-z_][A-Za-z0-9_]*$/, `${where}: env name`);
      }
      if (e.transport === 'http') {
        assert.ok(e.url && /^https?:\/\//.test(e.url), `${where}: url`);
        assert.doesNotMatch(e.url!, PLACEHOLDER, `${where}: url placeholder`);
        // Plain http only to this computer.
        if (e.url!.startsWith('http://')) assert.match(e.url!, /^http:\/\/(localhost|127\.0\.0\.1)[:/]/, `${where}: http only on loopback`);
        assert.ok(!e.launch && !e.platformLaunch, `${where}: http with a command`);
        assert.ok(e.fields.every((f) => f.target === 'header'), `${where}: http takes headers only`);
      } else {
        assert.ok(e.launch && !e.url, `${where}: stdio launch`);
        for (const launch of [e.launch!, ...Object.values(e.platformLaunch ?? {})]) {
          assert.ok(CATALOG_RUNNERS.includes(launch.command) || DOCUMENTED_BINARIES[e.id]?.includes(launch.command), `${where}: command ${launch.command}`);
          const tokens = launch.args.flatMap((a) => [...a.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]));
          for (const token of tokens) assert.ok(e.fields.some((f) => f.target === 'arg' && f.name === token), `${where}: {${token}} has an arg field`);
          for (const a of launch.args) assert.doesNotMatch(a.replace(/\{[A-Za-z_]\w*\}/g, ''), PLACEHOLDER, `${where}: arg ${a}`);
        }
        for (const f of e.fields.filter((f) => f.target === 'arg')) {
          assert.ok(!f.secret, `${where}: secret in an argument`);
          assert.ok(e.launch!.args.some((a) => a.includes(`{${f.name}}`)), `${where}: unused arg field ${f.name}`);
        }
        assert.ok(e.fields.every((f) => f.target !== 'header'), `${where}: stdio takes no headers`);
      }
    }
  });

  it('has a Turkish translation for every description, note, prerequisite and field help', () => {
    const missing = catalogStrings().filter((s) => !(s in TR));
    assert.deepEqual(missing, [], `missing Turkish translations:\n${missing.join('\n')}`);
  });

  it('builds a stdio server from the fields, ignoring keys that are not fields', () => {
    const github = catalogEntry('github-docker')!;
    const built = buildCatalogServer(github, { GITHUB_PERSONAL_ACCESS_TOKEN: ' ghp_secretvalue ', PATH: 'C:\\evil', EXTRA: 'x' }, 'win32');
    assert.ok(built.ok);
    assert.deepEqual(built.config, {
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secretvalue' },
    });
    // The command line shown never carries the secret.
    assert.doesNotMatch(catalogCommandLine(built.config), /ghp_secretvalue/);
  });

  it('fills arguments, keeps defaults out unless entered, and refuses missing or broken values', () => {
    const fsEntry = catalogEntry('filesystem')!;
    const missing = buildCatalogServer(fsEntry, {}, 'linux');
    assert.deepEqual(missing, { ok: false, missing: ['ALLOWED_DIR'], invalid: [] });
    const built = buildCatalogServer(fsEntry, { ALLOWED_DIR: 'C:\\My Projects\\game' }, 'win32');
    assert.ok(built.ok);
    assert.deepEqual(built.config, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Projects\\game'] });
    assert.equal(catalogCommandLine(built.config), 'npx -y @modelcontextprotocol/server-filesystem "C:\\My Projects\\game"');
    // A token in a value is not filled again.
    const odd = buildCatalogServer(fsEntry, { ALLOWED_DIR: '{ALLOWED_DIR}$&' }, 'linux');
    assert.ok(odd.ok && 'command' in odd.config && odd.config.args![2] === '{ALLOWED_DIR}$&');
    const broken = buildCatalogServer(catalogEntry('brave-search')!, { BRAVE_API_KEY: 'abc\nINJECTED=1' }, 'linux');
    assert.deepEqual(broken, { ok: false, missing: [], invalid: ['BRAVE_API_KEY'] });
    assert.deepEqual(buildCatalogServer(catalogEntry('brave-search')!, { BRAVE_API_KEY: 'x'.repeat(5000) }, 'linux'), { ok: false, missing: [], invalid: ['BRAVE_API_KEY'] });
  });

  it('builds an http server with its header template; an optional header left empty is left out', () => {
    const remote = buildCatalogServer(catalogEntry('github')!, { Authorization: 'github_pat_1' }, 'darwin');
    assert.ok(remote.ok);
    assert.deepEqual(remote.config, { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer github_pat_1' } });
    assert.deepEqual(buildCatalogServer(catalogEntry('context7')!, { Authorization: '' }, 'darwin'), { ok: true, config: { url: 'https://mcp.context7.com/mcp' } });
    assert.equal(buildCatalogServer(catalogEntry('github')!, {}, 'darwin').ok, false);
  });

  it('knows which systems an entry works on and what each one starts', () => {
    const roblox = catalogEntry('roblox-studio')!;
    assert.equal(catalogAvailable(roblox, 'linux'), false);
    assert.equal(catalogAvailable(roblox, 'win32'), true);
    assert.equal(catalogLaunch(roblox, 'darwin')!.command, '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP');
    assert.equal(catalogLaunch(roblox, 'win32')!.command, 'cmd.exe');
    assert.equal(catalogAvailable(catalogEntry('deepwiki')!, 'freebsd'), true);
    assert.equal(catalogTarget(catalogEntry('git')!, 'linux'), 'uvx mcp-server-git --repository {REPOSITORY}');
    assert.equal(catalogRunKind(catalogEntry('playwright')!, 'win32'), 'download');
    assert.equal(catalogRunKind(roblox, 'win32'), 'program');
    assert.equal(catalogRunKind(catalogEntry('mcp-for-unity')!, 'win32'), 'local-url');
    assert.equal(catalogRunKind(catalogEntry('github')!, 'win32'), 'remote-url');
  });

  it('finds the entry a configured server came from, by name, URL or package', () => {
    assert.equal(findCatalogEntry('playwright', { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, 'linux')?.id, 'playwright');
    assert.equal(findCatalogEntry('browser', { command: 'npx.cmd', args: ['@playwright/mcp@0.0.40', '--headless'] }, 'win32')?.id, 'playwright');
    assert.equal(findCatalogEntry('UnityMCP', { url: 'http://localhost:8080/mcp/' }, 'win32')?.id, 'mcp-for-unity');
    assert.equal(findCatalogEntry('supa', { url: 'https://mcp.supabase.com/mcp?project_ref=x' }, 'win32')?.id, 'supabase');
    assert.equal(findCatalogEntry('gh', { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'] }, 'linux')?.id, 'github-docker');
    assert.equal(findCatalogEntry('redis', { command: 'uvx', args: ['--from', 'redis-mcp-server@0.3', 'redis-mcp-server'] }, 'linux')?.id, 'redis');
    assert.equal(findCatalogEntry('mine', { command: 'node', args: ['server.js'] }, 'linux'), undefined);
    // A same-named server of the other transport is not that entry.
    assert.equal(findCatalogEntry('playwright', { url: 'http://localhost:9999/mcp' }, 'linux'), undefined);
  });

  it('picks a free server name', () => {
    const entry = catalogEntry('memory')!;
    assert.equal(catalogServerName(entry, ['other']), 'memory');
    assert.equal(catalogServerName(entry, ['Memory', 'memory-2']), 'memory-3');
  });
});
