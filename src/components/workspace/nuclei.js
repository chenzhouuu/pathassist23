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
//
// **Inc 7: one artifact, several namings.** The outlines are shared; the classes are not. So every
// function that used to take `meta` and answer about "the" classes now takes a taxonomy id too,
// and the class list, the colours, the counts and the *coverage* all come from that taxonomy's
// entry in meta. A naming reaches the cores it has been run over, which can be fewer than the ones
// with outlines — reporting its counts against the artifact's tile list would be a count over an
// area the reader assumes is bigger than it is.

/** PanNuke's order, kept as the fallback for an artifact whose meta predates the taxonomy list. */
export const PANNUKE_ORDER = Object.freeze([
  'Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial',
]);

export const DEFAULT_TAXONOMY = 'pannuke';

/** Every naming this artifact has, in the order the service listed them (PanNuke first). */
export function taxonomiesOf(meta) {
  const list = meta?.taxonomies;
  return Array.isArray(list) ? list : [];
}

/** One naming's entry, falling back to the default and then to nothing at all. */
export function taxonomyOf(meta, taxonomy) {
  const list = taxonomiesOf(meta);
  return list.find((t) => t.id === (taxonomy || DEFAULT_TAXONOMY))
    || list.find((t) => t.id === DEFAULT_TAXONOMY)
    || null;
}

/** The id actually in use — what was asked for if the artifact has it, else what it does have. */
export function resolveTaxonomy(meta, taxonomy) {
  return taxonomyOf(meta, taxonomy)?.id || DEFAULT_TAXONOMY;
}

/**
 * How much of the slide *this naming* covers.
 *
 * The taxonomy's own tile count and its own area, not the artifact's. They are usually the same
 * number and the case where they are not is the one worth being right about: a region segmented
 * after a classify run has outlines nobody has named.
 */
export function coverageSummary(meta, taxonomy) {
  const entry = taxonomyOf(meta, taxonomy);
  const n = entry?.coverage?.n_tiles;
  if (!n) return null;
  // `area_mm2` is null when the slide never reported an mpp, and `Number(null)` is 0 — which would
  // turn "this cannot be measured" into "it measures nothing".
  const raw = entry?.summary?.area_mm2;
  const mm2 = raw == null ? NaN : Number(raw);
  return { tiles: n, mm2: Number.isFinite(mm2) ? mm2 : null };
}

/** How many cores have outlines — the number a naming's coverage is measured against. */
export function outlineTiles(meta) {
  const n = Number(meta?.coverage?.n_tiles);
  return Number.isFinite(n) ? n : 0;
}

/** Cores with outlines that this naming has not reached. 0 when it is caught up. */
export function unlabelledTiles(meta, taxonomy) {
  const entry = taxonomyOf(meta, taxonomy);
  return Math.max(0, outlineTiles(meta) - (Number(entry?.coverage?.n_tiles) || 0));
}

/** This naming's stored summary — counts, total, area — or an empty one. */
export function summaryOf(meta, taxonomy) {
  return taxonomyOf(meta, taxonomy)?.summary || {};
}

/**
 * The class histogram as rows, in the taxonomy's own order, with the fraction of the total.
 * Classes the run found none of are omitted — a zero here would be a claim about biology that the
 * number cannot support at region scale.
 */
export function classRows(meta, taxonomy) {
  const counts = summaryOf(meta, taxonomy)?.counts_by_class || {};
  const order = classesOf(meta, taxonomy);
  const display = taxonomyOf(meta, taxonomy)?.display || {};
  const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  const named = order.filter((n) => counts[n]);
  const extra = Object.keys(counts).filter((n) => !order.includes(n) && counts[n]);
  return [...named, ...extra].map((name) => ({
    name,
    // The stored name is the key everything else in the row is looked up by; the readable one is
    // for the eye. Keeping them apart is what lets `nonTILnonMQ_stromal` read as a sentence
    // without a hidden-class toggle keying on a string that could be re-worded.
    label: display[name] || name,
    count: Number(counts[name]) || 0,
    fraction: total ? (Number(counts[name]) || 0) / total : 0,
  }));
}

export function totalNuclei(meta, taxonomy) {
  const n = Number(summaryOf(meta, taxonomy)?.n_nuclei);
  return Number.isFinite(n) ? n : 0;
}

/** Area covered, as mm² with two decimals. '' when the slide never reported an mpp. */
export function formatArea(meta, taxonomy) {
  const a = Number(summaryOf(meta, taxonomy)?.area_mm2);
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
  // Which naming is drawn. PanNuke because it is the one every artifact has — segmentation
  // produces it, so there is no state in which this default points at nothing.
  taxonomy: DEFAULT_TAXONOMY,
  // Per taxonomy: a class name hidden in one naming is not a class name in another, and one flat
  // map would have `Other` hide three unrelated things at once.
  hidden: Object.freeze({}),           // { [taxonomy]: { [className]: true } }
});

export function withNucleiDefaults(patch) {
  return { ...NUCLEI_LAYER_DEFAULTS, ...(patch || {}) };
}

/** What is hidden in one naming. Always an object, so a caller never guards for it. */
export function hiddenIn(layer, taxonomy) {
  return layer?.hidden?.[taxonomy || DEFAULT_TAXONOMY] || {};
}

/** The class list this naming has — from the artifact's own meta, then PanNuke as a fallback. */
export function classesOf(meta, taxonomy) {
  const c = taxonomyOf(meta, taxonomy)?.classes;
  return Array.isArray(c) && c.length ? c : [...PANNUKE_ORDER];
}

/** Class → '#rrggbb', from the artifact's own palette so a swatch can never drift from the map. */
export function colorsOf(meta, taxonomy) {
  const c = taxonomyOf(meta, taxonomy)?.colors;
  return c && Object.keys(c).length ? c : {};
}

/** Query params for a tile URL. Fixed key order: OSD caches by URL string. */
export function tileParams(render, { show, opacity, classes, rev, taxonomy } = {}) {
  const params = {};
  const all = classes || [];
  // The instance view has no class filter — its colours say which cell, not which kind, so
  // hiding a class there would remove cells without saying what they had in common. It has no
  // taxonomy either: an outline is an outline whatever it is called.
  if (render !== 'instances') {
    if (taxonomy && taxonomy !== DEFAULT_TAXONOMY) params.taxonomy = taxonomy;
    if (show && all.length && show.length && show.length < all.length) {
      params.show = [...show].sort().join(',');
    }
  }
  if (opacity != null && opacity !== 1) params.alpha = String(Math.round(opacity * 1000) / 1000);
  // How many cores this naming covers. The worker ignores it; it is in the URL because a tile is
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
