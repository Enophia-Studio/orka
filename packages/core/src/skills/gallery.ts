/**
 * Orka's skills gallery: skills the user can add to their own skills folder, browsed with no
 * network access.
 *
 * - "bundled" skills ship with Orka in skills/gallery/<id> (open licences only: MIT, Apache-2.0,
 *   or Orka's own), each with its licence text and a NOTICE naming the source and Orka's changes.
 *   Enable copies the folder into the user's skills folder.
 * - "source" skills are downloaded on the user's click, after a consent dialog with the exact URLs,
 *   from raw.githubusercontent.com at a pinned commit; every file is checked against the size and
 *   SHA-256 in galleryFiles.ts. Skills whose licence does not allow Orka to ship them (no licence,
 *   the Unity Companion License, CC BY-SA) and big ones with programs to install are offered this
 *   way. Skills whose licence forbids use with non-Anthropic products are not offered at all.
 *
 * Gallery skills are not always on: the built-in skills (skills/*.md) are listed in every task's
 * instructions, so shipping some 70 more there would add their descriptions to every request.
 *
 * Prose (descriptions, needs, notes, licence notes) is English here and translated where it is
 * shown, with t(); a test checks that every such string has a Turkish entry.
 */
import { t } from '../i18n';

export type SkillGalleryCategory = 'game-dev' | 'code-quality' | 'testing' | 'workflow' | 'design' | 'documents' | 'writing' | 'backend' | 'devops' | 'security' | 'other';

export const SKILL_GALLERY_CATEGORIES: readonly SkillGalleryCategory[] = [
  'game-dev',
  'code-quality',
  'testing',
  'workflow',
  'design',
  'documents',
  'writing',
  'backend',
  'devops',
  'security',
  'other',
];

export interface SkillGalleryEntry {
  /** The skill's name, and its folder in the user's skills folder. */
  id: string;
  name: string;
  category: SkillGalleryCategory;
  /** What it does, in Orka's words. */
  description: string;
  /** Who wrote it (descriptive only). */
  author: string;
  /** SPDX id, or LicenseRef-... / NOASSERTION. */
  license: string;
  /** Terms that limit use or sharing, or that no licence is stated; shown before installing. */
  licenseNote?: string;
  /** The skill's page upstream (https). */
  source: string;
  kind: 'bundled' | 'source';
  /** Programs or files it relies on. */
  needs: string[];
  notes?: string[];
}

/** Licences that let Orka ship a skill (and that need no extra terms from the user). */
export const OPEN_SKILL_LICENSES: readonly string[] = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC0-1.0'];

export function openLicense(license: string): boolean {
  return OPEN_SKILL_LICENSES.includes(license);
}

// Shared texts (each translated once).
const MD = 'Markdown only';
const ANTHROPIC = 'Anthropic';
const OBRA = 'Jesse Vincent (obra/superpowers)';
const HOBSON = 'Seth Hobson (wshobson/agents)';
const TOB = 'Trail of Bits';
const UNITY = 'Unity Technologies';
const ORKA = 'Orka';
const UNITY_PROJECT = 'A Unity project';
const CC_BY_SA = 'CC BY-SA 4.0: if you share a changed copy, share it under the same licence and credit Trail of Bits.';
const UNITY_LICENSE = 'Unity Companion License: use it only together with the Unity Engine, under your Unity licence.';
const OFFICE = 'Its licence would let Orka ship it; it is a download because of its size and the programs it needs.';

const gh = (repo: string, path: string) => `https://github.com/${repo}/tree/main/${path}`;

function bundled(id: string, name: string, category: SkillGalleryCategory, author: string, license: string, source: string, description: string, needs: string[] = [MD], notes?: string[]): SkillGalleryEntry {
  return { id, name, category, description, author, license, source, kind: 'bundled', needs, ...(notes ? { notes } : {}) };
}

function download(
  id: string,
  name: string,
  category: SkillGalleryCategory,
  author: string,
  license: string,
  source: string,
  description: string,
  needs: string[] = [MD],
  extra: { notes?: string[]; licenseNote?: string } = {},
): SkillGalleryEntry {
  return { id, name, category, description, author, license, source, kind: 'source', needs, ...extra };
}

const anthropic = (id: string) => gh('anthropics/skills', `skills/${id}`);
const superpowers = (id: string) => gh('obra/superpowers', `skills/${id}`);
const hobson = (plugin: string, id: string) => gh('wshobson/agents', `plugins/${plugin}/skills/${id}`);
const tob = (plugin: string, id: string) => gh('trailofbits/skills', `plugins/${plugin}/skills/${id}`);
const unity = (id: string) => gh('Unity-Technologies/skills', `skills/${id}`);
const orka = (id: string) => `https://github.com/Enophia-Studio/orka/tree/main/packages/core/skills/gallery/${id}`;

export const SKILL_GALLERY: readonly SkillGalleryEntry[] = [
  // ------------------------------------------------------------------ game development
  bundled('unreal-engine', 'Unreal Engine', 'game-dev', ORKA, 'MIT', orka('unreal-engine'), 'Unreal Engine 5: C++ that fits the engine (reflection, garbage collection, replication), Blueprints and builds.'),
  bundled('godot', 'Godot', 'game-dev', ORKA, 'MIT', orka('godot'), 'Godot 4 projects: typed GDScript, scenes, signals, resources, autoloads and headless checks.'),
  bundled('unity-ecs-patterns', 'Unity ECS / DOTS patterns', 'game-dev', HOBSON, 'MIT', hobson('game-development', 'unity-ecs-patterns'), 'Unity Entities, Jobs and Burst patterns for high-performance gameplay code.'),
  bundled('godot-gdscript-patterns', 'Godot GDScript patterns', 'game-dev', HOBSON, 'MIT', hobson('game-development', 'godot-gdscript-patterns'), 'Godot 4 GDScript patterns: signals, scenes, state machines and performance.'),
  download(
    'unity-claude-code-assistant',
    'Unity MCP assistant',
    'game-dev',
    'Raven (Ryan-focus)',
    'MIT',
    'https://github.com/Ryan-focus/unity-claude-code-skill',
    'Sets up and diagnoses a Unity MCP bridge (the official Unity MCP or MCP for Unity) and covers Editor work through MCP tools.',
    ['A Unity MCP server (Settings > MCP > Catalog)'],
    { notes: ['Only its Markdown guidance is installed; its setup scripts, which change another tool’s configuration, are left out.'] },
  ),
  download('unity-cli', 'Unity CLI', 'game-dev', UNITY, 'LicenseRef-Unity-Companion-License', unity('unity-cli'), 'Controls Unity Editors and projects from the command line: installs, licences, new projects and a running Editor.', ['Unity Hub and the Unity CLI'], {
    licenseNote: UNITY_LICENSE,
  }),
  download('ui-uitk', 'Unity UI Toolkit', 'game-dev', UNITY, 'LicenseRef-Unity-Companion-License', unity('ui-uitk'), 'Reads, edits and generates UXML and USS layouts for UI Toolkit.', [UNITY_PROJECT], { licenseNote: UNITY_LICENSE }),
  download('ui-ugui', 'Unity uGUI', 'game-dev', UNITY, 'LicenseRef-Unity-Companion-License', unity('ui-ugui'), 'Canvas hierarchies, RectTransforms, layout groups and prefab UI in uGUI.', [UNITY_PROJECT], { licenseNote: UNITY_LICENSE }),
  download(
    'migrate-birp-to-urp',
    'Built-in to URP migration',
    'game-dev',
    UNITY,
    'LicenseRef-Unity-Companion-License',
    unity('migrate-birp-to-urp'),
    'Plans, carries out and troubleshoots moving a project, its materials and its shaders from the Built-in pipeline to URP.',
    [UNITY_PROJECT],
    { licenseNote: UNITY_LICENSE },
  ),
  download(
    'fix-3d-physics-collisions',
    'Fix 3D physics collisions',
    'game-dev',
    UNITY,
    'LicenseRef-Unity-Companion-License',
    unity('fix-3d-physics-collisions'),
    'Diagnoses PhysX collisions, triggers and raycasts that do not fire or behave wrongly.',
    [UNITY_PROJECT],
    { licenseNote: UNITY_LICENSE },
  ),
  download(
    'new-unity-project',
    'New Unity project',
    'game-dev',
    UNITY,
    'LicenseRef-Unity-Companion-License',
    unity('new-unity-project'),
    'Guides a new Unity project from concept and target platforms to source control and packages.',
    ['Unity Hub'],
    { licenseNote: UNITY_LICENSE },
  ),
  download('urp-postprocessing', 'URP post-processing', 'game-dev', UNITY, 'LicenseRef-Unity-Companion-License', unity('urp-postprocessing'), 'Volume-based bloom, tonemapping, colour grading, depth of field and vignette in URP.', [UNITY_PROJECT], {
    licenseNote: UNITY_LICENSE,
  }),
  download('optimize-text-mesh-pro', 'Optimize TextMeshPro', 'game-dev', UNITY, 'LicenseRef-Unity-Companion-License', unity('optimize-text-mesh-pro'), 'TextMeshPro font assets, fallback atlases, SDF quality and memory.', [UNITY_PROJECT], {
    licenseNote: UNITY_LICENSE,
  }),
  download('localize-unity-project', 'Localize a Unity project', 'game-dev', UNITY, 'LicenseRef-Unity-Companion-License', unity('localize-unity-project'), 'Unity Localization setup: locales, string and asset tables, and CJK fonts.', [UNITY_PROJECT], {
    licenseNote: UNITY_LICENSE,
  }),

  // ------------------------------------------------------------------ code quality
  bundled('systematic-debugging', 'Systematic debugging', 'code-quality', OBRA, 'MIT', superpowers('systematic-debugging'), 'Root-cause debugging in four phases: trace the cause, defend in depth, wait on conditions instead of timeouts, and find the test that breaks the others.', [
    MD,
    'Optional: bash (Git Bash on Windows) for find-polluter.sh',
  ]),
  bundled('code-simplifier', 'Code simplifier', 'code-quality', ANTHROPIC, 'Apache-2.0', gh('anthropics/claude-plugins-official', 'plugins/code-simplifier'), 'Cleans up recently changed code for clarity and consistency without changing what it does.'),
  bundled('silent-failure-hunter', 'Silent failure hunter', 'code-quality', ANTHROPIC, 'Apache-2.0', gh('anthropics/claude-plugins-official', 'plugins/pr-review-toolkit'), 'Finds swallowed errors, empty catch blocks and fallbacks that hide failures in a change.'),
  bundled('type-design-analyzer', 'Type design analyzer', 'code-quality', ANTHROPIC, 'Apache-2.0', gh('anthropics/claude-plugins-official', 'plugins/pr-review-toolkit'), 'Reviews new types for encapsulation and invariants, so that invalid states are hard to represent.'),
  bundled('requesting-code-review', 'Requesting code review', 'code-quality', OBRA, 'MIT', superpowers('requesting-code-review'), 'Sends finished work to a reviewer sub-agent, checked against the requirements, before merging.'),
  bundled('receiving-code-review', 'Receiving code review', 'code-quality', OBRA, 'MIT', superpowers('receiving-code-review'), 'Checks review feedback on its technical merits before acting on it, instead of agreeing to everything.'),
  bundled('code-review-excellence', 'Code review practice', 'code-quality', HOBSON, 'MIT', hobson('developer-essentials', 'code-review-excellence'), 'How to give constructive, prioritised review feedback that catches bugs early.'),
  bundled('error-handling-patterns', 'Error handling patterns', 'code-quality', HOBSON, 'MIT', hobson('developer-essentials', 'error-handling-patterns'), 'Exceptions, Result types, error propagation and graceful degradation across languages.'),

  // ------------------------------------------------------------------ testing
  bundled('test-driven-development', 'Test-driven development', 'testing', OBRA, 'MIT', superpowers('test-driven-development'), 'Strict red-green-refactor: a failing test before any implementation code.'),
  bundled('pr-test-analyzer', 'Test coverage review', 'testing', ANTHROPIC, 'Apache-2.0', gh('anthropics/claude-plugins-official', 'plugins/pr-review-toolkit'), 'Judges whether a change’s tests really cover the new behaviour and its edge cases.'),
  bundled('webapp-testing', 'Web app testing', 'testing', ANTHROPIC, 'Apache-2.0', anthropic('webapp-testing'), 'Drives a local web app with Playwright to check behaviour, take screenshots and read console logs.', [
    'Python 3 with Playwright and a browser for it (playwright install chromium)',
  ]),
  bundled('e2e-testing-patterns', 'E2E testing patterns', 'testing', HOBSON, 'MIT', hobson('developer-essentials', 'e2e-testing-patterns'), 'Reliable end-to-end suites with Playwright or Cypress: selectors, fixtures and fighting flaky tests.'),
  bundled('javascript-testing-patterns', 'JS/TS testing patterns', 'testing', HOBSON, 'MIT', hobson('javascript-typescript', 'javascript-testing-patterns'), 'Unit and integration tests with Jest, Vitest and Testing Library.'),
  bundled('python-testing-patterns', 'Python testing patterns', 'testing', HOBSON, 'MIT', hobson('python-development', 'python-testing-patterns'), 'pytest fixtures, parametrising, mocking and test-first habits for Python.'),
  download('property-based-testing', 'Property-based testing', 'testing', TOB, 'CC-BY-SA-4.0', tob('property-based-testing', 'property-based-testing'), 'Writes and debugs property-based tests with Hypothesis, fast-check, proptest and similar tools.', [
    'The property-testing library of your language',
  ], { licenseNote: CC_BY_SA }),
  download('mutation-testing', 'Mutation testing', 'testing', TOB, 'CC-BY-SA-4.0', tob('mutation-testing', 'mutation-testing'), 'Sets up mutation-testing runs, analyses the mutants that survive and finds gaps in the tests.', [
    'A mutation-testing tool (mewt or muton)',
  ], { licenseNote: CC_BY_SA }),

  // ------------------------------------------------------------------ workflow
  bundled('verification-before-completion', 'Verification before completion', 'workflow', OBRA, 'MIT', superpowers('verification-before-completion'), 'Makes the agent run the checks and read their output before it says work is done, fixed or passing.'),
  bundled('dispatching-parallel-agents', 'Dispatching parallel agents', 'workflow', OBRA, 'MIT', superpowers('dispatching-parallel-agents'), 'Splits independent tasks across parallel sub-agents that share no state.'),
  download('brainstorming', 'Brainstorming', 'workflow', OBRA, 'MIT', superpowers('brainstorming'), 'Before building something new, questions the user to turn a rough idea into an agreed design.', [MD, 'Optional: Node.js for its visual companion'], {
    notes: ['Its description tells the agent to use it before any creative work; turn it off in My skills when that is too eager.'],
  }),
  download('writing-plans', 'Writing plans', 'workflow', OBRA, 'MIT', superpowers('writing-plans'), 'Turns a spec into a detailed, testable step-by-step implementation plan before any code is touched.'),
  download('executing-plans', 'Executing plans', 'workflow', OBRA, 'MIT', superpowers('executing-plans'), 'Works through a written plan task by task, with checkpoints and a final review.', [MD, 'bash (Git Bash on Windows) for its scripts']),
  download('writing-skills', 'Writing skills', 'workflow', OBRA, 'MIT', superpowers('writing-skills'), 'Writes skills test-first and checks that they trigger and work.', [MD, 'Optional: Node.js for render-graphs.js']),
  download('skill-creator', 'Skill creator', 'workflow', ANTHROPIC, 'Apache-2.0', anthropic('skill-creator'), 'Writes new skills and improves existing ones, with evaluations and tuning of the description line.', ['Python 3 for its scripts'], {
    notes: ['Written for Claude Code sub-agents; in Orka, new skills go in your skills folder.'],
  }),

  // ------------------------------------------------------------------ design
  bundled('frontend-design', 'Frontend design', 'design', ANTHROPIC, 'Apache-2.0', anthropic('frontend-design'), 'Pushes UI work toward a deliberate visual direction (typography, colour, layout), so the result does not look like a default template.'),
  bundled('accessibility', 'Accessibility', 'design', ORKA, 'MIT', orka('accessibility'), 'Keyboard, screen reader, contrast, zoom and reduced motion for web, desktop and game UI.'),
  bundled('wcag-audit-patterns', 'WCAG accessibility audit', 'design', HOBSON, 'MIT', hobson('accessibility-compliance', 'wcag-audit-patterns'), 'WCAG 2.2 audits that combine automated and manual checks, with fixes.', [MD, 'Optional: axe or Playwright']),
  bundled('tailwind-design-system', 'Tailwind design system', 'design', HOBSON, 'MIT', hobson('frontend-mobile-development', 'tailwind-design-system'), 'Design tokens, component libraries and responsive patterns with Tailwind CSS v4.'),
  bundled('theme-factory', 'Theme factory', 'design', ANTHROPIC, 'Apache-2.0', anthropic('theme-factory'), 'Applies one of ten preset colour and font themes, or a new one, to slides, documents or HTML pages.'),
  download('canvas-design', 'Canvas design', 'design', ANTHROPIC, 'Apache-2.0', anthropic('canvas-design'), 'Makes posters and other static art as PNG or PDF, starting from a written design philosophy.', [
    'Python 3 with Pillow',
    'About 5 MB of fonts that come with it (SIL Open Font License)',
  ]),
  download('algorithmic-art', 'Algorithmic art', 'design', ANTHROPIC, 'Apache-2.0', anthropic('algorithmic-art'), 'Generative art in p5.js with seeded randomness and adjustable parameters.', ['A browser; p5.js is loaded from a CDN']),
  download('web-artifacts-builder', 'Web artifacts builder', 'design', ANTHROPIC, 'Apache-2.0', anthropic('web-artifacts-builder'), 'Scaffolds React, Tailwind and shadcn/ui pages and bundles them into one HTML file.', [
    'Node.js and pnpm',
    'bash (Git Bash or WSL on Windows)',
  ]),
  download('slack-gif-creator', 'Animated GIF creator', 'design', ANTHROPIC, 'Apache-2.0', anthropic('slack-gif-creator'), 'Makes small animated GIFs that fit chat-app size limits, with a validation helper.', ['Python 3 with Pillow and imageio']),

  // ------------------------------------------------------------------ documents
  download('docx', 'Word documents (docx)', 'documents', ANTHROPIC, 'Apache-2.0', anthropic('docx'), 'Creates, edits and reads Word documents, including tracked changes, comments, images and templates.', [
    'Python 3 and the scripts that come with it',
    'Node.js with the docx package',
    'pandoc',
    'LibreOffice',
    'Poppler',
  ], { notes: [OFFICE] }),
  download('pdf', 'PDF toolkit', 'documents', ANTHROPIC, 'Apache-2.0', anthropic('pdf'), 'Reads, merges, splits, rotates, watermarks, fills, encrypts and creates PDFs, with OCR for scanned pages.', [
    'Python 3 with pypdf, pdfplumber and reportlab',
    'qpdf and Poppler',
    'Optional: Tesseract for OCR',
  ], { notes: [OFFICE] }),
  download('pptx', 'PowerPoint (pptx)', 'documents', ANTHROPIC, 'Apache-2.0', anthropic('pptx'), 'Builds, edits and extracts PowerPoint decks, including layouts, notes and templates.', [
    'Python 3 with python-pptx and markitdown',
    'Node.js with pptxgenjs',
    'LibreOffice',
    'Poppler',
  ], { notes: [OFFICE] }),
  download('xlsx', 'Spreadsheets (xlsx)', 'documents', ANTHROPIC, 'Apache-2.0', anthropic('xlsx'), 'Opens, cleans, edits and creates spreadsheets and CSV files, including formulas, formatting and charts, then recalculates and checks them.', [
    'Python 3 with openpyxl and markitdown',
    'LibreOffice (to recalculate formulas)',
  ], { notes: [OFFICE] }),

  // ------------------------------------------------------------------ writing
  bundled('internal-comms', 'Internal comms', 'writing', ANTHROPIC, 'Apache-2.0', anthropic('internal-comms'), 'Templates for status reports, leadership updates, newsletters, FAQs and incident notes.'),
  bundled('architecture-decision-records', 'Architecture decision records', 'writing', HOBSON, 'MIT', hobson('documentation-generation', 'architecture-decision-records'), 'Writes and maintains ADRs that record technical decisions and their trade-offs.'),
  bundled('postmortem-writing', 'Postmortem writing', 'writing', HOBSON, 'MIT', hobson('incident-response', 'postmortem-writing'), 'Blameless incident postmortems with a timeline, root cause and action items.'),
  download('avoid-ai-writing', 'Avoid AI writing', 'writing', 'Conor Bronsdon (via wshobson/agents)', 'MIT', hobson('avoid-ai-writing', 'avoid-ai-writing'), 'Audits and rewrites prose to remove machine-sounding phrasing.'),
  download('doc-coauthoring', 'Doc co-authoring', 'writing', ANTHROPIC, 'NOASSERTION', anthropic('doc-coauthoring'), 'A step-by-step process for writing specs, proposals and decision documents together with the user.', [MD], {
    licenseNote: 'No licence is stated, so all rights stay with its author. Install it only for your own use.',
  }),

  // ------------------------------------------------------------------ backend
  bundled('api-design', 'API design', 'backend', ORKA, 'MIT', orka('api-design'), 'HTTP/JSON API design: resources, status codes, one error format, pagination, versioning and per-object authorisation.'),
  bundled('database-migrations', 'Database migrations', 'backend', ORKA, 'MIT', orka('database-migrations'), 'Schema changes that are safe on a live database: expand and contract, online indexes, batched backfills, reversibility.'),

  // ------------------------------------------------------------------ devops
  bundled('ci-pipelines', 'CI pipelines', 'devops', ORKA, 'MIT', orka('ci-pipelines'), 'CI/CD pipelines that are fast, deterministic and locked down: caching, matrices, least privilege, pinned actions, releases.'),
  bundled('github-actions-templates', 'GitHub Actions templates', 'devops', HOBSON, 'MIT', hobson('cicd-automation', 'github-actions-templates'), 'Ready-to-adapt GitHub Actions workflows for testing, building and deploying.'),
  bundled('mcp-builder', 'MCP server builder', 'devops', ANTHROPIC, 'Apache-2.0', anthropic('mcp-builder'), 'A guide to designing and building good MCP servers in Python (FastMCP) or TypeScript (MCP SDK), with evaluations.', [
    MD,
    'Optional: Python and an Anthropic API key for its evaluation script',
  ]),
  download('build-mcp-server', 'Build an MCP server', 'devops', ANTHROPIC, 'Apache-2.0', gh('anthropics/claude-plugins-official', 'plugins/mcp-server-dev/skills/build-mcp-server'), 'A step-by-step guide to a new MCP server, from the first tool to packaging.'),
  download('using-git-worktrees', 'Using git worktrees', 'devops', OBRA, 'MIT', superpowers('using-git-worktrees'), 'Sets up an isolated git worktree before feature work or running a plan.', ['Git']),

  // ------------------------------------------------------------------ security
  bundled('secrets-management', 'CI secrets management', 'security', HOBSON, 'MIT', hobson('cicd-automation', 'secrets-management'), 'Handling secrets in CI/CD pipelines with Vault, cloud secret managers or platform secrets.'),
  download('semgrep', 'Semgrep static analysis', 'security', TOB, 'CC-BY-SA-4.0', tob('static-analysis', 'semgrep'), 'Runs Semgrep scans and triages the findings.', ['Semgrep CLI'], { licenseNote: CC_BY_SA }),
  download('codeql', 'CodeQL analysis', 'security', TOB, 'CC-BY-SA-4.0', tob('static-analysis', 'codeql'), 'Builds a CodeQL database, runs queries and reads the results.', ['CodeQL CLI (free for open source and research only)'], { licenseNote: CC_BY_SA }),
  download('differential-review', 'Security diff review', 'security', TOB, 'CC-BY-SA-4.0', tob('differential-review', 'differential-review'), 'Security-focused review of a code change, deeper for bigger or riskier changes.', ['Git'], { licenseNote: CC_BY_SA }),
  download('supply-chain-risk-auditor', 'Supply-chain risk auditor', 'security', TOB, 'CC-BY-SA-4.0', tob('supply-chain-risk-auditor', 'supply-chain-risk-auditor'), 'Audits dependencies for known advisories, maintainer risk and suspicious packages.', [
    'The CLI of your package manager',
    'Network access',
  ], { licenseNote: CC_BY_SA }),
  download('sharp-edges', 'Sharp edges', 'security', TOB, 'CC-BY-SA-4.0', tob('sharp-edges', 'sharp-edges'), 'Spots error-prone APIs, dangerous defaults and designs that invite security mistakes.', [MD], { licenseNote: CC_BY_SA }),
  download('variant-analysis', 'Variant analysis', 'security', TOB, 'CC-BY-SA-4.0', tob('variant-analysis', 'variant-analysis'), 'Given one bug, hunts the codebase for other places with the same root cause.', [MD, 'Optional: Semgrep or CodeQL'], {
    licenseNote: CC_BY_SA,
  }),
  download('semgrep-rule-creator', 'Semgrep rule creator', 'security', TOB, 'CC-BY-SA-4.0', tob('semgrep-rule-creator', 'semgrep-rule-creator'), 'Writes and tests custom Semgrep rules for bug and vulnerability patterns.', ['Semgrep CLI'], { licenseNote: CC_BY_SA }),

  // ------------------------------------------------------------------ other
  download('claude-api', 'Claude API reference', 'other', ANTHROPIC, 'Apache-2.0', anthropic('claude-api'), 'Reference for the Anthropic SDKs in nine languages: models, streaming, tool use, caching and migration.', [MD], {
    notes: ['Model facts go out of date: remove it and install it again to refresh.'],
  }),
];

/** A licence id as people read it ("NOASSERTION" and LicenseRef ids as words). */
export function licenseName(license: string): string {
  if (license === 'NOASSERTION') return t('No licence stated');
  if (license === 'LicenseRef-Unity-Companion-License') return 'Unity Companion License';
  return license;
}

export function galleryEntry(id: unknown): SkillGalleryEntry | undefined {
  return typeof id === 'string' ? SKILL_GALLERY.find((e) => e.id === id) : undefined;
}

/** Every string the gallery shows through t() (for the translation test). */
export function galleryStrings(): string[] {
  const out = new Set<string>();
  for (const e of SKILL_GALLERY) {
    out.add(e.description);
    for (const n of e.needs) out.add(n);
    for (const n of e.notes ?? []) out.add(n);
    if (e.licenseNote) out.add(e.licenseNote);
  }
  return [...out];
}
