// Builds the third-party part of Orka's skills gallery from local clones of the upstream
// repositories, at the commits pinned below:
//
//   node scripts/skill-gallery.mjs <folder with the clones>
//
// The clones are named <owner>_<repo> (e.g. anthropics_skills). File contents are read from git
// objects at the pinned commit (never from the working tree), so line endings and local edits
// cannot change them.
//
// - Bundled skills (licences that allow it: MIT, Apache-2.0) are written to
//   packages/core/skills/gallery/<id>/ with their licence text and a NOTICE that names the source,
//   the copyright holder and every change Orka made.
// - Skills offered as downloads get an exact file list (repository path, installed path, size,
//   SHA-256) in packages/core/src/skills/galleryFiles.ts. The installer fetches only those files
//   and refuses anything that differs.
//
// Orka's own gallery skills (packages/core/skills/gallery/<id> with "Orka" in their NOTICE) are
// written by hand and left alone here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GALLERY = path.join(ROOT, 'packages/core/skills/gallery');
const FILES_MODULE = path.join(ROOT, 'packages/core/src/skills/galleryFiles.ts');
const TODAY = '2026-11-07';

const PINS = {
  'anthropics/skills': '2c5958ecac7cee2b583967a2c4981d0f4a75c579',
  'anthropics/claude-plugins-official': '0412be76f50ab4f4f8abff3753efa9269fbbca5b',
  'obra/superpowers': '22f0b463e7a5e579904dd6211a520321035526f7',
  'wshobson/agents': '4bde3168b43c0655c4d00ea2726e631719908a6d',
  'trailofbits/skills': 'e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff',
  'Unity-Technologies/skills': '60f95e6d4beaeacf4dfdff7829ec9b35008a0be0',
  'Ryan-focus/unity-claude-code-skill': '2085305d0afdcda9c1b1f4efb6c6e683b7228d10',
};

const ANTHROPIC = 'Copyright (c) Anthropic, PBC';
const OBRA = 'Copyright (c) 2025 Jesse Vincent';
const HOBSON = 'Copyright (c) 2024 Seth Hobson';
const SUPERPOWERS_REFS = 'In the Markdown files, references to other skills drop the "superpowers:" prefix (the skills keep their names in Orka). Nothing else is changed.';
const CLAUDE_MD = [/from CLAUDE\.md/g, "from the project's instructions (CLAUDE.md, AGENTS.md or similar)"];
const AGENT_TO_SKILL = 'Converted from an agent definition (agents/*.md) to a skill: new front matter (name, a description of when to use it, license); the model, color and tools keys are dropped. The body is unchanged';

/** @typedef {{ id: string, repo: string, path: string, file?: string, exclude?: RegExp, license: string, licenseFile: string, copyright: string, description?: string, replace?: Array<[RegExp, string]>, changes: string[] }} Bundled */

/** @type {Bundled[]} */
const BUNDLED = [
  // ------------------------------------------------ anthropics/skills (Apache-2.0)
  {
    id: 'frontend-design',
    repo: 'anthropics/skills',
    path: 'skills/frontend-design',
    license: 'Apache-2.0',
    licenseFile: 'skills/frontend-design/LICENSE.txt',
    copyright: ANTHROPIC,
    changes: ['Front matter: the license key names Apache-2.0. The body is unchanged.'],
  },
  {
    id: 'webapp-testing',
    repo: 'anthropics/skills',
    path: 'skills/webapp-testing',
    license: 'Apache-2.0',
    licenseFile: 'skills/webapp-testing/LICENSE.txt',
    copyright: ANTHROPIC,
    changes: ['Front matter: the license key names Apache-2.0. The body, scripts and examples are unchanged.'],
  },
  {
    id: 'mcp-builder',
    repo: 'anthropics/skills',
    path: 'skills/mcp-builder',
    license: 'Apache-2.0',
    licenseFile: 'skills/mcp-builder/LICENSE.txt',
    copyright: ANTHROPIC,
    changes: ['Front matter: the license key names Apache-2.0. The body, references and scripts are unchanged.'],
  },
  {
    id: 'internal-comms',
    repo: 'anthropics/skills',
    path: 'skills/internal-comms',
    license: 'Apache-2.0',
    licenseFile: 'skills/internal-comms/LICENSE.txt',
    copyright: ANTHROPIC,
    description:
      'Use when asked to write internal communications in a set format: status reports, leadership updates, third-party updates, company newsletters, FAQs, incident reports or project updates.',
    changes: ['Front matter: the description is reworded for any agent (it named one assistant) and the license key names Apache-2.0. The body and examples are unchanged.'],
  },
  {
    id: 'theme-factory',
    repo: 'anthropics/skills',
    path: 'skills/theme-factory',
    exclude: /\.pdf$/,
    license: 'Apache-2.0',
    licenseFile: 'skills/theme-factory/LICENSE.txt',
    copyright: ANTHROPIC,
    changes: ['theme-showcase.pdf (a binary preview of the themes) is left out; the themes/*.md files carry the same colours and fonts.', 'Front matter: the license key names Apache-2.0. The body is unchanged.'],
  },
  // ------------------------------------------------ anthropics/claude-plugins-official (Apache-2.0)
  {
    id: 'code-simplifier',
    repo: 'anthropics/claude-plugins-official',
    path: 'plugins/code-simplifier/agents',
    file: 'plugins/code-simplifier/agents/code-simplifier.md',
    license: 'Apache-2.0',
    licenseFile: 'plugins/code-simplifier/LICENSE',
    copyright: ANTHROPIC,
    description: 'Use after a change is written to simplify and refine the recently modified code for clarity, consistency and maintainability, without changing what it does.',
    replace: [CLAUDE_MD],
    changes: [`${AGENT_TO_SKILL}, except that "CLAUDE.md" reads "the project's instructions (CLAUDE.md, AGENTS.md or similar)".`],
  },
  {
    id: 'silent-failure-hunter',
    repo: 'anthropics/claude-plugins-official',
    path: 'plugins/pr-review-toolkit/agents',
    file: 'plugins/pr-review-toolkit/agents/silent-failure-hunter.md',
    license: 'Apache-2.0',
    licenseFile: 'plugins/pr-review-toolkit/LICENSE',
    copyright: ANTHROPIC,
    description: 'Use when reviewing a change that touches error handling, catch blocks or fallback logic, to find errors that are swallowed, hidden or never reported.',
    replace: [CLAUDE_MD],
    changes: [`${AGENT_TO_SKILL}, except that "CLAUDE.md" reads "the project's instructions (CLAUDE.md, AGENTS.md or similar)".`],
  },
  {
    id: 'pr-test-analyzer',
    repo: 'anthropics/claude-plugins-official',
    path: 'plugins/pr-review-toolkit/agents',
    file: 'plugins/pr-review-toolkit/agents/pr-test-analyzer.md',
    license: 'Apache-2.0',
    licenseFile: 'plugins/pr-review-toolkit/LICENSE',
    copyright: ANTHROPIC,
    description: 'Use when reviewing a pull request or a change to judge whether its tests really cover the new behaviour and the edge cases that matter.',
    replace: [CLAUDE_MD],
    changes: [`${AGENT_TO_SKILL}, except that "CLAUDE.md" reads "the project's instructions (CLAUDE.md, AGENTS.md or similar)".`],
  },
  {
    id: 'type-design-analyzer',
    repo: 'anthropics/claude-plugins-official',
    path: 'plugins/pr-review-toolkit/agents',
    file: 'plugins/pr-review-toolkit/agents/type-design-analyzer.md',
    license: 'Apache-2.0',
    licenseFile: 'plugins/pr-review-toolkit/LICENSE',
    copyright: ANTHROPIC,
    description: 'Use when adding or reviewing types, to check their encapsulation and invariants and to make invalid states hard to represent.',
    changes: [`${AGENT_TO_SKILL}.`],
  },
  // ------------------------------------------------ obra/superpowers (MIT)
  ...[
    ['systematic-debugging', ['find-polluter.sh is a bash script: on Windows it needs Git Bash or WSL. Orka never runs it.']],
    ['test-driven-development', []],
    ['verification-before-completion', []],
    ['requesting-code-review', []],
    ['receiving-code-review', []],
    ['dispatching-parallel-agents', []],
  ].map(([id, extra]) => ({
    id,
    repo: 'obra/superpowers',
    path: `skills/${id}`,
    license: 'MIT',
    licenseFile: 'LICENSE',
    copyright: OBRA,
    replace: [[/superpowers:/g, '']],
    changes: ['Front matter: a license key is added.', SUPERPOWERS_REFS, ...extra],
  })),
  // ------------------------------------------------ wshobson/agents (MIT)
  ...[
    ['unity-ecs-patterns', 'game-development'],
    ['godot-gdscript-patterns', 'game-development'],
    ['e2e-testing-patterns', 'developer-essentials'],
    ['javascript-testing-patterns', 'javascript-typescript'],
    ['python-testing-patterns', 'python-development'],
    ['github-actions-templates', 'cicd-automation'],
    ['secrets-management', 'cicd-automation'],
    ['wcag-audit-patterns', 'accessibility-compliance'],
    ['tailwind-design-system', 'frontend-mobile-development'],
    ['architecture-decision-records', 'documentation-generation'],
    ['error-handling-patterns', 'developer-essentials'],
    ['code-review-excellence', 'developer-essentials'],
    ['postmortem-writing', 'incident-response'],
  ].map(([id, plugin]) => ({
    id,
    repo: 'wshobson/agents',
    path: `plugins/${plugin}/skills/${id}`,
    license: 'MIT',
    licenseFile: 'LICENSE',
    copyright: HOBSON,
    changes: ['Front matter: a license key is added. The body and references are unchanged.'],
  })),
];

/** @typedef {{ id: string, repo: string, path: string, file?: string, include?: RegExp, extra?: Array<[string, string]> }} Source */

const ANTHROPIC_SKILLS = ['docx', 'pdf', 'pptx', 'xlsx', 'skill-creator', 'canvas-design', 'algorithmic-art', 'web-artifacts-builder', 'slack-gif-creator', 'claude-api', 'doc-coauthoring'];
const TOB = [
  ['semgrep', 'static-analysis'],
  ['codeql', 'static-analysis'],
  ['property-based-testing', 'property-based-testing'],
  ['mutation-testing', 'mutation-testing'],
  ['differential-review', 'differential-review'],
  ['supply-chain-risk-auditor', 'supply-chain-risk-auditor'],
  ['sharp-edges', 'sharp-edges'],
  ['variant-analysis', 'variant-analysis'],
  ['semgrep-rule-creator', 'semgrep-rule-creator'],
];
const UNITY = ['unity-cli', 'ui-uitk', 'ui-ugui', 'migrate-birp-to-urp', 'fix-3d-physics-collisions', 'new-unity-project', 'urp-postprocessing', 'optimize-text-mesh-pro', 'localize-unity-project'];

/** @type {Source[]} */
const SOURCES = [
  ...ANTHROPIC_SKILLS.map((id) => ({ id, repo: 'anthropics/skills', path: `skills/${id}` })),
  ...['brainstorming', 'writing-plans', 'executing-plans', 'using-git-worktrees', 'writing-skills'].map((id) => ({
    id,
    repo: 'obra/superpowers',
    path: `skills/${id}`,
    extra: [['LICENSE', 'LICENSE']],
  })),
  { id: 'avoid-ai-writing', repo: 'wshobson/agents', path: 'plugins/avoid-ai-writing/skills/avoid-ai-writing', extra: [['LICENSE', 'LICENSE'], ['plugins/avoid-ai-writing/README.md', 'README.md']] },
  { id: 'build-mcp-server', repo: 'anthropics/claude-plugins-official', path: 'plugins/mcp-server-dev/skills/build-mcp-server', extra: [['plugins/mcp-server-dev/LICENSE', 'LICENSE']] },
  ...TOB.map(([id, plugin]) => ({ id, repo: 'trailofbits/skills', path: `plugins/${plugin}/skills/${id}`, extra: [['LICENSE', 'LICENSE']] })),
  ...UNITY.map((id) => ({ id, repo: 'Unity-Technologies/skills', path: `skills/${id}`, extra: [['LICENSE.md', 'LICENSE.md']] })),
  // The skill sits at the repository root; only its Markdown guidance and licence are taken (its
  // setup scripts change another tool's configuration).
  { id: 'unity-claude-code-assistant', repo: 'Ryan-focus/unity-claude-code-skill', path: '', include: /^(SKILL\.md|unity_operations\.md|troubleshooting\.md|LICENSE)$/ },
];

const clones = process.argv[2];
if (!clones) {
  console.error('usage: node scripts/skill-gallery.mjs <folder with the clones>');
  process.exit(1);
}

const git = (repo, args, encoding = 'utf8') =>
  execFileSync('git', ['-C', path.join(clones, repo.replace('/', '_')), ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });

/** Files under a path at the pinned commit: [{ path, size, blob }]. */
function tree(repo, dir) {
  const out = git(repo, ['ls-tree', '-r', '-l', PINS[repo], '--', ...(dir ? [dir] : [])]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      const [, type, blob, size] = meta.trim().split(/\s+/);
      return { type, blob, size: Number(size), path: file };
    })
    .filter((f) => f.type === 'blob' && (dir ? true : !f.path.includes('/')));
}

const blob = (repo, sha) => git(repo, ['cat-file', 'blob', sha], 'buffer');
const show = (repo, file) => git(repo, ['show', `${PINS[repo]}:${file}`], 'buffer');

/** Front matter and body of a SKILL.md (front matter values on one line or as YAML block scalars). */
function splitSkill(text) {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error('no front matter');
  const meta = {};
  const lines = match[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = block.filter(Boolean).join(' ');
    }
    meta[kv[1].toLowerCase()] = value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: match[2] };
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// ------------------------------------------------------------------ bundled skills
for (const skill of BUNDLED) {
  const ref = PINS[skill.repo];
  const dir = path.join(GALLERY, skill.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = skill.file ? tree(skill.repo, skill.file) : tree(skill.repo, skill.path);
  let licenseName = 'LICENSE';
  for (const file of files) {
    const rel = skill.file ? 'SKILL.md' : path.posix.relative(skill.path, file.path);
    if (skill.exclude?.test(rel)) continue;
    let content = blob(skill.repo, file.blob);
    if (rel.endsWith('.md') && rel !== 'SKILL.md' && skill.replace) {
      let text = content.toString('utf8');
      for (const [from, to] of skill.replace) text = text.replace(from, to);
      content = Buffer.from(text);
    }
    if (rel === 'SKILL.md') {
      const { meta, body } = splitSkill(content.toString('utf8'));
      let text = body;
      for (const [from, to] of skill.replace ?? []) text = text.replace(from, to);
      const description = (skill.description ?? meta.description).replace(/\s+/g, ' ').trim();
      content = Buffer.from(`---\nname: ${skill.id}\ndescription: ${description}\nlicense: ${skill.license}\n---\n${text.startsWith('\n') ? '' : '\n'}${text}`);
    }
    if (/^licen[cs]e(\.\w+)?$/i.test(rel)) licenseName = rel;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  if (!files.some((f) => !skill.file && path.posix.relative(skill.path, f.path) === licenseName)) {
    writeFileSync(path.join(dir, licenseName), show(skill.repo, skill.licenseFile));
  }
  const source = `https://github.com/${skill.repo}/tree/${ref}/${skill.file ?? skill.path}`;
  writeFileSync(
    path.join(dir, 'NOTICE'),
    [
      `${skill.id}: a skill in Orka's skills gallery, from ${skill.repo}.`,
      '',
      `Source: ${source}`,
      skill.copyright,
      `Licensed under ${skill.license === 'MIT' ? 'the MIT License' : 'the Apache License, Version 2.0'} (see ${licenseName}).`,
      '',
      `Changes made for Orka (${TODAY}):`,
      ...skill.changes.map((c) => `- ${c}`),
      '',
    ].join('\n'),
  );
  console.log(`bundled ${skill.id} (${files.length} files)`);
}

// ------------------------------------------------------------------ download manifests
const sources = {};
for (const s of SOURCES) {
  const files = [];
  for (const file of tree(s.repo, s.path)) {
    const rel = s.path ? path.posix.relative(s.path, file.path) : file.path;
    if (s.include && !s.include.test(rel)) continue;
    files.push({ from: file.path, to: rel, size: file.size, sha256: sha256(blob(s.repo, file.blob)) });
  }
  for (const [from, to] of s.extra ?? []) {
    const content = show(s.repo, from);
    if (!files.some((f) => f.to === to)) files.push({ from, to, size: content.length, sha256: sha256(content) });
  }
  if (!files.some((f) => f.to === 'SKILL.md')) throw new Error(`${s.id}: no SKILL.md`);
  sources[s.id] = { repo: s.repo, ref: PINS[s.repo], files: files.sort((a, b) => a.to.localeCompare(b.to)) };
  console.log(`source ${s.id} (${files.length} files, ${(files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(0)} KB)`);
}

const lines = [
  '// Generated by scripts/skill-gallery.mjs from the pinned upstream commits; do not edit by hand.',
  '// The exact files each downloadable gallery skill installs: repository path, path in the skill',
  '// folder, size in bytes and SHA-256. The installer fetches only these and refuses any difference.',
  'export interface GalleryFile {',
  '  from: string;',
  '  to: string;',
  '  size: number;',
  '  sha256: string;',
  '}',
  '',
  'export interface GallerySource {',
  '  /** owner/name on GitHub. */',
  '  repo: string;',
  '  /** The pinned commit. */',
  '  ref: string;',
  '  files: GalleryFile[];',
  '}',
  '',
  'export const GALLERY_SOURCES: Readonly<Record<string, GallerySource>> = {',
];
for (const [id, s] of Object.entries(sources)) {
  lines.push(`  ${JSON.stringify(id)}: {`, `    repo: ${JSON.stringify(s.repo)},`, `    ref: ${JSON.stringify(s.ref)},`, '    files: [');
  for (const f of s.files) lines.push(`      { from: ${JSON.stringify(f.from)}, to: ${JSON.stringify(f.to)}, size: ${f.size}, sha256: ${JSON.stringify(f.sha256)} },`);
  lines.push('    ],', '  },');
}
lines.push('};', '');
writeFileSync(FILES_MODULE, lines.join('\n'));
console.log(`wrote ${path.relative(ROOT, FILES_MODULE)}`);
