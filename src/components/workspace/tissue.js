// src/components/workspace/tissue.js — the tissue map: its composition, and how it is drawn.
//
// Was `panels/tissueUtils.js` until Inc 6 · 06, when the Tissue tab went. Its panel half — is a
// build running, what does its Stop button say, how far along is it — went with the tab, because
// a run is a Girder job now and the Runs list is where a job is watched. What is here is the
// artifact half, which has two readers and belongs to neither: `workspace/artifactDetail.js` turns
// it into the expanded row, and `viewer/ArtifactLayers.jsx` turns it into the raster on the slide.
// It followed `workspace/nuclei.js` for the same reason, one ticket later.
//
// Everything is a pure function of its arguments, so it is testable without a viewer, a network or
// a GPU; and every number is read off the stored artifact rather than carried over from the call
// that produced it, which is what makes the numbers survive a reload.

// The three looks D7 asked for. `classes` is the default: colour by argmax with alpha following
// confidence, so an out-of-focus or ambiguous field renders faint instead of looking as decided as
// a clean one.
export const RENDERS = ['classes', 'probs', 'outline'];
export const RENDER_LABEL = {
  classes: 'Classes', probs: 'Probability', outline: 'Outline',
};

// The stored layer each render mode reads. Two looks share one layer, which is the point of
// storing argmax and probabilities separately.
export const LAYER_FOR_RENDER = { classes: 'classes', outline: 'classes', probs: 'probs' };

export const DEFAULT_OPACITY = 0.45;   // dense and areal — it must not bury the histology
export const DEFAULT_CONF_FLOOR = 0.2; // a low-confidence region stays visible, just faint

// Fallback only — the real class list, palette, licence and provenance come from
// GET /tissue/catalog, so the UI never claims a class the deployed backend does not predict.
export const FALLBACK_CLASSES = ['Tumour', 'Stroma', 'Inflammatory', 'Necrosis', 'Others'];
// "Others" is a grab-bag (nerves, vessels, blood, adipose), so it is off by default — but its
// number is always shown, because hiding a class from the picture must not hide it from the maths.
export const DEFAULT_HIDDEN = ['Others'];

// How the tissue layer is drawn, when nothing has said otherwise. Inc 5 · 03a moved these out of
// TissuePanel into the store, because the layer goes on rendering while that panel is closed — the
// right panel unmounts a panel on every tab switch. The store holds a patch; this is what it
// patches, so the defaults still have exactly one home.
export const TISSUE_LAYER_DEFAULTS = Object.freeze({
  render: 'classes',
  opacity: DEFAULT_OPACITY,
  conf: true,
  confFloor: DEFAULT_CONF_FLOOR,
  hidden: Object.freeze(Object.fromEntries(DEFAULT_HIDDEN.map((n) => [n, true]))),
  heFade: 1,                           // tissue is translucent, so the H&E stays by default
});

export function withTissueDefaults(patch) {
  return { ...TISSUE_LAYER_DEFAULTS, ...(patch || {}) };
}

/** Query params for a tile URL. Fixed key order: OSD caches by URL string. */
export function tileParams(render, { show, opacity, conf = true, confFloor, classes, rev } = {}) {
  const params = {};
  const all = classes || [];
  // Omit `show` when nothing is filtered — a shorter URL is a better cache key.
  if (show && all.length && show.length && show.length < all.length) {
    params.show = [...show].sort().join(',');
  }
  if (opacity != null && opacity !== 1) params.alpha = String(round3(opacity));
  if (render === 'classes') {
    params.conf = conf ? '1' : '0';
    if (conf && confFloor != null && confFloor !== DEFAULT_CONF_FLOOR) {
      params.conf_floor = String(round3(confFloor));
    }
  }
  if (render === 'outline') params.width = '2';
  // How many cores the artifact covers. The worker ignores it; it is in the URL because a tile is
  // only immutable for a *given* coverage (the same reason `workspace/nuclei.js` carries one).
  // Without it, the transparent tiles fetched while a whole-slide build was still working would
  // stay in the browser's cache, and the map would keep showing the emptiness it had when you
  // first looked at it.
  if (Number.isFinite(Number(rev)) && Number(rev) > 0) params.rev = String(rev);
  return params;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** A stable signature for "the picture the current controls describe". */
export function layerSignature(render, artHash, params) {
  if (!artHash || !render) return 'none';
  const keys = Object.keys(params || {}).sort();
  return `tissue|${render}|${artHash}|${keys.map((k) => `${k}=${params[k]}`).join('&')}`;
}

/** Stored layers are coarser than the slide; `level_offset` converts an OSD level to a stored one. */
export function levelOffsetFor(meta, layer) {
  const n = meta?.layers?.[layer]?.level_offset;
  return Number.isFinite(n) ? n : 2;
}

export function layerLevels(meta, layer) {
  const n = meta?.layers?.[layer]?.levels;
  return Number.isFinite(n) ? n : 1;
}

/** The class list this artifact actually has — from meta first, then the catalog, then a fallback. */
export function classesOf(meta, catalog, backendName) {
  if (Array.isArray(meta?.classes) && meta.classes.length) return meta.classes;
  const name = backendName || meta?.backend || catalog?.default_backend;
  const b = catalog?.backends?.[name];
  if (Array.isArray(b?.classes) && b.classes.length) return b.classes;
  return FALLBACK_CLASSES;
}

/** Class → '#rrggbb', from the artifact's own palette so a recolour can never drift from the map. */
export function colorsOf(meta, catalog, backendName) {
  if (meta?.colors && Object.keys(meta.colors).length) return meta.colors;
  const name = backendName || meta?.backend || catalog?.default_backend;
  return catalog?.backends?.[name]?.colors || {};
}


/**
 * Legend rows: class, colour, hard fraction and the soft (probability-weighted) one.
 *
 * Both fractions are carried because they differ exactly where the model is uncertain, and that
 * difference is information. Ordered by the class list, not by size, so the legend does not
 * reshuffle itself as coverage grows.
 */
export function compositionRows(meta, catalog, backendName) {
  const classes = classesOf(meta, catalog, backendName);
  const colors = colorsOf(meta, catalog, backendName);
  const hard = meta?.summary?.fraction || {};
  const soft = meta?.summary?.fraction_soft || {};
  return classes.map((name) => ({
    name,
    color: colors[name] || '#999999',
    fraction: typeof hard[name] === 'number' ? hard[name] : null,
    soft: typeof soft[name] === 'number' ? soft[name] : null,
  }));
}

/** Tumour–stroma ratio as stroma / (tumour + stroma) — reported as a number, never as a category. */
export function tsrOf(meta) {
  const v = meta?.summary?.tsr;
  return typeof v === 'number' ? v : null;
}

export function coverageSummary(meta) {
  const n = meta?.coverage?.n_tiles;
  if (!n) return null;
  const mm2 = meta?.summary?.covered_mm2;
  return { tiles: n, mm2: typeof mm2 === 'number' ? mm2 : null };
}

export function formatPercent(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

/**
 * The composition as CSV. Carries the backend name and the covered area on every row: a fraction
 * over 3 % of a slide and a fraction over the whole slide are not the same claim, and a file that
 * loses that distinction will eventually be read as if it had not.
 */
export function compositionCsv(meta, catalog, backendName) {
  const rows = compositionRows(meta, catalog, backendName);
  const cov = coverageSummary(meta) || {};
  const backend = meta?.backend || backendName || '';
  const px = meta?.summary?.pixels || {};
  const header = ['class', 'pixels', 'fraction', 'fraction_soft', 'covered_mm2', 'core_tiles',
                  'backend'];
  const body = rows.map((r) => [
    r.name, px[r.name] ?? '', r.fraction ?? '', r.soft ?? '',
    cov.mm2 ?? '', cov.tiles ?? '', backend,
  ].join(','));
  return [header.join(','), ...body].join('\n');
}
