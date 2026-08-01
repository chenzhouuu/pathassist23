// src/components/panels/nucleiUtils.js — what the Nuclei panel reports, as pure functions.
//
// Every number here is read back from the stored artifact (summary + coverage), never carried over
// from the call that produced it. That is the ticket's claim: reload the page and the same numbers
// come back, because they were on disk, not in a variable.

export const PANNUKE_ORDER = Object.freeze([
  'Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial',
]);

export function findNucleiRow(rows = []) {
  return rows.find((r) => r.kind === 'nuclei') || null;
}

export function isRunning(row) {
  return !!row && (row.status === 'queued' || row.status === 'running');
}

/** A build was stopped part-way and can be picked up again — coverage makes resuming free. */
export function isStopped(row) {
  return row?.status === 'cancelled';
}

/** Asked to stop, still finishing its core. Not stoppable again, and not stopped yet. */
export function isStopping(row) {
  return isRunning(row) && row.stage === 'stopping';
}

export function canStop(row) {
  return isRunning(row) && !!row.job_id && row.stage !== 'stopping';
}

/** The segmentation a whole-slide run needs to know where the tissue is. */
export function findReadySegmentation(rows = []) {
  return rows.find((r) => r.kind === 'segmentation' && r.status === 'ready') || null;
}

/** A resumable build labels its start button honestly. */
export function startLabel(row, whole) {
  if (!whole) return 'Run on region';
  return isStopped(row) ? 'Resume whole slide' : 'Run on whole slide';
}

export function progressPercent(row) {
  const p = Number(row?.progress);
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

const STAGE_WORDS = { nuclei: 'Segmenting', raster: 'Drawing', starting: 'Starting' };

/** What the build is doing, in the words the panel shows. */
export function describeStage(row) {
  if (!row) return 'Not built';
  if (row.status === 'ready') return 'Ready';
  if (row.status === 'failed') return `Failed — ${row.error || 'unknown error'}`;
  // A stopped build is not a failed one: it holds a complete artifact of a smaller area, so it
  // says what it covered and what is left rather than reporting an error.
  if (isStopped(row)) {
    const left = row.result?.remaining;
    const covered = formatCount(row.result?.n_nuclei ?? row.n_items);
    const where = covered ? `${covered} nuclei` : 'part of the slide';
    return left ? `Stopped — ${where}, ${left} tiles left` : `Stopped — ${where}`;
  }
  if (isStopping(row)) return 'Stopping — finishing the current tile';
  if (isRunning(row)) return `${STAGE_WORDS[row.stage] || 'Working'} ${progressPercent(row)}%`;
  return row.status || 'Unknown';
}

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

export function formatPercent(f) {
  const v = Number(f);
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
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

/** The one-line summary, the same shape the Workspace row shows. '' before anything is stored. */
export function summaryLine(summary) {
  const bits = [];
  const n = totalNuclei(summary);
  if (n) bits.push(`${formatCount(n)} ${n === 1 ? 'nucleus' : 'nuclei'}`);
  const area = formatArea(summary);
  if (area) bits.push(area);
  const tiles = Number(summary?.n_tiles);
  if (Number.isFinite(tiles) && tiles > 0) bits.push(`${tiles} ${tiles === 1 ? 'tile' : 'tiles'}`);
  return bits.join(' · ');
}
