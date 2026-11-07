// Settings > Skills > Gallery: skills the user can add to their own skills folder (browsing uses no
// network). Search, a category and a licence filter, details (what it needs, its licence, notes),
// a preview of the text for the ones that come with Orka, and Enable / Install. The app does the
// work: a bundled skill is copied from Orka's files, a downloadable one is fetched only after a
// consent dialog that shows every URL. The page sends only the entry's id.
import { t } from '@orka/core/src/i18n';
import { licenseName, openLicense, SKILL_GALLERY, SKILL_GALLERY_CATEGORIES, type SkillGalleryCategory, type SkillGalleryEntry } from '@orka/core/src/skills/gallery';
import type { SkillView } from '../../src/protocol';
import { attr, escapeHtml, icon } from '../core/dom';

export interface GalleryState {
  query: string;
  /** '' for every category. */
  category: string;
  /** '' every licence, 'open' MIT/Apache and similar, 'other' everything else. */
  license: '' | 'open' | 'other';
  /** Entries whose details are open. */
  open: Set<string>;
}

export function galleryCategoryLabel(category: SkillGalleryCategory): string {
  switch (category) {
    case 'game-dev':
      return t('Game development');
    case 'code-quality':
      return t('Code quality');
    case 'testing':
      return t('Testing');
    case 'workflow':
      return t('Workflow');
    case 'design':
      return t('Design and UI');
    case 'documents':
      return t('Documents');
    case 'writing':
      return t('Writing');
    case 'backend':
      return t('Backend and data');
    case 'devops':
      return t('DevOps');
    case 'security':
      return t('Security');
    default:
      return t('Other');
  }
}

/** "NOASSERTION" and LicenseRef ids read as words. */
export function licenseLabel(license: string): string {
  return licenseName(license);
}

/** Lowercase and without accents, so "ı", "İ" and "e" match the way people type them. */
function fold(text: string): string {
  return text.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** The entries that match the search and the filters; the ones that come with Orka first. */
export function filterGallery(state: GalleryState): SkillGalleryEntry[] {
  const words = fold(state.query).split(/\s+/).filter(Boolean);
  return SKILL_GALLERY.filter((e) => !state.category || e.category === state.category)
    .filter((e) => !state.license || (state.license === 'open') === openLicense(e.license))
    .filter((e) => {
      if (!words.length) return true;
      const text = fold([e.id, e.name, e.author, e.description, t(e.description), galleryCategoryLabel(e.category), e.license].join(' '));
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => Number(a.kind === 'source') - Number(b.kind === 'source'));
}

/** The user's skills installed from each entry, and the names their own skills already use. */
export function installedEntries(skills: readonly SkillView[]): { installed: Map<string, string>; taken: Set<string> } {
  const installed = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of skills) {
    if (s.source !== 'user') continue;
    if (s.origin) installed.set(s.origin.id, s.name);
    else taken.add(s.name);
  }
  return { installed, taken };
}

/** The search box and the filters, above the list (which is rebuilt on its own while typing). */
export function galleryHtml(state: GalleryState, skills: readonly SkillView[]): string {
  const categories = SKILL_GALLERY_CATEGORIES.filter((c) => SKILL_GALLERY.some((e) => e.category === c));
  const licence = (value: GalleryState['license'], label: string) => `<option value="${value}"${state.license === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  return `
    <div class="card catalog-head">
      <div class="catalog-filters">
        <label class="catalog-search">${icon('search')}<input id="skill-gallery-search" type="search" value="${attr(state.query)}" placeholder="${attr(
          t('Search the gallery'),
        )}" aria-label="${attr(t('Search the gallery'))}" spellcheck="false" autocomplete="off"></label>
        <select id="skill-gallery-category" aria-label="${attr(t('Category'))}">
          <option value="">${escapeHtml(t('All categories'))}</option>
          ${categories.map((c) => `<option value="${attr(c)}"${state.category === c ? ' selected' : ''}>${escapeHtml(galleryCategoryLabel(c))}</option>`).join('')}
        </select>
        <select id="skill-gallery-license" aria-label="${attr(t('Licence'))}">
          ${licence('', t('All licences'))}${licence('open', t('Open licences (MIT, Apache…)'))}${licence('other', t('Other terms'))}
        </select>
      </div>
      <div class="muted small">${escapeHtml(
        t('The gallery comes with Orka: browsing it uses no network. "Included" skills are copied from Orka; "From GitHub" skills are downloaded only after you see every address. Skills are not always on: add the ones you want.'),
      )}</div>
    </div>
    <div class="card skills-list catalog-list" id="skill-gallery-list">${galleryListHtml(state, skills)}</div>`;
}

export function galleryListHtml(state: GalleryState, skills: readonly SkillView[]): string {
  const entries = filterGallery(state);
  if (!entries.length) return `<p class="footnote">${escapeHtml(t('No skills match.'))}</p>`;
  const { installed, taken } = installedEntries(skills);
  return entries.map((e) => entryHtml(e, state.open.has(e.id), installed.get(e.id), taken.has(e.id))).join('');
}

function entryHtml(e: SkillGalleryEntry, open: boolean, installedAs: string | undefined, taken: boolean): string {
  const kind =
    e.kind === 'bundled'
      ? `<span class="tag ok" title="${attr(t('Comes with Orka; nothing is downloaded'))}">${escapeHtml(t('Included'))}</span>`
      : `<span class="tag" title="${attr(t('Downloaded from GitHub after you agree'))}">${escapeHtml(t('From GitHub'))}</span>`;
  const terms = openLicense(e.license) ? '' : `<span class="tag warn" title="${attr(e.licenseNote ? t(e.licenseNote) : '')}">${escapeHtml(t('Licence terms'))}</span>`;
  const action = installedAs
    ? `<span class="pill ok"><span class="pill-dot"></span>${escapeHtml(t('Installed'))}</span><button class="link" data-action="gallery-remove" data-name="${attr(installedAs)}">${escapeHtml(t('Remove'))}</button>`
    : taken
      ? `<span class="pill" title="${attr(t('A skill of yours already has this name'))}">${escapeHtml(t('Name in use'))}</span>`
      : `<button class="btn primary small" data-action="gallery-install" data-id="${attr(e.id)}">${icon(e.kind === 'bundled' ? 'plus' : 'arrowDown')}${escapeHtml(
          e.kind === 'bundled' ? t('Enable') : t('Install'),
        )}</button>`;
  return `<div class="skill-row catalog-row" data-entry="${attr(e.id)}">
    <div class="skill-head">
      <strong>${escapeHtml(e.name)}</strong><span class="mono muted small">/${escapeHtml(e.id)}</span>${kind}${terms}
      <span class="spacer"></span>${action}
    </div>
    <div class="muted small">${escapeHtml(e.author === 'Orka' ? t('Written for Orka') : e.author)} · ${escapeHtml(licenseLabel(e.license))} · ${escapeHtml(galleryCategoryLabel(e.category))}</div>
    <div class="small">${escapeHtml(t(e.description))}</div>
    <div class="key-row">
      <button class="link" data-action="gallery-details" data-id="${attr(e.id)}" aria-expanded="${open}">${escapeHtml(open ? t('Hide details') : t('Details'))}</button>
      ${e.kind === 'bundled' ? `<button class="link" data-action="gallery-preview" data-id="${attr(e.id)}">${escapeHtml(t('Preview'))}</button>` : ''}
    </div>
    ${open ? detailsHtml(e) : ''}
  </div>`;
}

function detailsHtml(e: SkillGalleryEntry): string {
  const list = (items: string[]) => `<ul class="catalog-points">${items.map((i) => `<li>${escapeHtml(t(i))}</li>`).join('')}</ul>`;
  return `<div class="catalog-details">
    ${e.licenseNote ? `<div class="hint warn">${icon('warn')}<span>${escapeHtml(t(e.licenseNote))}</span></div>` : ''}
    <div class="field"><span class="field-label">${escapeHtml(t('Needs'))}</span>${list(e.needs)}</div>
    ${e.notes?.length ? `<div class="field"><span class="field-label">${escapeHtml(t('Notes'))}</span>${list(e.notes)}</div>` : ''}
    <div class="muted small">${escapeHtml(
      e.kind === 'bundled'
        ? t('Enable copies it, with its licence and NOTICE, into your skills folder.')
        : t('Install downloads its files from GitHub at a fixed commit into your skills folder. Orka never runs its scripts.'),
    )}</div>
    <div><button class="link" data-action="gallery-source" data-id="${attr(e.id)}">${escapeHtml(t('Open its source page'))}</button></div>
  </div>`;
}

/** The preview dialog: the skill's text, escaped, as it comes with Orka. */
export function galleryPreviewHtml(e: SkillGalleryEntry, text: string | undefined): string {
  return `<div class="dialog modal skill-preview" role="dialog" aria-label="${attr(e.name)}">
    <strong class="dialog-title">${escapeHtml(e.name)}</strong>
    <span class="muted small">${escapeHtml(e.author === 'Orka' ? t('Written for Orka') : e.author)} · ${escapeHtml(licenseLabel(e.license))}</span>
    ${text === undefined ? `<div class="muted small"><span class="spinner small"></span> ${escapeHtml(t('Loading…'))}</div>` : `<pre class="skill-preview-text">${escapeHtml(text)}</pre>`}
    <div class="dialog-actions">
      <button class="btn" type="button" data-action="gallery-preview-close">${escapeHtml(t('Close'))}</button>
    </div>
  </div>`;
}

/** Where an installed skill came from, for its row in My skills. */
export function originLabel(origin: NonNullable<SkillView['origin']>): string {
  const where = origin.kind === 'bundled' ? t('gallery (included)') : origin.repo ? `${origin.repo}${origin.ref ? `@${origin.ref}` : ''}` : t('gallery (download)');
  return `${where} · ${licenseLabel(origin.license)}`;
}
