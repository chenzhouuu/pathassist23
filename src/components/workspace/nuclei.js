// src/components/workspace/nuclei.js — the nuclei artifact: its numbers, and how its mask is drawn.
//
// Was `panels/nucleiUtils.js` until Inc 6 · 05, when the Nuclei tab went. Its panel half — is a
// build running, what does its Stop button say, how far along is it — went with the tab, because
// a run is now a Girder job and the Runs list is where a job is watched. What is here is the
// artifact half, which has two readers and belongs to neither: `workspace/artifactDetail.js` turns
// it into the expanded row, and `viewer/ArtifactLayers.jsx` turns it into the mask on the slide.
// The Workspace is where it lives because the Workspace is what owns an artifact's presentation.
//
// Every number is read back from the stored artifact (summary + coverage), never carried over from
// the call that produced it. That is Inc 5's claim and it still holds: reload the page and the same
// numbers come back, because they were on disk, not in a variable.

export const PANNUKE_ORDER = Object.freeze([
  'Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial',
]);

/** How much of the slide the artifact covers, from its own coverage record. */
export function coverageSummary(meta) {
  const n = meta?.coverage?.n_tiles;
  if (!n) return null;
  const mm2 = Number(meta?.summary?.area_mm2);
  return { tiles: n, mm2: Number.isFinite(mm2) ? mm2 : null };
}

/**
 * The class histogram as rows, in PanNuke's own order, with the fraction of the total.
 * Classes the build found none of are omitted — a zero here would be a claim about biology that
 * the number cannot support at region scale.
 */
export function classRows(summary) {
  const counts = summary?.counts_by_class || {};
  const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  const named = PANNUKE_ORDER.filter((n) => counts[n]);
  const extra = Object.keys(counts).filter((n) => !PANNUKE_ORDER.includes(n) && counts[n]);
  return [...named, ...extra].map((name) => ({
    name,
    count: Number(counts[name]) || 0,
    fraction: total ? (Number(counts[name]) || 0) / total : 0,
  }));
}

export function totalNuclei(summary) {
  const n = Number(summary?.n_nuclei);
  return Number.isFinite(n) ? n : 0;
}

/** Area covered, as mm² with two decimals. '' when the slide never reported an mpp. */
export function formatArea(summary) {
  const a = Number(summary?.area_mm2);
  return Number.isFinite(a) && a > 0 ? `${a.toFixed(2)} mm²` : '';
}

export function formatCount(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '';
}

// ── the layer (Inc 5 · 06) ──────────────────────────────────────────────────────────
//
// How the mask is drawn, when nothing has said otherwise. In the store rather than in the panel,
// because the layer goes on rendering while the panel is closed — the right panel unmounts a panel
// on every tab switch. The store holds a patch; this is what it patches, so the defaults have
// exactly one home.
export const DEFAULT_OPACITY = 0.65;   // point-like and sparse — it can afford to be more solid
                                       // than the areal tissue map underneath it

// Two views over one raster: `classes` colours a nucleus by what it is, `instances` by which one
// it is. Same grid, same pyramid, same pixels — they are one array split by a lookup on the
// server, so switching is a URL change (Inc 5 · 08).
export const RENDERS = Object.freeze(['classes', 'instances']);
export const RENDER_LABEL = Object.freeze({ classes: 'Class', instances: 'Each cell' });

export const NUCLEI_LAYER_DEFAULTS = Object.freeze({
  render: 'classes',
  opacity: DEFAULT_OPACITY,
  hidden: Object.freeze({}),           // { [className]: true }
});

export function withNucleiDefaults(patch) {
  return { ...NUCLEI_LAYER_DEFAULTS, ...(patch || {}) };
}

/** The class list this artifact actually has — from its own meta, then PanNuke as a fallback. */
export function classesOf(meta) {
  const c = meta?.classes;
  return Array.isArray(c) && c.length ? c : [...PANNUKE_ORDER];
}

/** Class → '#rrggbb', from the artifact's own palette so a swatch can never drift from the map. */
export function colorsOf(meta) {
  return meta?.colors && Object.keys(meta.colors).length ? meta.colors : {};
}

/** Query params for a tile URL. Fixed key order: OSD caches by URL string. */
export function tileParams(render, { show, opacity, classes, rev } = {}) {
  const params = {};
  const all = classes || [];
  // The instance view has no class filter — its colours say which cell, not which kind, so
  // hiding a class there would remove cells without saying what they had in common.
  if (render !== 'instances' && show && all.length && show.length && show.length < all.length) {
    params.show = [...show].sort().join(',');
  }
  if (opacity != null && opacity !== 1) params.alpha = String(Math.round(opacity * 1000) / 1000);
  // How many cores the artifact covers. The worker ignores it; it is in the URL because a tile is
  // only immutable for a *given* coverage. Without it, the transparent tiles fetched before a
  // region was computed would stay in the browser's cache — a build that grew would keep showing
  // the emptiness it had when you first looked at it.
  if (Number.isFinite(Number(rev)) && Number(rev) > 0) params.rev = String(rev);
  return params;
}

export function layerSignature(render, artHash, params) {
  if (!artHash || !render) return 'none';
  const keys = Object.keys(params || {}).sort();
  return `nuclei|${render}|${artHash}|${keys.map((k) => `${k}=${params[k]}`).join('&')}`;
}

/** Stored tiles are at the nuclei store resolution; `level_offset` converts an OSD level to it. */
export function levelOffsetFor(meta, layer = 'classes') {
  const n = meta?.layers?.[layer]?.level_offset;
  return Number.isFinite(n) ? n : 0;
}

/** How many pyramid levels the artifact has. 0 means it has no picture yet — do not mount. */
export function layerLevels(meta, layer = 'classes') {
  const n = meta?.layers?.[layer]?.levels;
  return Number.isFinite(n) ? n : 0;
}

/** Whether this artifact carries the per-cell raster. Ones built before ticket 08 do not, until
 *  their next run redraws them — so the switch is offered only when there is something to show. */
export function hasInstances(meta) {
  return layerLevels(meta, 'instances') > 0;
}
