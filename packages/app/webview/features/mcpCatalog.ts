// Settings > MCP > Catalog: Orka's bundled list of MCP servers (no network while browsing), with
// search, a category filter, details (what it does, what it needs, the exact command or URL) and
// Add. Add opens a form for the entry's fields when it has any; the app then shows the consent
// dialog and writes the server. The page sends only the entry's id and the field values.
import { t } from '@orka/core/src/i18n';
import {
  catalogAvailable,
  catalogTarget,
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
  type McpCatalogCategory,
  type McpCatalogEntry,
  type McpCatalogField,
} from '@orka/core/src/mcp/catalog';
import type { McpServerView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

export interface CatalogState {
  query: string;
  /** '' for every category. */
  category: string;
  /** Entries whose details are open. */
  open: Set<string>;
}

export function categoryLabel(category: McpCatalogCategory): string {
  switch (category) {
    case 'game-dev':
      return t('Game development');
    case 'browser':
      return t('Browser');
    case 'source-control':
      return t('Source control');
    case 'issues':
      return t('Issues and projects');
    case 'databases':
      return t('Databases');
    case 'cloud':
      return t('Cloud and infrastructure');
    case 'design':
      return t('Design');
    case 'docs-search':
      return t('Docs and search');
    case 'files-system':
      return t('Files and system');
    case 'ai-tools':
      return t('AI tools');
    case 'productivity':
      return t('Productivity');
    default:
      return t('Other');
  }
}

function statusLabel(status: McpCatalogEntry['status']): string {
  return status === 'experimental' ? t('Experimental') : status === 'preview' ? t('Preview') : status === 'archived' ? t('Archived') : '';
}

function platformsLabel(entry: McpCatalogEntry): string {
  if (entry.platforms === 'any') return t('Hosted: works from any system');
  const names: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  return entry.platforms.map((p) => names[p]).join(', ');
}

/** Lowercase and without accents, so "ı", "İ" and "e" match the way people type them. */
function fold(text: string): string {
  return text.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** The entries that match the search and the category; archived ones last. */
export function filterCatalog(state: CatalogState): McpCatalogEntry[] {
  const words = fold(state.query).split(/\s+/).filter(Boolean);
  return MCP_CATALOG.filter((e) => !state.category || e.category === state.category)
    .filter((e) => {
      if (!words.length) return true;
      const text = fold([e.id, e.name, e.vendor, e.description, t(e.description), categoryLabel(e.category)].join(' '));
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived'));
}

/** The servers in the user's list that came from each entry. */
export function addedEntries(servers: readonly McpServerView[]): Map<string, string[]> {
  const added = new Map<string, string[]>();
  for (const s of servers) if (s.catalogId) added.set(s.catalogId, [...(added.get(s.catalogId) ?? []), s.name]);
  return added;
}

/** The search box and the category filter, above the list (which is rebuilt on its own while typing). */
export function catalogHtml(state: CatalogState, servers: readonly McpServerView[], platform: string): string {
  const categories = MCP_CATALOG_CATEGORIES.filter((c) => MCP_CATALOG.some((e) => e.category === c));
  return `
    <div class="card catalog-head">
      <div class="catalog-filters">
        <label class="catalog-search">${icon('search')}<input id="mcp-catalog-search" type="search" value="${attr(state.query)}" placeholder="${attr(
          t('Search the catalog'),
        )}" aria-label="${attr(t('Search the catalog'))}" spellcheck="false" autocomplete="off"></label>
        <select id="mcp-catalog-category" aria-label="${attr(t('Category'))}">
          <option value="">${escapeHtml(t('All categories'))}</option>
          ${categories.map((c) => `<option value="${attr(c)}"${state.category === c ? ' selected' : ''}>${escapeHtml(categoryLabel(c))}</option>`).join('')}
        </select>
      </div>
      <div class="muted small">${escapeHtml(
        t('The catalog comes with Orka: browsing it uses no network. Each server is made by its publisher, not by Orka; read what it runs before you add it.'),
      )}</div>
    </div>
    <div class="card skills-list catalog-list" id="mcp-catalog-list">${catalogListHtml(state, servers, platform)}</div>`;
}

export function catalogListHtml(state: CatalogState, servers: readonly McpServerView[], platform: string): string {
  const entries = filterCatalog(state);
  if (!entries.length) return `<p class="footnote">${escapeHtml(t('No servers match.'))}</p>`;
  const added = addedEntries(servers);
  return entries.map((e) => entryHtml(e, state.open.has(e.id), added.get(e.id), platform)).join('');
}

function entryHtml(e: McpCatalogEntry, open: boolean, addedAs: string[] | undefined, platform: string): string {
  const available = !platform || catalogAvailable(e, platform);
  const badge = e.publisher === 'official' ? `<span class="tag ok" title="${attr(e.vendor)}">${escapeHtml(t('Official'))}</span>` : `<span class="tag" title="${attr(e.vendor)}">${escapeHtml(t('Community'))}</span>`;
  const status = e.status ? `<span class="tag warn">${escapeHtml(statusLabel(e.status))}</span>` : '';
  const action = addedAs
    ? `<span class="pill ok" title="${attr(addedAs.join(', '))}"><span class="pill-dot"></span>${escapeHtml(t('Added'))}</span>`
    : available
      ? `<button class="btn primary small" data-action="catalog-add" data-id="${attr(e.id)}">${icon('plus')}${escapeHtml(t('Add'))}</button>`
      : `<span class="pill" title="${attr(platformsLabel(e))}">${escapeHtml(t('Not for this system'))}</span>`;
  const details = open ? detailsHtml(e, platform) : '';
  return `<div class="skill-row catalog-row${e.status === 'archived' ? ' off' : ''}" data-entry="${attr(e.id)}">
    <div class="skill-head">
      <strong>${escapeHtml(e.name)}</strong>${badge}${status}<span class="tag">${escapeHtml(e.transport)}</span>
      <span class="spacer"></span>${action}
    </div>
    <div class="muted small">${escapeHtml(e.vendor)} · ${escapeHtml(e.license ?? t('Licence not stated'))} · ${escapeHtml(categoryLabel(e.category))}</div>
    <div class="small">${escapeHtml(t(e.description))}</div>
    <div><button class="link" data-action="catalog-details" data-id="${attr(e.id)}" aria-expanded="${open}">${escapeHtml(open ? t('Hide details') : t('Details'))}</button></div>
    ${details}
  </div>`;
}

function detailsHtml(e: McpCatalogEntry, platform: string): string {
  const target = catalogTarget(e, platform);
  const list = (items: string[], translate = true) => `<ul class="catalog-points">${items.map((i) => `<li>${escapeHtml(translate ? t(i) : i)}</li>`).join('')}</ul>`;
  const fields = e.fields.length
    ? `<div class="field"><span class="field-label">${escapeHtml(t('You enter'))}</span>${list(
        e.fields.map((f) => `${f.name}${f.secret ? ` (${t('secret')})` : ''}${f.required || f.target === 'arg' ? '' : ` (${t('optional')})`}`),
        false,
      )}</div>`
    : '';
  return `<div class="catalog-details">
    ${e.setup ? setupHtml(e) : ''}
    ${e.prerequisites.length ? `<div class="field"><span class="field-label">${escapeHtml(t('Prerequisites'))}</span>${list(e.prerequisites)}</div>` : ''}
    <div class="field"><span class="field-label">${escapeHtml(e.transport === 'http' ? t('Address') : t('Command'))}</span><code class="mono account-command">${escapeHtml(target)}</code></div>
    ${fields}
    ${e.notes?.length ? `<div class="field"><span class="field-label">${escapeHtml(t('Notes'))}</span>${list(e.notes)}</div>` : ''}
    <div class="muted small">${escapeHtml(t('Works on: {platforms}', { platforms: platformsLabel(e) }))}</div>
    <div><button class="link" data-action="catalog-link" data-id="${attr(e.id)}" data-link="homepage">${escapeHtml(t('Open the publisher’s page'))}</button></div>
  </div>`;
}

/** A step in another program first (a Unity package, an editor plugin), with its page. */
function setupHtml(e: McpCatalogEntry): string {
  return `<div class="hint">${icon('info')}<span>${escapeHtml(t(e.setup!.text))}</span><button class="link" data-action="catalog-link" data-id="${attr(e.id)}" data-link="setup">${escapeHtml(
    t('How'),
  )}</button></div>`;
}

/** The Add form: one input per field (secrets as password fields), then Continue to the app's consent dialog. */
export function catalogFormHtml(e: McpCatalogEntry, missing: readonly string[] = []): string {
  const input = (f: McpCatalogField) => {
    const id = `catalog-field-${f.name}`;
    const required = f.required || f.target === 'arg';
    const link = f.link
      ? `<button class="link" type="button" data-action="catalog-link" data-id="${attr(e.id)}" data-link="field" data-field="${attr(f.name)}">${escapeHtml(t('Where to get it'))}</button>`
      : '';
    return `<div class="field">
      <label class="field-label" for="${attr(id)}"><span class="mono">${escapeHtml(f.name)}</span> · ${escapeHtml(required ? t('required') : t('optional'))}${f.secret ? ` · ${escapeHtml(t('secret'))}` : ''}</label>
      <input id="${attr(id)}" type="${f.secret ? 'password' : 'text'}" data-catalog-field="${attr(f.name)}" value="${attr(f.secret ? '' : (f.default ?? ''))}" autocomplete="off" spellcheck="false"${
        missing.includes(f.name) ? ' aria-invalid="true" class="warn"' : ''
      }>
      <span class="muted small">${escapeHtml(t(f.help))} ${link}</span>
    </div>`;
  };
  const secrets = e.fields.some((f) => f.secret);
  return `<div class="dialog modal catalog-form" role="dialog" aria-label="${attr(t('Add {name}', { name: e.name }))}">
    <strong class="dialog-title">${escapeHtml(t('Add {name}', { name: e.name }))}</strong>
    ${e.setup ? setupHtml(e) : ''}
    ${e.fields.map(input).join('')}
    ${missing.length ? `<div class="hint warn">${icon('warn')}<span>${escapeHtml(t('Fill in the required fields.'))}</span></div>` : ''}
    ${secrets ? `<span class="muted small">${escapeHtml(t('Secret values are stored in your Orka settings file, passed only to this server, and never shown again.'))}</span>` : ''}
    <div class="dialog-actions">
      <button class="btn primary" type="button" data-action="catalog-form-submit" data-id="${attr(e.id)}">${escapeHtml(t('Continue'))}</button>
      <button class="btn" type="button" data-action="catalog-form-close">${escapeHtml(t('Cancel'))}</button>
    </div>
  </div>`;
}

/** The required fields left empty in the open form. */
export function missingFields(e: McpCatalogEntry, values: Readonly<Record<string, string>>): string[] {
  return e.fields.filter((f) => (f.required || f.target === 'arg') && !values[f.name]?.trim()).map((f) => f.name);
}
