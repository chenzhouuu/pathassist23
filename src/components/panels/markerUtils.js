// src/components/panels/markerUtils.js — pure helpers for the Markers panel (Inc 3b).
// Everything here is a pure function of its arguments so the panel's logic is testable without a
// viewer, a network or a GPU. The React shell is MarkersPanel.jsx; the OSD plumbing is
// markerLayers.js.

// Display transfer function defaults. `lo` sits above the noise floor of a sigmoid probability
// map and `gamma < 1` lifts mid-range signal, which is what makes a composite read like
// fluorescence rather than like a washed-out heatmap.
export const DEFAULT_DISPLAY = { lo: 0.15, hi: 0.95, gamma: 0.8 };

// DAPI reads as near-saturated across all tissue, so at full weight it greys out every coloured
// channel drawn over it. It belongs behind them, as the reference figure's grey structural layer.
export const DAPI_WEIGHT = 0.35;

// Two pictures, mutually exclusive (D8) — a marker composite and a phenotype map are both dense
// and saturated, and stacking them makes neither readable. The third mode used to be 'he', which
// only ever meant "no data layer"; the Workspace's eye says that now (Inc 5 · 03b), so a mode that
// means off would be a second switch for the thing the eye owns.
export const MODES = ['markers', 'pheno'];
export const MODE_LABEL = { markers: 'Markers', pheno: 'Phenotype' };

// Fallback only — the real vocabulary, presets and palette come from GET /biomarker/catalog, so
// the UI never claims a marker the deployed model does not actually have.
//
// Lineage (CK / CD3 / CD138 / CD68 / CD34) rather than Immune: it spans epithelium, stroma and
// immune, so it shows something on almost any field. Opening on Immune leaves a stromal region
// looking blank, which reads as "the model found nothing" when it simply found nothing immune.
export const FALLBACK_PRESET = 'Lineage';

// How the marker/phenotype layer is drawn when nothing has said otherwise. Held in the store from
// Inc 5 · 03b, for the same reason as the tissue layer's: the picture outlives the panel, which
// unmounts on every tab switch.
//
// `channels` is null rather than a list because the real channel set comes from the catalog, which
// is fetched. Null means "whatever this preset says", so a layer switched on from the Workspace
// draws correctly even if the Markers panel has never been opened.
export const MARKER_LAYER_DEFAULTS = Object.freeze({
  mode: 'markers',
  preset: FALLBACK_PRESET,
  channels: null,
  display: DEFAULT_DISPLAY,
  dapiOn: true,
  dapiW: DAPI_WEIGHT,
  hidden: Object.freeze({}),          // lineage → hidden?
  heFade: 0,                          // the composite is opaque, so the H&E goes dark under it
});

export function withMarkerDefaults(patch) {
  return { ...MARKER_LAYER_DEFAULTS, ...(patch || {}) };
}

// `ch=` is the compositing spec: ordered marker:colour pairs. Colours are stored without '#'
// because they ride in a URL.
export function channelParam(channels = []) {
  return channels
    .filter((c) => c && c.marker && c.enabled !== false)
    .map((c) => `${c.marker}:${String(c.color || 'ffffff').replace('#', '')}`)
    .join(',');
}

// Query params are built in a FIXED key order. OSD caches tiles by URL string, so a differently
// ordered but equivalent query would look like a whole new pyramid and refetch every visible
// tile on any unrelated state change.
export function tileParams(mode, { channels, display, dapi, dapiWeight, show, alpha } = {}) {
  const d = { ...DEFAULT_DISPLAY, ...(display || {}) };
  if (mode === 'markers') {
    const params = { ch: channelParam(channels) };
    // colour:weight — DAPI is a dim structural underlay, not a channel competing for attention
    if (dapi) params.dapi = `${String(dapi).replace('#', '')}:${dapiWeight ?? DAPI_WEIGHT}`;
    params.lo = String(d.lo);
    params.hi = String(d.hi);
    params.gamma = String(d.gamma);
    return params;
  }
  const params = {};
  if (show && show.length) params.show = show.join(',');
  if (alpha != null && alpha !== 1) params.alpha = String(alpha);
  return params;
}

// A stable signature for "the picture the current controls describe". The layer manager remounts
// only when this changes, which is what keeps a pan from tearing down the pyramid.
//
// No artifact means no picture, and the mode alone is a stable name for that — which is how the
// caller says "nothing is switched on" since the 'he' mode was removed (Inc 5 · 03b).
export function layerSignature(mode, artHash, params) {
  if (!artHash) return `${mode}`;
  const keys = Object.keys(params || {}).sort();
  return `${mode}|${artHash}|${keys.map((k) => `${k}=${params[k]}`).join('&')}`;
}

// Stored layers are coarser than the slide; `level_offset` converts an OSD level (in the slide's
// own frame) to the level actually on disk. Without this the marker and phenotype layers would
// not register against the H&E or each other (review S1).
export function levelOffsetFor(meta, layer) {
  const n = meta?.layers?.[layer]?.level_offset;
  return Number.isFinite(n) ? n : (layer === 'markers' ? 2 : 0);
}

export function layerLevels(meta, layer) {
  const n = meta?.layers?.[layer]?.levels;
  return Number.isFinite(n) ? n : 1;
}

// Presets arrive as {name: [{marker, color}]}. Selecting one replaces the whole channel set,
// because the colours in a preset were chosen to be separable *together* under additive
// compositing — cherry-picking across presets is what produces an illegible picture.
export function presetChannels(catalog, name) {
  const preset = catalog?.presets?.[name];
  if (!preset) return [];
  return preset.map((p) => ({ marker: p.marker, color: `#${String(p.color).replace('#', '')}`,
                              enabled: true }));
}

export function presetNames(catalog) {
  return Object.keys(catalog?.presets || {});
}

// A marker's honest label: GigaTIME's panel is not the reference figure's panel, and a
// near-equivalent must read as a near-equivalent, never as the real antibody.
export function markerLabel(catalog, marker) {
  const eq = catalog?.equivalents?.[marker];
  return eq ? `${marker} · ${eq}` : marker;
}

// The artifact row for this slide's map, newest first (the panel shows at most one).
export function findBiomarkerRow(rows = []) {
  return rows.find((r) => r.kind === 'biomarker') || null;
}

/** The nuclei artifact a phenotype map is built on. Ready only: a half-built one would give the
 *  map a set of cells that is about to change under it (Inc 5 · D9). */
export function findReadyNuclei(rows = []) {
  return rows.find((r) => r.kind === 'nuclei' && r.status === 'ready') || null;
}

export function findReadySegmentation(rows = []) {
  return rows.find((r) => r.kind === 'segmentation' && r.status === 'ready') || null;
}

export function isRunning(row) {
  return !!row && (row.status === 'queued' || row.status === 'running');
}

// Panel copy for a build's state. Deliberately concrete: "Sampling thresholds 12%" tells the user
// the job is alive, "Building" does not.
export function describeStage(row) {
  if (!row) return 'Not built';
  if (row.status === 'failed') return `Failed — ${row.error || 'unknown error'}`;
  if (row.status === 'ready') {
    const n = row.result?.n_cells;
    return n ? `Ready — ${n.toLocaleString()} cells` : 'Ready';
  }
  const pct = Math.round((row.progress || 0) * 100);
  const stage = { sampling: 'Sampling thresholds', tiles: 'Analysing tiles',
                  pyramid: 'Building pyramid', starting: 'Starting' }[row.stage] || 'Working';
  return `${stage} ${pct}%`;
}

// Lineage counts from the artifact's summary, largest first — the legend's data.
export function phenotypeLegend(meta) {
  const counts = meta?.summary?.counts_by_phenotype || {};
  return Object.keys(counts)
    .filter((k) => counts[k] > 0)
    .sort((a, b) => counts[b] - counts[a])
    .map((name) => ({ name, count: counts[name] }));
}

// Which markers actually got a separable positive population on this slide. A marker whose
// threshold is null could not be split into positive/negative, so it gates no lineage — it is
// still viewable as a channel, and the panel says so rather than silently implying "all negative".
export function separableMarkers(meta) {
  const thr = meta?.thresholds || {};
  return Object.keys(thr).filter((m) => thr[m] != null);
}

export function coverageSummary(meta) {
  const cov = meta?.coverage;
  if (!cov || !cov.n_tiles) return null;
  const core = cov.core || 2048;
  const mpp = meta?.slide?.mpp || 0.25;
  const mm2 = cov.n_tiles * ((core * mpp) / 1000) ** 2;
  return { tiles: cov.n_tiles, mm2: Math.round(mm2 * 100) / 100 };
}
