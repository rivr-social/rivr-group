/**
 * @fileoverview Pure static-site model + server-side generator for the GLOBAL
 * site builder (WS-B / B4).
 *
 * This is the canonical-shape port of the person app's bespoke site builder.
 * The person app stores a generated site as `SiteFiles = Record<string,string>`
 * (filename -> content) and snapshots them into `site_versions`
 * (`files_snapshot jsonb`). GLOBAL keeps that EXACT shape so the fleet stays
 * consistent and snapshots are interchangeable.
 *
 * Where the person builder generates files via an LLM chat, GLOBAL generates the
 * static HTML/CSS deterministically from the OWNER's Resources (REA model:
 * an owner agent owns posts/events/listings/etc. as `resources` rows). Because
 * the user has flagged heavy client bundles, ALL generation happens here —
 * server-side, dependency-free string building — and the output is plain static
 * files a host can serve directly.
 *
 * No database access and no Node-only APIs live in this module: the service/API
 * layers resolve the owner via `auth()`, load resources, and call
 * {@link buildSiteModel} to produce the files to snapshot/publish. Keeping the
 * generation pure makes it fully unit-testable.
 */

/**
 * Map of filename -> file content. Identical to the person app's
 * `SiteFiles` (`src/lib/bespoke/site-files.ts`) so snapshots are fleet-portable.
 */
export type SiteFiles = Record<string, string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical entry document a static host serves at the site root. */
export const INDEX_FILE = "index.html";
/** Canonical stylesheet filename referenced by every generated page. */
export const STYLE_FILE = "style.css";

/** Section ids the builder can render. Order here is the default page order. */
export const SITE_SECTION_IDS = [
  "hero",
  "about",
  "posts",
  "events",
  "offerings",
] as const;
export type SiteSectionId = (typeof SITE_SECTION_IDS)[number];

/**
 * Maps a section id to the `resources.type` values it sources from. `hero` and
 * `about` draw from the owner agent itself, not resources, so they map to [].
 */
const SECTION_RESOURCE_TYPES: Record<SiteSectionId, readonly string[]> = {
  hero: [],
  about: [],
  posts: ["post"],
  events: ["event"],
  offerings: ["offering", "listing", "service", "product"],
};

/** Human labels for sections (used as section headings). */
const SECTION_LABELS: Record<SiteSectionId, string> = {
  hero: "Welcome",
  about: "About",
  posts: "Posts",
  events: "Events",
  offerings: "Offerings",
};

/** Maximum resources rendered per section to keep the static page bounded. */
const MAX_ITEMS_PER_SECTION = 50;

/** Built-in theme token presets, mirroring the person bespoke profile presets. */
export const SITE_THEME_PRESETS = {
  default: { background: "#0b0b0f", foreground: "#f5f5f7", primary: "#6d5dfc", accent: "#22d3ee", border: "#26262e" },
  "red-gold": { background: "#1a0d0d", foreground: "#faf3e0", primary: "#c1121f", accent: "#e0a458", border: "#3a1f1f" },
  "forest-brass": { background: "#0e1a14", foreground: "#eef6f0", primary: "#2f6f4f", accent: "#c9a227", border: "#1d3327" },
  "earth-clay": { background: "#1c1410", foreground: "#f4ece2", primary: "#a4592d", accent: "#d8a25e", border: "#3a2a20" },
} as const;
export type SiteThemePreset = keyof typeof SITE_THEME_PRESETS;

/** Default theme preset applied when none is requested. */
export const DEFAULT_THEME_PRESET: SiteThemePreset = "default";

// ---------------------------------------------------------------------------
// Input types (loose, serializer-friendly shapes)
// ---------------------------------------------------------------------------

/** Minimal owner-agent shape the generator reads. */
export interface SiteOwner {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  image?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Minimal resource shape the generator reads (subset of SerializedResource). */
export interface SiteResource {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  content?: string | null;
  url?: string | null;
  createdAt?: string | null;
}

/** Options shaping which sections render and which theme is applied. */
export interface BuildSiteOptions {
  /** Sections to include, in order. Defaults to all known sections. */
  sections?: SiteSectionId[];
  /** Theme preset name. Unknown values fall back to {@link DEFAULT_THEME_PRESET}. */
  theme?: string;
  /** Optional override for the document title. Defaults to the owner name. */
  siteTitle?: string;
}

/** The resolved, validated model the generator renders from. */
export interface SiteModel {
  owner: SiteOwner;
  sections: ResolvedSection[];
  theme: SiteThemePreset;
  title: string;
}

/** One resolved section with the resources it will render. */
export interface ResolvedSection {
  id: SiteSectionId;
  label: string;
  items: SiteResource[];
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes a string for safe interpolation into HTML text/attribute context. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Resolves a requested theme name to a known preset, falling back to default. */
export function resolveThemePreset(theme: string | undefined): SiteThemePreset {
  if (theme && theme in SITE_THEME_PRESETS) return theme as SiteThemePreset;
  return DEFAULT_THEME_PRESET;
}

/**
 * Filters and validates requested section ids against the known set, preserving
 * the caller's order and de-duplicating. An empty/absent request yields the
 * full default section order.
 */
export function resolveSectionIds(requested: SiteSectionId[] | undefined): SiteSectionId[] {
  if (!requested || requested.length === 0) return [...SITE_SECTION_IDS];
  const known = new Set<string>(SITE_SECTION_IDS);
  const seen = new Set<string>();
  const out: SiteSectionId[] = [];
  for (const id of requested) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.length > 0 ? out : [...SITE_SECTION_IDS];
}

/**
 * Resolves the validated {@link SiteModel} from an owner, its resources, and
 * build options. Pure: groups resources into sections by type, caps each
 * section, and sorts newest-first when timestamps are present.
 *
 * @throws {Error} When `owner` is missing an id (the model has no subject).
 */
export function resolveSiteModel(
  owner: SiteOwner,
  resources: SiteResource[],
  options: BuildSiteOptions = {},
): SiteModel {
  if (!owner || !owner.id) {
    throw new Error("resolveSiteModel: owner with an id is required");
  }

  const sectionIds = resolveSectionIds(options.sections);
  const theme = resolveThemePreset(options.theme);
  const title = (options.siteTitle?.trim() || owner.name || "Untitled Site").trim();

  const sections: ResolvedSection[] = sectionIds.map((id) => {
    const types = SECTION_RESOURCE_TYPES[id];
    let items: SiteResource[] = [];
    if (types.length > 0) {
      const typeSet = new Set(types);
      items = resources
        .filter((resource) => typeSet.has((resource.type ?? "").toLowerCase()))
        .sort((a, b) => sortByCreatedDesc(a, b))
        .slice(0, MAX_ITEMS_PER_SECTION);
    }
    return { id, label: SECTION_LABELS[id], items };
  });

  return { owner, sections, theme, title };
}

/** Newest-first comparator tolerant of missing/unparseable timestamps. */
function sortByCreatedDesc(a: SiteResource, b: SiteResource): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  const av = Number.isNaN(at) ? 0 : at;
  const bv = Number.isNaN(bt) ? 0 : bt;
  return bv - av;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Reads a string-valued key from the owner metadata bag, or "" when absent. */
function metaString(owner: SiteOwner, key: string): string {
  const value = owner.metadata?.[key];
  return typeof value === "string" ? value : "";
}

/** Renders the stylesheet from the resolved theme tokens. */
export function renderStylesheet(model: SiteModel): string {
  const tokens = SITE_THEME_PRESETS[model.theme];
  return `:root {
  --bg: ${tokens.background};
  --fg: ${tokens.foreground};
  --primary: ${tokens.primary};
  --accent: ${tokens.accent};
  --border: ${tokens.border};
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
}
a { color: var(--accent); }
.site-wrap { max-width: 880px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.hero { padding: 3rem 0 2rem; border-bottom: 1px solid var(--border); }
.hero h1 { font-size: 2.5rem; color: var(--primary); }
.hero p { margin-top: 0.75rem; opacity: 0.85; }
.hero img.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border); margin-bottom: 1rem; }
section.site-section { padding: 2rem 0; border-bottom: 1px solid var(--border); }
section.site-section > h2 { font-size: 1.5rem; margin-bottom: 1rem; color: var(--primary); }
.item-card { border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
.item-card h3 { font-size: 1.125rem; margin-bottom: 0.25rem; }
.item-card .meta { font-size: 0.8rem; opacity: 0.6; }
.empty { opacity: 0.5; font-style: italic; }
footer.site-footer { padding-top: 2rem; font-size: 0.8rem; opacity: 0.6; }
`;
}

/** Renders the hero section markup from the owner. */
function renderHero(model: SiteModel): string {
  const { owner } = model;
  const tagline = (owner.description ?? metaString(owner, "bio")).trim();
  const avatar = (owner.image ?? metaString(owner, "profilePhoto")).trim();
  const avatarHtml = avatar ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(owner.name)}" />` : "";
  return `<section class="hero">
  ${avatarHtml}
  <h1>${escapeHtml(model.title)}</h1>
  ${tagline ? `<p>${escapeHtml(tagline)}</p>` : ""}
</section>`;
}

/** Renders the about section markup from the owner. */
function renderAbout(model: SiteModel): string {
  const { owner } = model;
  const about = (owner.description ?? metaString(owner, "bio") ?? metaString(owner, "about")).trim();
  const body = about ? `<p>${escapeHtml(about)}</p>` : `<p class="empty">No description yet.</p>`;
  return `<section class="site-section" id="about">
  <h2>${escapeHtml(SECTION_LABELS.about)}</h2>
  ${body}
</section>`;
}

/** Renders one resource as a card. */
function renderItemCard(item: SiteResource): string {
  const desc = (item.description ?? item.content ?? "").trim();
  const created = item.createdAt ? new Date(item.createdAt) : null;
  const dateLabel = created && !Number.isNaN(created.getTime()) ? created.toISOString().slice(0, 10) : "";
  const titleHtml = item.url
    ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.name)}</a>`
    : escapeHtml(item.name);
  return `<article class="item-card">
    <h3>${titleHtml}</h3>
    ${desc ? `<p>${escapeHtml(desc)}</p>` : ""}
    ${dateLabel ? `<p class="meta">${escapeHtml(dateLabel)}</p>` : ""}
  </article>`;
}

/** Renders a resource-backed section (posts/events/offerings). */
function renderResourceSection(section: ResolvedSection): string {
  const cards = section.items.length
    ? section.items.map(renderItemCard).join("\n    ")
    : `<p class="empty">Nothing here yet.</p>`;
  return `<section class="site-section" id="${escapeHtml(section.id)}">
  <h2>${escapeHtml(section.label)}</h2>
    ${cards}
</section>`;
}

/** Dispatches one resolved section to its renderer. */
function renderSection(model: SiteModel, section: ResolvedSection): string {
  switch (section.id) {
    case "hero":
      return renderHero(model);
    case "about":
      return renderAbout(model);
    default:
      return renderResourceSection(section);
  }
}

/**
 * Generates the full static site (`index.html` + `style.css`) from an owner and
 * its resources. Returns the fleet-portable {@link SiteFiles} map that the
 * service layer snapshots into `site_versions.files_snapshot`.
 *
 * @throws {Error} When the owner is invalid (propagated from {@link resolveSiteModel}).
 */
export function buildSiteFiles(
  owner: SiteOwner,
  resources: SiteResource[],
  options: BuildSiteOptions = {},
): SiteFiles {
  const model = resolveSiteModel(owner, resources, options);

  const sectionsHtml = model.sections.map((section) => renderSection(model, section)).join("\n");
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(model.title)}</title>
  <meta name="description" content="${escapeHtml((model.owner.description ?? "").slice(0, 200))}" />
  <link rel="stylesheet" href="${STYLE_FILE}" />
</head>
<body>
  <main class="site-wrap">
${sectionsHtml}
    <footer class="site-footer">
      <p>${escapeHtml(model.title)} &middot; Published with RIVR &middot; ${year}</p>
    </footer>
  </main>
</body>
</html>
`;

  return {
    [INDEX_FILE]: html,
    [STYLE_FILE]: renderStylesheet(model),
  };
}

/** Stable count of files for logging/telemetry without leaking content. */
export function fileCount(files: SiteFiles): number {
  return Object.keys(files).length;
}
