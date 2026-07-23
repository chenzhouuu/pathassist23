// src/components/panels/preprocessUtils.js
// Pure helpers for the Preprocess panel — encoder/segmenter catalogs, params matching (to detect
// an already-built index), and status/stage/progress formatting. Kept separate from the React
// component so the logic is unit-testable with no render harness (like copilotTurn.js).

// Encoder catalog for the config dropdown. `text: true` ⇒ the patch features live in the CONCH
// text embedding space, so Copilot's find_regions text search works on this index (F1);
// image-only encoders still power future image→image "find similar to this ROI". Scoped to the
// encoders actually available on this deployment (weights seeded under data2): conch_v1 (text) is
// the default so building enables Copilot search out of the box; UNI (v2/v1) are strong image-only
// alternatives. conch_v15 / musk are gated and not authorized for this HF token, so they're omitted
// here (the worker can still build them on a deployment whose token has access).
export const ENCODERS = [
  { id: 'conch_v1', label: 'CONCH v1', text: true },
  { id: 'uni_v2', label: 'UNI v2', text: false },
  { id: 'uni_v1', label: 'UNI v1', text: false },
];

export const SEGMENTERS = [
  { id: 'hest', label: 'HEST (deep)' },
  { id: 'grandqc', label: 'GrandQC' },
  { id: 'otsu', label: 'Otsu (fast)' },
];

export const MAGS = [5, 10, 20, 40];
export const PATCH_SIZES = [256, 512];

// Defaults mirror the worker's (config.py): text-capable conch_v1 (so a default build enables
// Copilot region search) / 20× / 256 / HEST.
export const DEFAULT_PARAMS = Object.freeze({
  encoder: 'conch_v1', mag: 20, patch_size: 256, segmenter: 'hest',
});

const STAGE_LABELS = {
  resolving: 'Fetching slide',
  segmentation: 'Segmenting tissue',
  patching: 'Extracting patches',
  features: 'Encoding features',
  done: 'Done',
  error: 'Error',
};

export function encoderMeta(id) {
  return ENCODERS.find((e) => e.id === id) || null;
}

export function encoderLabel(id) {
  return encoderMeta(id)?.label || id;
}

export function isTextCapable(id) {
  return encoderMeta(id)?.text === true;
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || 'Working';
}

// Percent 0–100 for a progress bar; tolerates missing/out-of-range values.
export function progressPercent(row) {
  const p = Number(row?.progress);
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

export function fmtInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '';
}

// Coerce a form's values to the wire types (mag/patch_size are integers).
export function normalizeParams(form) {
  return {
    encoder: form.encoder,
    mag: Number(form.mag),
    patch_size: Number(form.patch_size),
    segmenter: form.segmenter,
  };
}

// Does an existing index row describe the same build as `params`? A row's segmenter may be
// absent on older rows → treat as the default. mag/patch_size compared numerically so a
// string row value ("20") still matches a numeric form value (20).
export function paramsMatch(row, params) {
  if (!row) return false;
  return (
    row.encoder === params.encoder
    && Number(row.mag) === Number(params.mag)
    && Number(row.patch_size) === Number(params.patch_size)
    && (row.segmenter || DEFAULT_PARAMS.segmenter) === params.segmenter
  );
}

export function findMatchingIndex(rows, params) {
  return (rows || []).find((r) => paramsMatch(r, params)) || null;
}

export function isInFlight(row) {
  return row?.status === 'queued' || row?.status === 'running';
}

export function anyInFlight(rows) {
  return (rows || []).some(isInFlight);
}

// A normalized status descriptor for the current-params index row (or null when the slide has
// no matching index yet). The component renders `state` as a colored pill and shows title/detail.
export function describeIndex(row) {
  if (!row) {
    return {
      state: 'none',
      title: 'Not preprocessed',
      detail: 'Build a feature index to enable Copilot region search on this slide.',
    };
  }
  if (row.status === 'ready') {
    const enc = encoderLabel(row.encoder);
    const patches = fmtInt(row.n_patches);
    return {
      state: 'ready',
      title: `Ready · ${enc} @ ${row.mag}×`,
      detail: patches ? `${patches} patches indexed` : 'Index ready',
    };
  }
  if (row.status === 'failed') {
    return {
      state: 'failed',
      title: 'Preprocessing failed',
      detail: row.error || 'The build did not complete. Try again.',
    };
  }
  if (isInFlight(row)) {
    return {
      state: 'running',
      title: `Preprocessing… ${stageLabel(row.stage)}`,
      detail: `${progressPercent(row)}%`,
    };
  }
  return { state: 'unknown', title: row.status || 'Unknown', detail: '' };
}
