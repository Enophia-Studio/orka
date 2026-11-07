import type { McpServerConfig } from './McpClient';

/**
 * Orka's bundled catalog of MCP servers: browsed with no network access, added only after the user
 * saw the exact command or URL and agreed. Every entry was checked against its publisher's README
 * or docs page (November 2026); servers whose command could not be confirmed (it depends on a
 * package-cache hash, a local clone, or flags the docs never print together) are left out, and so
 * are hosted servers that accept only OAuth sign-in, which Orka's MCP client does not do.
 *
 * Prose (descriptions, notes, prerequisites, field help) is English here and translated where it
 * is shown, with t(); a test checks that every such string has a Turkish entry.
 */
export type McpCatalogCategory =
  | 'game-dev'
  | 'browser'
  | 'source-control'
  | 'issues'
  | 'databases'
  | 'cloud'
  | 'design'
  | 'docs-search'
  | 'files-system'
  | 'ai-tools'
  | 'productivity'
  | 'other';

export const MCP_CATALOG_CATEGORIES: readonly McpCatalogCategory[] = [
  'game-dev',
  'browser',
  'source-control',
  'issues',
  'databases',
  'cloud',
  'design',
  'docs-search',
  'files-system',
  'ai-tools',
  'productivity',
  'other',
];

export type McpCatalogPlatform = 'windows' | 'macos' | 'linux';

/** Something the user enters before the server is added. */
export interface McpCatalogField {
  /** The environment variable or header name; for an argument, the {NAME} token in the args. */
  name: string;
  target: 'env' | 'header' | 'arg';
  /** A password field: never shown back, never part of the command line Orka displays. */
  secret?: boolean;
  /** Arguments are always required (an empty one would leave a dangling flag). */
  required?: boolean;
  /** Prefilled value (never for a secret). */
  default?: string;
  /** A header's value around what the user typed: "Bearer {value}". */
  template?: string;
  /** What to enter or where it comes from. */
  help: string;
  /** The publisher's page where the value is created (https). */
  link?: string;
}

export interface McpCatalogLaunch {
  command: string;
  args: string[];
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  category: McpCatalogCategory;
  /** What it does, in Orka's words. */
  description: string;
  /** Made by the vendor of the product it connects to, or by someone else. */
  publisher: 'official' | 'community';
  /** Who publishes it (descriptive only). */
  vendor: string;
  /** SPDX id or a short phrase; undefined when the publisher states none. */
  license?: string;
  homepage: string;
  status?: 'experimental' | 'preview' | 'archived';
  transport: 'stdio' | 'http';
  /** stdio: the program and its arguments ({NAME} tokens are filled from arg fields). */
  launch?: McpCatalogLaunch;
  /** stdio: another program on some systems. */
  platformLaunch?: Partial<Record<McpCatalogPlatform, McpCatalogLaunch>>;
  /** http: the endpoint. */
  url?: string;
  fields: McpCatalogField[];
  /** What has to be on the machine first. */
  prerequisites: string[];
  /** A step in another program before the server can work (e.g. a Unity package), with its page. */
  setup?: { text: string; link: string };
  /** 'any': a hosted server, usable from every system. */
  platforms: McpCatalogPlatform[] | 'any';
  notes?: string[];
}

/** Programs a catalog entry may start: the package runners, plus binaries a publisher documents. */
export const CATALOG_RUNNERS: readonly string[] = ['npx', 'uvx', 'uv', 'docker', 'node', 'python'];

const ALL: McpCatalogPlatform[] = ['windows', 'macos', 'linux'];

// Shared help texts (each translated once).
const HOST = 'Server host name or address';
const PORT = 'Server port';
const USER = 'User name';
const PASSWORD = 'Password';
const DATABASE = 'Database name';
const NODE = 'Node.js';
const NODE18 = 'Node.js 18 or later';
const NODE20 = 'Node.js 20 or later';
const NODE24 = 'Node.js 24 or later';
const UV = 'uv (it provides uvx)';
const DOCKER = 'Docker';

const npx = (...args: string[]): McpCatalogLaunch => ({ command: 'npx', args });
const uvx = (...args: string[]): McpCatalogLaunch => ({ command: 'uvx', args });
const docker = (...args: string[]): McpCatalogLaunch => ({ command: 'docker', args });

function env(name: string, help: string, options: Partial<McpCatalogField> = {}): McpCatalogField {
  return { name, target: 'env', help, ...options };
}

function bearer(help: string, options: Partial<McpCatalogField> = {}): McpCatalogField {
  return { name: 'Authorization', target: 'header', template: 'Bearer {value}', secret: true, required: true, help, ...options };
}

function arg(name: string, help: string, options: Partial<McpCatalogField> = {}): McpCatalogField {
  return { name, target: 'arg', required: true, help, ...options };
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // ------------------------------------------------------------------ game development
  {
    id: 'mcp-for-unity',
    name: 'MCP for Unity',
    category: 'game-dev',
    description: 'Lets agents work in the Unity Editor through a package added to the project: scenes, GameObjects, scripts, assets, the console and tests.',
    publisher: 'community',
    vendor: 'CoplayDev',
    license: 'MIT',
    homepage: 'https://github.com/CoplayDev/unity-mcp',
    transport: 'http',
    url: 'http://localhost:8080/mcp',
    fields: [],
    prerequisites: ['Unity 2021.3 LTS or later', 'Python 3.10 or later and uv'],
    setup: {
      text: 'Unity: add the MCP for Unity package to your project first (Package Manager > Add package from git URL), then open Window > MCP for Unity in the Editor.',
      link: 'https://github.com/CoplayDev/unity-mcp',
    },
    platforms: ALL,
    notes: ['The Unity package runs the server on port 8080; Orka only connects to it.'],
  },
  {
    id: 'unreal-mcp',
    name: 'Unreal MCP',
    category: 'game-dev',
    description: "Unreal Editor's own plugin that offers editor tools over MCP.",
    publisher: 'official',
    vendor: 'Epic Games',
    license: 'Unreal Engine EULA',
    homepage: 'https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor',
    status: 'experimental',
    transport: 'http',
    url: 'http://127.0.0.1:8000/mcp',
    fields: [],
    prerequisites: ['Unreal Engine 5.8 or later'],
    setup: {
      text: "Unreal: enable the 'Unreal MCP' and 'All Toolsets' plugins, then restart the Editor.",
      link: 'https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor',
    },
    platforms: ALL,
    notes: ['The port and path are set in Editor Preferences > Model Context Protocol.'],
  },
  {
    id: 'unreal-engine-mcp',
    name: 'Unreal Engine MCP (EngineWire)',
    category: 'game-dev',
    description: 'A C++ plugin for Unreal Engine 5.0 to 5.8 with a Node server, for actors, assets, Blueprints and editor automation.',
    publisher: 'community',
    vendor: 'ChiR24',
    license: 'MIT',
    homepage: 'https://github.com/ChiR24/Unreal_mcp',
    transport: 'stdio',
    launch: npx('-y', 'unreal-engine-mcp-server'),
    fields: [
      env('UE_PROJECT_PATH', 'Your Unreal project folder or .uproject file', { required: true }),
      env('MCP_AUTOMATION_CAPABILITY_TOKEN', "The capability token from the project's Saved/MCP folder (optional)", { secret: true }),
    ],
    prerequisites: ['Unreal Engine 5.0 to 5.8', 'Node.js 20.19 or later'],
    setup: { text: 'Unreal: install the EngineWire plugin in your project first.', link: 'https://github.com/ChiR24/Unreal_mcp' },
    platforms: ALL,
  },
  {
    id: 'godot-mcp',
    name: 'Godot MCP',
    category: 'game-dev',
    description: 'Starts the Godot editor, runs the project, reads its debug output and edits scenes.',
    publisher: 'community',
    vendor: 'Coding-Solo',
    license: 'MIT',
    homepage: 'https://github.com/Coding-Solo/godot-mcp',
    transport: 'stdio',
    launch: npx('@coding-solo/godot-mcp'),
    fields: [env('GODOT_PATH', 'Path to the Godot program; found on its own when empty')],
    prerequisites: ['Godot', NODE18],
    platforms: ALL,
    notes: ['Maintained slowly: many pull requests are open.'],
  },
  {
    id: 'blender-mcp',
    name: 'Blender MCP',
    category: 'game-dev',
    description: 'Works in a running Blender through an add-on: reads the scene, runs Python and imports assets.',
    publisher: 'community',
    vendor: 'ahujasid',
    license: 'MIT',
    homepage: 'https://github.com/ahujasid/blender-mcp',
    transport: 'stdio',
    launch: uvx('mcp-for-blender'),
    fields: [
      env('DISABLE_TELEMETRY', 'true turns off the anonymous usage records this server sends by default', { default: 'true' }),
      env('BLENDER_MCP_SAFE_MODE', '1 checks scripts before they run'),
    ],
    prerequisites: ['Blender 3.0 or later', 'Python 3.10 or later and uv'],
    setup: { text: 'Blender: install the add-on (uvx mcp-for-blender install-addon) and enable it first.', link: 'https://github.com/ahujasid/blender-mcp' },
    platforms: ALL,
  },
  {
    id: 'roblox-studio',
    name: 'Roblox Studio MCP',
    category: 'game-dev',
    description: "Roblox Studio's built-in server for the data model, Luau scripts and play tests.",
    publisher: 'official',
    vendor: 'Roblox',
    license: 'Proprietary',
    homepage: 'https://create.roblox.com/docs/studio/mcp',
    transport: 'stdio',
    launch: { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'] },
    platformLaunch: { macos: { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] } },
    fields: [],
    prerequisites: ['Roblox Studio (latest)'],
    setup: { text: 'Roblox Studio: turn on Assistant > Manage MCP Servers > Enable Studio as MCP server first.', link: 'https://create.roblox.com/docs/studio/mcp' },
    platforms: ['windows', 'macos'],
  },
  {
    id: 'playcanvas-editor',
    name: 'PlayCanvas Editor MCP',
    category: 'game-dev',
    description: 'Lets agents build scenes in the PlayCanvas web editor.',
    publisher: 'official',
    vendor: 'PlayCanvas',
    license: 'MIT',
    homepage: 'https://github.com/playcanvas/editor-mcp-server',
    transport: 'stdio',
    launch: npx('-y', '@playcanvas/editor-mcp-server'),
    fields: [],
    prerequisites: ['Node.js 22.18 or later'],
    setup: { text: 'PlayCanvas: open the Editor in Chrome, click its MCP button, then CONNECT.', link: 'https://github.com/playcanvas/editor-mcp-server' },
    platforms: ALL,
    notes: ['Use one server per agent.'],
  },

  // ------------------------------------------------------------------ browser
  {
    id: 'playwright',
    name: 'Playwright MCP',
    category: 'browser',
    description: 'Drives a browser from its accessibility tree: open pages, click, fill in forms and take screenshots.',
    publisher: 'official',
    vendor: 'Microsoft',
    license: 'Apache-2.0',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    transport: 'stdio',
    launch: npx('-y', '@playwright/mcp@latest'),
    fields: [],
    prerequisites: [NODE18],
    platforms: ALL,
    notes: ['Opens a visible browser window by default.'],
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools MCP',
    category: 'browser',
    description: 'Controls and inspects a live Chrome: performance traces, network, console, DOM and screenshots.',
    publisher: 'official',
    vendor: 'Google',
    license: 'Apache-2.0',
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    transport: 'stdio',
    launch: npx('-y', 'chrome-devtools-mcp@latest', '--no-usage-statistics', '--no-performance-crux'),
    fields: [],
    prerequisites: ['Node.js (LTS)', 'Google Chrome'],
    platforms: ALL,
    notes: ['Orka adds --no-usage-statistics and --no-performance-crux, so the server sends no usage statistics and no page addresses to Google.'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer (reference)',
    category: 'browser',
    description: 'The original reference server for browser automation with Puppeteer.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers-archived',
    status: 'archived',
    transport: 'stdio',
    launch: npx('-y', '@modelcontextprotocol/server-puppeteer'),
    fields: [],
    prerequisites: [NODE],
    platforms: ALL,
    notes: ['Archived and no longer maintained: prefer Playwright MCP or Chrome DevTools MCP.'],
  },

  // ------------------------------------------------------------------ source control
  {
    id: 'github',
    name: 'GitHub MCP (remote)',
    category: 'source-control',
    description: "GitHub's hosted server for repositories, issues, pull requests, Actions and code security.",
    publisher: 'official',
    vendor: 'GitHub',
    license: 'MIT',
    homepage: 'https://github.com/github/github-mcp-server',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    fields: [bearer('A GitHub personal access token', { link: 'https://github.com/settings/personal-access-tokens' })],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'github-docker',
    name: 'GitHub MCP (Docker)',
    category: 'source-control',
    description: 'The same GitHub server, run on this computer in Docker; also works with GitHub Enterprise.',
    publisher: 'official',
    vendor: 'GitHub',
    license: 'MIT',
    homepage: 'https://github.com/github/github-mcp-server',
    transport: 'stdio',
    launch: docker('run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'),
    fields: [env('GITHUB_PERSONAL_ACCESS_TOKEN', 'A GitHub personal access token', { secret: true, required: true, link: 'https://github.com/settings/personal-access-tokens' })],
    prerequisites: [DOCKER],
    platforms: ALL,
  },
  {
    id: 'gitlab',
    name: 'GitLab MCP',
    category: 'source-control',
    description: "GitLab's built-in server for issues, merge requests, pipelines and more.",
    publisher: 'official',
    vendor: 'GitLab',
    license: 'MIT (CE) / proprietary (EE)',
    homepage: 'https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/',
    transport: 'http',
    url: 'https://gitlab.com/api/v4/mcp',
    fields: [bearer('A fine-grained GitLab access token with the MCP permission')],
    prerequisites: ['An administrator must allow MCP for your group or instance'],
    platforms: 'any',
    notes: ['For a self-managed GitLab, change the address in the list to your host’s /api/v4/mcp.'],
  },
  {
    id: 'git',
    name: 'Git (reference)',
    category: 'source-control',
    description: 'Reads, searches and changes a local Git repository: status, diff, log, commit and branches.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    transport: 'stdio',
    launch: uvx('mcp-server-git', '--repository', '{REPOSITORY}'),
    fields: [arg('REPOSITORY', 'The repository folder the server may use')],
    prerequisites: [UV],
    platforms: ALL,
  },
  {
    id: 'azure-devops',
    name: 'Azure DevOps MCP',
    category: 'source-control',
    description: 'Work items, repositories, pull requests, pipelines and wikis in Azure DevOps.',
    publisher: 'official',
    vendor: 'Microsoft',
    license: 'MIT',
    homepage: 'https://github.com/microsoft/azure-devops-mcp',
    transport: 'stdio',
    launch: npx('-y', '@azure-devops/mcp', '{ORGANIZATION}'),
    fields: [arg('ORGANIZATION', 'Your Azure DevOps organization name')],
    prerequisites: [NODE20],
    platforms: ALL,
    notes: ['Signs in through your browser on first use.'],
  },

  // ------------------------------------------------------------------ issues
  {
    id: 'sentry',
    name: 'Sentry MCP',
    category: 'issues',
    description: 'Looks up Sentry issues, events, traces and releases.',
    publisher: 'official',
    vendor: 'Sentry',
    homepage: 'https://github.com/getsentry/sentry-mcp',
    transport: 'stdio',
    launch: npx('@sentry/mcp-server@latest'),
    fields: [
      env('SENTRY_AUTH_TOKEN', 'A Sentry user auth token', { secret: true, required: true }),
      env('SENTRY_HOST', 'Host name of a self-hosted Sentry (optional)'),
    ],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'linear',
    name: 'Linear MCP',
    category: 'issues',
    description: 'Finds, creates and updates Linear issues, projects and comments.',
    publisher: 'official',
    vendor: 'Linear',
    license: 'Proprietary (hosted)',
    homepage: 'https://linear.app/docs/mcp',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    fields: [bearer('A Linear API key (Settings > API)')],
    prerequisites: [],
    platforms: 'any',
  },

  // ------------------------------------------------------------------ databases
  {
    id: 'postgres-mcp-pro',
    name: 'Postgres MCP Pro',
    category: 'databases',
    description: 'PostgreSQL with schema browsing, safe SQL, health checks and index tuning.',
    publisher: 'community',
    vendor: 'Crystal DBA',
    license: 'MIT',
    homepage: 'https://github.com/crystaldba/postgres-mcp',
    transport: 'stdio',
    launch: uvx('postgres-mcp', '--access-mode=restricted'),
    fields: [env('DATABASE_URI', 'Connection string: postgresql://user:password@host:5432/database', { secret: true, required: true })],
    prerequisites: ['Python 3.12 or later and uv'],
    platforms: ALL,
    notes: ['Starts read-only (restricted); --access-mode=unrestricted allows writes.'],
  },
  {
    id: 'toolbox-postgres',
    name: 'MCP Toolbox for Databases: PostgreSQL',
    category: 'databases',
    description: "Google's database toolbox with ready-made PostgreSQL tools.",
    publisher: 'official',
    vendor: 'Google',
    license: 'Apache-2.0',
    homepage: 'https://github.com/googleapis/mcp-toolbox',
    transport: 'stdio',
    launch: npx('-y', '@toolbox-sdk/server', '--prebuilt=postgres', '--stdio'),
    fields: [
      env('POSTGRES_HOST', HOST),
      env('POSTGRES_PORT', PORT),
      env('POSTGRES_DATABASE', DATABASE, { required: true }),
      env('POSTGRES_USER', USER, { required: true }),
      env('POSTGRES_PASSWORD', PASSWORD, { secret: true, required: true }),
    ],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'toolbox-mysql',
    name: 'MCP Toolbox for Databases: MySQL',
    category: 'databases',
    description: "Google's database toolbox with ready-made MySQL tools.",
    publisher: 'official',
    vendor: 'Google',
    license: 'Apache-2.0',
    homepage: 'https://mcp-toolbox.dev/integrations/mysql/prebuilt-configs/mysql/',
    transport: 'stdio',
    launch: npx('-y', '@toolbox-sdk/server', '--prebuilt=mysql', '--stdio'),
    fields: [
      env('MYSQL_HOST', HOST, { required: true }),
      env('MYSQL_PORT', PORT, { required: true, default: '3306' }),
      env('MYSQL_DATABASE', DATABASE, { required: true }),
      env('MYSQL_USER', USER, { required: true }),
      env('MYSQL_PASSWORD', PASSWORD, { secret: true, required: true }),
    ],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'toolbox-sqlite',
    name: 'MCP Toolbox for Databases: SQLite',
    category: 'databases',
    description: 'Queries and inspects a local SQLite file.',
    publisher: 'official',
    vendor: 'Google',
    license: 'Apache-2.0',
    homepage: 'https://mcp-toolbox.dev/integrations/sqlite/prebuilt-configs/sqlite/',
    transport: 'stdio',
    launch: npx('-y', '@toolbox-sdk/server', '--prebuilt=sqlite', '--stdio'),
    fields: [env('SQLITE_DATABASE', 'Path to the .db file', { required: true })],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'mysql',
    name: 'MySQL MCP',
    category: 'databases',
    description: 'MySQL queries and schema inspection, read-only unless you allow writes.',
    publisher: 'community',
    vendor: 'benborla',
    license: 'MIT',
    homepage: 'https://github.com/benborla/mcp-server-mysql',
    transport: 'stdio',
    launch: npx('-y', '@benborla29/mcp-server-mysql'),
    fields: [
      env('MYSQL_HOST', HOST, { required: true }),
      env('MYSQL_PORT', PORT, { default: '3306' }),
      env('MYSQL_USER', USER, { required: true }),
      env('MYSQL_PASS', PASSWORD, { secret: true, required: true }),
      env('MYSQL_DB', DATABASE),
    ],
    prerequisites: [NODE20, 'MySQL 5.7 or later'],
    platforms: ALL,
    notes: ['Writes stay off unless you add ALLOW_INSERT_OPERATION (or the UPDATE and DELETE variants) to its environment.'],
  },
  {
    id: 'mongodb',
    name: 'MongoDB MCP',
    category: 'databases',
    description: 'MongoDB and Atlas: query collections, inspect schemas and manage Atlas clusters.',
    publisher: 'official',
    vendor: 'MongoDB',
    license: 'Apache-2.0',
    homepage: 'https://github.com/mongodb-js/mongodb-mcp-server',
    transport: 'stdio',
    launch: npx('-y', 'mongodb-mcp-server@latest', '--readOnly'),
    fields: [
      env('MDB_MCP_CONNECTION_STRING', 'A mongodb:// or mongodb+srv:// connection string', { secret: true }),
      env('MDB_MCP_API_CLIENT_ID', 'Atlas service account client ID (for the Atlas tools)'),
      env('MDB_MCP_API_CLIENT_SECRET', 'Atlas service account secret', { secret: true }),
    ],
    prerequisites: ['Node.js 22.13 or later'],
    platforms: ALL,
    notes: ['Starts read-only (--readOnly).'],
  },
  {
    id: 'redis',
    name: 'Redis MCP',
    category: 'databases',
    description: 'Works with Redis data structures, search and streams.',
    publisher: 'official',
    vendor: 'Redis',
    license: 'MIT',
    homepage: 'https://github.com/redis/mcp-redis',
    transport: 'stdio',
    launch: uvx('--from', 'redis-mcp-server@latest', 'redis-mcp-server'),
    fields: [
      env('REDIS_HOST', HOST, { default: 'localhost' }),
      env('REDIS_PORT', PORT, { default: '6379' }),
      env('REDIS_USERNAME', USER),
      env('REDIS_PWD', PASSWORD, { secret: true }),
      env('REDIS_SSL', 'True for a TLS connection'),
    ],
    prerequisites: [UV, 'A Redis server you can reach'],
    platforms: ALL,
  },
  {
    id: 'supabase',
    name: 'Supabase MCP',
    category: 'databases',
    description: 'Supabase projects: SQL, migrations, edge functions, logs and docs.',
    publisher: 'official',
    vendor: 'Supabase',
    license: 'Apache-2.0',
    homepage: 'https://supabase.com/docs/guides/getting-started/mcp',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp?read_only=true',
    fields: [bearer('A Supabase personal access token (Dashboard > Access Tokens)')],
    prerequisites: [],
    platforms: 'any',
    notes: ['Read-only: read_only=true is part of the address.'],
  },
  {
    id: 'firebase',
    name: 'Firebase MCP',
    category: 'databases',
    description: 'Firebase projects, Auth, Firestore, Storage and Rules through the Firebase CLI.',
    publisher: 'official',
    vendor: 'Google',
    license: 'MIT',
    homepage: 'https://firebase.google.com/docs/ai-assistance/mcp-server',
    transport: 'stdio',
    launch: npx('-y', 'firebase-tools@latest', 'mcp'),
    fields: [],
    prerequisites: [NODE, 'Signed in with the Firebase CLI (firebase login)'],
    platforms: ALL,
  },
  {
    id: 'neon',
    name: 'Neon MCP',
    category: 'databases',
    description: 'Neon serverless Postgres: projects, branches, SQL and migrations.',
    publisher: 'official',
    vendor: 'Neon',
    homepage: 'https://neon.com/docs/ai/neon-mcp-server',
    transport: 'http',
    url: 'https://mcp.neon.tech/mcp',
    fields: [bearer('A Neon API key (Console > API keys)')],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse MCP',
    category: 'databases',
    description: 'Read-only SQL over ClickHouse.',
    publisher: 'official',
    vendor: 'ClickHouse',
    license: 'Apache-2.0',
    homepage: 'https://github.com/ClickHouse/mcp-clickhouse',
    transport: 'stdio',
    launch: { command: 'uv', args: ['run', '--with', 'mcp-clickhouse', '--python', '3.12', 'mcp-clickhouse'] },
    fields: [
      env('CLICKHOUSE_HOST', HOST, { required: true }),
      env('CLICKHOUSE_USER', USER, { required: true }),
      env('CLICKHOUSE_PASSWORD', PASSWORD, { secret: true, required: true }),
      env('CLICKHOUSE_PORT', 'Server port (8443 with TLS, otherwise 8123)'),
      env('CLICKHOUSE_SECURE', 'false turns TLS off (on by default)'),
    ],
    prerequisites: ['uv'],
    platforms: ALL,
    notes: ['Writes stay off unless CLICKHOUSE_ALLOW_WRITE_ACCESS=true is in its environment.'],
  },
  {
    id: 'duckdb',
    name: 'DuckDB / MotherDuck MCP',
    category: 'databases',
    description: 'SQL over a local DuckDB file, in-memory DuckDB, S3 or MotherDuck.',
    publisher: 'official',
    vendor: 'MotherDuck',
    license: 'MIT',
    homepage: 'https://github.com/motherduckdb/mcp-server-motherduck',
    transport: 'stdio',
    launch: uvx('mcp-server-motherduck', '--db-path', '{DB_PATH}'),
    fields: [
      arg('DB_PATH', 'Full path of a .duckdb file, :memory:, md: or s3://', { default: ':memory:' }),
      env('motherduck_token', 'A MotherDuck token, only for md: databases', { secret: true }),
    ],
    prerequisites: [UV],
    platforms: ALL,
    notes: ['Read-only unless you add --read-write.'],
  },
  {
    id: 'qdrant',
    name: 'Qdrant MCP',
    category: 'databases',
    description: 'Semantic memory kept in a Qdrant vector database.',
    publisher: 'official',
    vendor: 'Qdrant',
    license: 'Apache-2.0',
    homepage: 'https://github.com/qdrant/mcp-server-qdrant',
    transport: 'stdio',
    launch: uvx('mcp-server-qdrant'),
    fields: [
      env('QDRANT_URL', 'Address of the Qdrant server', { required: true, default: 'http://localhost:6333' }),
      env('QDRANT_API_KEY', 'A Qdrant Cloud API key (optional)', { secret: true }),
      env('COLLECTION_NAME', 'The collection to use', { required: true }),
      env('EMBEDDING_MODEL', 'Embedding model (optional)'),
    ],
    prerequisites: [UV, 'A Qdrant server'],
    platforms: ALL,
  },

  // ------------------------------------------------------------------ cloud
  {
    id: 'aws',
    name: 'AWS MCP Server',
    category: 'cloud',
    description: 'AWS API calls, AWS docs and guided workflows through a hosted AWS server and a local signing proxy.',
    publisher: 'official',
    vendor: 'AWS',
    license: 'Apache-2.0',
    homepage: 'https://github.com/awslabs/mcp',
    status: 'preview',
    transport: 'stdio',
    launch: uvx('mcp-proxy-for-aws@latest', 'https://aws-mcp.us-east-1.api.aws/mcp'),
    fields: [env('AWS_PROFILE', 'Profile from your AWS config (optional)'), env('AWS_REGION', 'AWS region (optional)')],
    prerequisites: [UV, 'AWS credentials on this computer'],
    platforms: ALL,
  },
  {
    id: 'aws-knowledge',
    name: 'AWS Knowledge MCP',
    category: 'cloud',
    description: "Searches AWS documentation, blogs, What's New posts and regional availability.",
    publisher: 'official',
    vendor: 'AWS',
    license: 'Apache-2.0',
    homepage: 'https://github.com/awslabs/mcp',
    transport: 'http',
    url: 'https://knowledge-mcp.global.api.aws',
    fields: [],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'azure',
    name: 'Azure MCP Server',
    category: 'cloud',
    description: 'Azure services in one server: storage, Cosmos DB, AKS, Key Vault, monitoring and more.',
    publisher: 'official',
    vendor: 'Microsoft',
    license: 'MIT',
    homepage: 'https://github.com/microsoft/mcp/tree/main/servers/Azure.Mcp.Server',
    transport: 'stdio',
    launch: npx('-y', '@azure/mcp@latest', 'server', 'start'),
    fields: [],
    prerequisites: ['Node.js (LTS)', 'Signed in with the Azure CLI (az login)'],
    platforms: ALL,
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare API MCP',
    category: 'cloud',
    description: 'The Cloudflare API and developer docs: Workers, R2, D1, DNS and more.',
    publisher: 'official',
    vendor: 'Cloudflare',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    transport: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
    fields: [bearer('A Cloudflare API token')],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'docker-mcp-gateway',
    name: 'Docker MCP Gateway',
    category: 'cloud',
    description: "Runs servers from Docker's MCP catalog in containers behind one gateway.",
    publisher: 'official',
    vendor: 'Docker',
    license: 'MIT',
    homepage: 'https://github.com/docker/mcp-gateway',
    transport: 'stdio',
    launch: docker('mcp', 'gateway', 'run'),
    fields: [],
    prerequisites: ['Docker Desktop 4.59 or later with MCP Toolkit turned on'],
    platforms: ALL,
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes MCP',
    category: 'cloud',
    description: 'Kubernetes and OpenShift resources, pods, logs and Helm, with your kubeconfig.',
    publisher: 'community',
    vendor: 'containers (Red Hat)',
    license: 'Apache-2.0',
    homepage: 'https://github.com/containers/kubernetes-mcp-server',
    transport: 'stdio',
    launch: npx('-y', 'kubernetes-mcp-server@latest'),
    fields: [],
    prerequisites: [NODE, 'A kubeconfig with access to your cluster'],
    platforms: ALL,
    notes: ['It can do whatever your kubeconfig allows; rely on RBAC for real limits.'],
  },
  {
    id: 'terraform',
    name: 'Terraform MCP',
    category: 'cloud',
    description: 'Terraform Registry providers and modules, and HCP Terraform or Terraform Enterprise workspaces.',
    publisher: 'official',
    vendor: 'HashiCorp',
    license: 'MPL-2.0',
    homepage: 'https://github.com/hashicorp/terraform-mcp-server',
    transport: 'stdio',
    launch: docker('run', '-i', '--rm', '-e', 'TFE_TOKEN', '-e', 'TFE_ADDRESS', 'hashicorp/terraform-mcp-server'),
    fields: [
      env('TFE_TOKEN', 'An HCP Terraform token (optional)', { secret: true }),
      env('TFE_ADDRESS', 'HCP Terraform or Terraform Enterprise address (optional)'),
    ],
    prerequisites: [DOCKER],
    platforms: ALL,
    notes: ['Registry tools work without a token.'],
  },

  // ------------------------------------------------------------------ design
  {
    id: 'figma-desktop',
    name: 'Figma Dev Mode MCP (desktop)',
    category: 'design',
    description: 'A server inside the Figma desktop app that works on the current selection.',
    publisher: 'official',
    vendor: 'Figma',
    license: 'Proprietary',
    homepage: 'https://developers.figma.com/docs/figma-mcp-server/local-server-installation/',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    fields: [],
    prerequisites: ['Figma desktop app with a Dev or Full seat on a paid plan'],
    setup: { text: 'Figma: turn on Dev Mode > Enable desktop MCP server in the desktop app first.', link: 'https://developers.figma.com/docs/figma-mcp-server/local-server-installation/' },
    platforms: ['windows', 'macos'],
  },
  {
    id: 'storybook',
    name: 'Storybook MCP',
    category: 'design',
    description: "Shows agents a project's components and stories from the running Storybook.",
    publisher: 'official',
    vendor: 'Storybook',
    license: 'MIT',
    homepage: 'https://github.com/storybookjs/mcp',
    transport: 'http',
    url: 'http://localhost:6006/mcp',
    fields: [],
    prerequisites: [],
    setup: { text: 'Storybook: install @storybook/addon-mcp in your project and start Storybook first.', link: 'https://github.com/storybookjs/mcp' },
    platforms: ALL,
    notes: ['The address follows the Storybook port.'],
  },

  // ------------------------------------------------------------------ docs and search
  {
    id: 'context7',
    name: 'Context7',
    category: 'docs-search',
    description: 'Current, version-specific library documentation and code examples.',
    publisher: 'official',
    vendor: 'Upstash',
    license: 'MIT',
    homepage: 'https://github.com/upstash/context7',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    fields: [bearer('A Context7 API key (optional; raises the rate limits)', { required: false, link: 'https://context7.com/dashboard' })],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'docs-search',
    description: 'Answers questions about public GitHub repositories from generated wiki pages.',
    publisher: 'official',
    vendor: 'Cognition',
    license: 'Proprietary (hosted)',
    homepage: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    transport: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    fields: [],
    prerequisites: [],
    platforms: 'any',
    notes: ['Free, no sign-in; public repositories only.'],
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn MCP',
    category: 'docs-search',
    description: 'Searches and reads official Microsoft and Azure documentation and code samples.',
    publisher: 'official',
    vendor: 'Microsoft',
    license: 'Proprietary (hosted)',
    homepage: 'https://learn.microsoft.com/en-us/training/support/mcp',
    transport: 'http',
    url: 'https://learn.microsoft.com/api/mcp',
    fields: [],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'docs-search',
    description: 'Web, news, image, video and local search with the Brave Search API.',
    publisher: 'official',
    vendor: 'Brave',
    license: 'MIT',
    homepage: 'https://github.com/brave/brave-search-mcp-server',
    transport: 'stdio',
    launch: npx('-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'),
    fields: [env('BRAVE_API_KEY', 'A Brave Search API key', { secret: true, required: true, link: 'https://api-dashboard.search.brave.com/app/keys' })],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'exa',
    name: 'Exa Search',
    category: 'docs-search',
    description: 'Neural web search, code search and page crawling.',
    publisher: 'official',
    vendor: 'Exa',
    license: 'MIT',
    homepage: 'https://github.com/exa-labs/exa-mcp-server',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    fields: [{ name: 'x-api-key', target: 'header', secret: true, help: 'An Exa API key (optional; without one, rate limits apply)', link: 'https://dashboard.exa.ai/api-keys' }],
    prerequisites: [],
    platforms: 'any',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    category: 'docs-search',
    description: 'Search, extract, map and crawl, tuned for agents.',
    publisher: 'official',
    vendor: 'Tavily',
    license: 'MIT',
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
    transport: 'stdio',
    launch: npx('-y', 'tavily-mcp@latest'),
    fields: [env('TAVILY_API_KEY', 'A Tavily API key (free tier available)', { secret: true, required: true, link: 'https://app.tavily.com' })],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'docs-search',
    description: 'Scrapes, crawls and searches websites and pulls structured data out of them.',
    publisher: 'official',
    vendor: 'Firecrawl',
    license: 'MIT',
    homepage: 'https://github.com/firecrawl/firecrawl-mcp-server',
    transport: 'stdio',
    launch: npx('-y', 'firecrawl-mcp'),
    fields: [env('FIRECRAWL_API_KEY', 'A Firecrawl API key', { secret: true, required: true, link: 'https://firecrawl.dev/app/api-keys' })],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'fetch',
    name: 'Fetch (reference)',
    category: 'docs-search',
    description: 'Fetches a web page and turns it into Markdown.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    transport: 'stdio',
    launch: uvx('mcp-server-fetch'),
    fields: [],
    prerequisites: [UV],
    platforms: ALL,
    notes: ['Private and local addresses are blocked unless you add --allow-private-ips.'],
  },

  // ------------------------------------------------------------------ files and system
  {
    id: 'filesystem',
    name: 'Filesystem (reference)',
    category: 'files-system',
    description: 'Reads, writes and searches files inside the folder you allow.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    transport: 'stdio',
    launch: npx('-y', '@modelcontextprotocol/server-filesystem', '{ALLOWED_DIR}'),
    fields: [arg('ALLOWED_DIR', 'The folder the server may read and write')],
    prerequisites: [NODE24],
    platforms: ALL,
  },
  {
    id: 'desktop-commander',
    name: 'Desktop Commander',
    category: 'files-system',
    description: 'Terminal commands, process control, file editing and search on this computer.',
    publisher: 'community',
    vendor: 'wonderwhy-er',
    license: 'MIT',
    homepage: 'https://github.com/wonderwhy-er/DesktopCommanderMCP',
    transport: 'stdio',
    launch: npx('-y', '@wonderwhy-er/desktop-commander@latest'),
    fields: [],
    prerequisites: [NODE],
    platforms: ALL,
    notes: ['Runs any shell command an agent asks for.', 'Sends telemetry by default; turn it off in its own settings (telemetryEnabled).'],
  },

  // ------------------------------------------------------------------ AI tools
  {
    id: 'memory',
    name: 'Memory (reference)',
    category: 'ai-tools',
    description: 'A knowledge-graph memory that lasts between sessions, kept in a JSONL file.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    transport: 'stdio',
    launch: npx('-y', '@modelcontextprotocol/server-memory'),
    fields: [env('MEMORY_FILE_PATH', 'Full path of the memory .jsonl file (its folder must exist)', { required: true })],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking (reference)',
    category: 'ai-tools',
    description: 'A tool for step-by-step reasoning that can revise earlier steps.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    transport: 'stdio',
    launch: npx('-y', '@modelcontextprotocol/server-sequential-thinking'),
    fields: [],
    prerequisites: [NODE24],
    platforms: ALL,
  },

  // ------------------------------------------------------------------ productivity
  {
    id: 'obsidian',
    name: 'Obsidian',
    category: 'productivity',
    description: 'Reads, searches and edits notes in an Obsidian vault.',
    publisher: 'community',
    vendor: 'MarkusPfundstein',
    license: 'MIT',
    homepage: 'https://github.com/MarkusPfundstein/mcp-obsidian',
    transport: 'stdio',
    launch: uvx('mcp-obsidian'),
    fields: [
      env('OBSIDIAN_API_KEY', "The key from the Local REST API plugin's settings", { secret: true, required: true }),
      env('OBSIDIAN_HOST', HOST),
      env('OBSIDIAN_PORT', PORT),
    ],
    prerequisites: [UV],
    setup: { text: 'Obsidian: install and enable the Local REST API community plugin first.', link: 'https://github.com/MarkusPfundstein/mcp-obsidian' },
    platforms: ALL,
    notes: ['Maintained slowly: many issues are open.'],
  },

  // ------------------------------------------------------------------ other
  {
    id: 'time',
    name: 'Time (reference)',
    category: 'other',
    description: 'The current time and time zone conversion.',
    publisher: 'community',
    vendor: 'MCP steering group',
    license: 'MIT',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    transport: 'stdio',
    launch: uvx('mcp-server-time'),
    fields: [],
    prerequisites: [UV],
    platforms: ALL,
  },
  {
    id: 'stripe',
    name: 'Stripe MCP',
    category: 'other',
    description: 'Stripe API reads and writes, docs search and an integration planner.',
    publisher: 'official',
    vendor: 'Stripe',
    license: 'Proprietary (hosted)',
    homepage: 'https://docs.stripe.com/mcp',
    transport: 'http',
    url: 'https://mcp.stripe.com',
    fields: [bearer('A Stripe agent key (Dashboard > API keys > Agent keys); use a sandbox')],
    prerequisites: [],
    platforms: 'any',
    notes: ['From December 2026, plain secret keys are rejected; use an agent key.'],
  },
  {
    id: 'grafana',
    name: 'Grafana MCP',
    category: 'other',
    description: 'Dashboards, Prometheus and Loki queries, alerts, incidents and OnCall.',
    publisher: 'official',
    vendor: 'Grafana Labs',
    license: 'Apache-2.0',
    homepage: 'https://github.com/grafana/mcp-grafana',
    transport: 'stdio',
    launch: uvx('mcp-grafana'),
    fields: [
      env('GRAFANA_URL', 'Address of your Grafana', { required: true }),
      env('GRAFANA_SERVICE_ACCOUNT_TOKEN', 'A Grafana service account token', { secret: true, required: true }),
    ],
    prerequisites: [UV, 'Grafana 9.0 or later'],
    platforms: ALL,
  },
  {
    id: 'sonarqube',
    name: 'SonarQube MCP',
    category: 'other',
    description: 'Code quality and security issues, quality gates and snippet analysis from SonarQube Cloud.',
    publisher: 'official',
    vendor: 'SonarSource',
    license: 'SSAL-1.0 (source-available)',
    homepage: 'https://github.com/SonarSource/sonarqube-mcp-server',
    transport: 'stdio',
    launch: docker('run', '--init', '--pull=always', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_ORG', 'sonarsource/sonarqube-mcp'),
    fields: [
      env('SONARQUBE_TOKEN', 'A SonarQube user token (My Account > Security)', { secret: true, required: true }),
      env('SONARQUBE_ORG', 'Your SonarQube Cloud organization'),
    ],
    prerequisites: [DOCKER],
    platforms: ALL,
    notes: ['--pull=always: Docker checks for a newer image on every start.'],
  },
  {
    id: 'postman',
    name: 'Postman MCP',
    category: 'other',
    description: 'Postman collections, environments, workspaces and API specs.',
    publisher: 'official',
    vendor: 'Postman',
    license: 'Apache-2.0',
    homepage: 'https://github.com/postmanlabs/postman-mcp-server',
    transport: 'stdio',
    launch: npx('@postman/postman-mcp-server'),
    fields: [env('POSTMAN_API_KEY', 'A Postman API key (Settings > API keys)', { secret: true, required: true })],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'next-devtools',
    name: 'Next.js DevTools MCP',
    category: 'other',
    description: 'Next.js docs, diagnostics from a running dev server and upgrade helpers.',
    publisher: 'official',
    vendor: 'Vercel',
    license: 'MIT',
    homepage: 'https://github.com/vercel/next-devtools-mcp',
    transport: 'stdio',
    launch: npx('-y', 'next-devtools-mcp@latest'),
    fields: [],
    prerequisites: ['Node.js 20.19 or later'],
    platforms: ALL,
  },
  {
    id: 'angular-cli',
    name: 'Angular CLI MCP',
    category: 'other',
    description: 'Angular best practices, docs search, examples and workspace information.',
    publisher: 'official',
    vendor: 'Google',
    license: 'MIT',
    homepage: 'https://angular.dev/ai/mcp',
    transport: 'stdio',
    launch: npx('-y', '@angular/cli', 'mcp'),
    fields: [],
    prerequisites: [NODE],
    platforms: ALL,
  },
  {
    id: 'mobile-mcp',
    name: 'Mobile MCP',
    category: 'other',
    description: 'Automates iOS and Android simulators, emulators and real devices.',
    publisher: 'community',
    vendor: 'mobile-next',
    license: 'Apache-2.0',
    homepage: 'https://github.com/mobile-next/mobile-mcp',
    transport: 'stdio',
    launch: npx('-y', '@mobilenext/mobile-mcp@latest'),
    fields: [],
    prerequisites: [NODE20, 'adb (Android SDK) or the Xcode command line tools'],
    platforms: ALL,
    notes: ['iOS devices need macOS.'],
  },
  {
    id: 'appium',
    name: 'Appium MCP',
    category: 'other',
    description: 'Mobile app test automation with Appium.',
    publisher: 'official',
    vendor: 'Appium project',
    license: 'Apache-2.0',
    homepage: 'https://github.com/appium/appium-mcp',
    transport: 'stdio',
    launch: npx('-y', 'appium-mcp@latest'),
    fields: [env('ANDROID_HOME', 'Android SDK folder (optional)')],
    prerequisites: ['Node.js 22 or later', 'JDK 8 or later', 'Android SDK or Xcode'],
    platforms: ALL,
  },
];

// ------------------------------------------------------------------ helpers

export function catalogEntry(id: unknown): McpCatalogEntry | undefined {
  return typeof id === 'string' ? MCP_CATALOG.find((e) => e.id === id) : undefined;
}

export function catalogPlatform(platform: string): McpCatalogPlatform | undefined {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : undefined;
}

/** The entry can be used on this system. */
export function catalogAvailable(entry: McpCatalogEntry, platform: string): boolean {
  if (entry.platforms === 'any') return true;
  const p = catalogPlatform(platform);
  return !!p && entry.platforms.includes(p);
}

/** The program a stdio entry starts on this system. */
export function catalogLaunch(entry: McpCatalogEntry, platform: string): McpCatalogLaunch | undefined {
  const p = catalogPlatform(platform);
  return (p && entry.platformLaunch?.[p]) || entry.launch;
}

/** The longest value a field takes. */
const MAX_VALUE = 4096;

/** A value with no control characters (no line breaks into an env file or a header). */
function cleanValue(value: string): boolean {
  if (value.length > MAX_VALUE) return false;
  for (const c of value) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export type CatalogBuild = { ok: true; config: McpServerConfig } | { ok: false; missing: string[]; invalid: string[] };

/**
 * The server configuration for an entry and what the user entered. Fields left empty are left out
 * (a required one makes it fail); keys that are not fields of the entry are ignored, so a message
 * can never add a variable, header or argument of its own.
 */
export function buildCatalogServer(entry: McpCatalogEntry, values: Readonly<Record<string, unknown>>, platform: string): CatalogBuild {
  const missing: string[] = [];
  const invalid: string[] = [];
  const filled = new Map<string, string>();
  for (const field of entry.fields) {
    const raw = values[field.name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (field.required || field.target === 'arg') missing.push(field.name);
      continue;
    }
    if (!cleanValue(value)) invalid.push(field.name);
    else filled.set(field.name, value);
  }
  if (missing.length || invalid.length) return { ok: false, missing, invalid };
  const pick = (target: McpCatalogField['target']) =>
    entry.fields.filter((f) => f.target === target && filled.has(f.name)).map((f) => [f.name, (f.template ?? '{value}').replace('{value}', () => filled.get(f.name)!)] as const);
  if (entry.transport === 'http') {
    const headers = Object.fromEntries(pick('header'));
    return { ok: true, config: { url: entry.url!, ...(Object.keys(headers).length ? { headers } : {}) } };
  }
  const launch = catalogLaunch(entry, platform)!;
  const args = launch.args.map((a) => a.replace(/\{([A-Za-z_][\w]*)\}/g, (match, name: string) => filled.get(name) ?? match));
  const envVars = Object.fromEntries(pick('env'));
  return { ok: true, config: { command: launch.command, args, ...(Object.keys(envVars).length ? { env: envVars } : {}) } };
}

/** One argument as a shell would need it to read back the same (for showing only). */
function shown(arg: string): string {
  return arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** The command line or URL a configuration runs, for the user to read (never with env or header values). */
export function catalogCommandLine(config: McpServerConfig): string {
  return 'url' in config ? config.url : [config.command, ...(config.args ?? [])].map(shown).join(' ');
}

/** The command line or URL an entry runs on this system, arguments still as {NAME} tokens. */
export function catalogTarget(entry: McpCatalogEntry, platform: string): string {
  if (entry.transport === 'http') return entry.url ?? '';
  const launch = catalogLaunch(entry, platform);
  return launch ? [launch.command, ...launch.args].map(shown).join(' ') : '';
}

/** The package or image an entry's runner fetches (its first argument that is not a flag), if any. */
function packageOf(launch: McpCatalogLaunch | { command: string; args?: string[] }): string | undefined {
  const args = launch.args ?? [];
  const base = launch.command.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
  if (base === 'npx' || base === 'uvx') {
    const from = args.indexOf('--from');
    if (from >= 0 && args[from + 1]) return `${base}:${stripVersion(args[from + 1])}`;
    const first = args.find((a) => !a.startsWith('-'));
    return first ? `${base}:${stripVersion(first)}` : undefined;
  }
  if (base === 'docker') {
    if (args[0] === 'run') {
      // The image: the first plain word after "run" that does not follow a flag taking a value.
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '-e' || args[i] === '-p') i++;
        else if (!args[i].startsWith('-')) return `docker:${args[i]}`;
      }
      return undefined;
    }
    return `docker:${args.slice(0, 2).join(' ')}`;
  }
  return undefined;
}

/** "@playwright/mcp@latest" -> "@playwright/mcp"; "redis-mcp-server@1.2" -> "redis-mcp-server". */
function stripVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return (at > 0 ? spec.slice(0, at) : spec).toLowerCase();
}

/**
 * The catalog entry a configured server came from: the same URL, or the same package (with the
 * options that pick one of several entries of one package, such as --prebuilt=mysql). A name
 * alone is not enough: a hand-made "mysql" server that runs another package is not the catalog's.
 * When several entries still fit, none is named.
 */
export function findCatalogEntry(name: string, config: McpServerConfig, platform: string): McpCatalogEntry | undefined {
  const byName = catalogEntry(name);
  if ('url' in config) {
    const bare = (u: string) => u.split('?')[0].replace(/\/+$/, '').toLowerCase();
    const fits = MCP_CATALOG.filter((e) => e.transport === 'http' && e.url && bare(e.url) === bare(config.url));
    return byName && fits.includes(byName) ? byName : fits.length === 1 ? fits[0] : undefined;
  }
  const own = packageOf(config);
  const fits = MCP_CATALOG.filter((e) => {
    const launch = e.transport === 'stdio' ? catalogLaunch(e, platform) : undefined;
    if (!launch) return false;
    const theirs = packageOf(launch);
    // A local program (no package runner): the same command line, by name only.
    if (!theirs) return e === byName && sameCommandLine(launch, config);
    return theirs === own;
  });
  if (byName && fits.includes(byName) && (fits.length === 1 || choosesVariant(byName, config, platform))) return byName;
  const variants = fits.length > 1 ? fits.filter((e) => choosesVariant(e, config, platform)) : fits;
  return variants.length === 1 ? variants[0] : undefined;
}

/** The server passes every "--option=value" the entry passes (what tells entries of one package apart). */
function choosesVariant(entry: McpCatalogEntry, config: { args?: string[] }, platform: string): boolean {
  const own = new Set((config.args ?? []).map((a) => a.toLowerCase()));
  const options = (catalogLaunch(entry, platform)?.args ?? []).filter((a) => a.startsWith('--') && a.includes('=') && !a.includes('{'));
  return options.every((a) => own.has(a.toLowerCase()));
}

function sameCommandLine(launch: McpCatalogLaunch, config: { command: string; args?: string[] }): boolean {
  const line = (command: string, args: string[] = []) => [command, ...args].join(' ').toLowerCase();
  return line(launch.command, launch.args) === line(config.command, config.args);
}

/** A free name for a new server from this entry: its id, else id-2, id-3, ... */
export function catalogServerName(entry: McpCatalogEntry, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  if (!names.has(entry.id)) return entry.id;
  for (let i = 2; ; i++) if (!names.has(`${entry.id}-${i}`)) return `${entry.id}-${i}`;
}

/** What starting it involves, for the consent dialog: a package runner downloads code; otherwise a local program or a URL. */
export function catalogRunKind(entry: McpCatalogEntry, platform: string): 'download' | 'program' | 'local-url' | 'remote-url' {
  if (entry.transport === 'http') {
    const host = (entry.url ?? '').replace(/^https?:\/\//, '').split(/[/:?]/)[0];
    return host === 'localhost' || host === '127.0.0.1' ? 'local-url' : 'remote-url';
  }
  const command = catalogLaunch(entry, platform)?.command ?? '';
  return ['npx', 'uvx', 'uv', 'docker'].includes(command) ? 'download' : 'program';
}

/** Every catalog string shown through t() (for the translation test). */
export function catalogStrings(): string[] {
  const out = new Set<string>();
  for (const e of MCP_CATALOG) {
    out.add(e.description);
    for (const s of [...e.prerequisites, ...(e.notes ?? []), ...e.fields.map((f) => f.help)]) out.add(s);
    if (e.setup) out.add(e.setup.text);
  }
  return [...out];
}
