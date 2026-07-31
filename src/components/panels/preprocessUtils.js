// src/components/panels/preprocessUtils.js
// Pure helpers for the 3-stage Preprocess panel (Inc 2b-3) — encoder/segmenter catalogs, the
// encoder→patch_size binding (Fork B), DAG artifact matching (reconstruct segment→patch→features
// from a slide's artifact rows by params + parent_hash), per-stage status descriptors, and the
// pure Run-all auto-advance decision (`nextChainStep`). Kept out of the React component so the
// logic is unit-testable with no render harness (like copilotTurn.js).

// Encoder catalog. `text: true` ⇒ patch features live in the CONCH text space, so Copilot's
// find_regions text search works on this index (F1). `patch_size`/`mag` are the encoder's TRAINED
// resolution (Trident README): the panel binds the tiling stage to these so a build never samples
// an off-spec field of view.
//
// CONCH v1 appears TWICE on purpose. It is one checkpoint with two output spaces, and they are
// near-orthogonal (per-patch cosine ≈ 0.005 after L2), not one rescaled into the other:
//   conch_v1_text — with the contrastive projection: what find_regions searches. The default.
//   conch_v1      — Trident's defaults, the raw vision tower: what MIL downstream tasks train on.
// Collapsing them into one id is what let a task silently run on the wrong vectors (Inc 2c), so
// they carry separate ids and therefore separate feat_hashes.
export const ENCODERS = [
  { id: 'conch_v1_text', label: 'CONCH v1 · text-aligned', text: true, patch_size: 512, mag: 20, dim: 512 },
  { id: 'conch_v1', label: 'CONCH v1 · vision', text: false, patch_size: 512, mag: 20, dim: 512 },
  { id: 'uni_v2', label: 'UNI v2', text: false, patch_size: 256, mag: 20, dim: 1536 },
  { id: 'uni_v1', label: 'UNI v1', text: false, patch_size: 256, mag: 20, dim: 1024 },
];

export const SEGMENTERS = [
  { id: 'hest', label: 'HEST (deep)' },
  { id: 'grandqc', label: 'GrandQC' },
  { id: 'otsu', label: 'Otsu (fast)' },
];

export const MAGS = [5, 10, 20, 40];
export const OVERLAPS = [0, 64, 128];        // px, absolute (Trident --overlap)

// The whole form: build target (encoder) + stage-1 (segment) + stage-2 (tile) params. patch_size/
// mag mirror the encoder unless the user unlocks the override (`patch_override`).
export const DEFAULT_FORM = Object.freeze({
  encoder: 'conch_v1_text',
  // stage 1 — segmentation
  segmenter: 'hest', seg_conf_thresh: 0.5,
  remove_artifacts: false, remove_holes: false, remove_penmarks: false,
  // stage 2 — tiling (patch_size/mag bound to the encoder)
  mag: 20, patch_size: 512, overlap: 0,
  patch_override: false,
});

const STAGE_LABELS = {
  starting: 'Starting',
  resolving: 'Fetching slide',
  segmentation: 'Segmenting tissue',
  patching: 'Extracting patches',
  features: 'Encoding features',
  done: 'Done',
  error: 'Error',
};

const STAGE_NONE = {
  segmentation: 'Not segmented',
  patching: 'Not tiled',
  features: 'No features',
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

export function recommendedPatchSize(encoder) {
  return encoderMeta(encoder)?.patch_size ?? 256;
}

export function recommendedMag(encoder) {
  return encoderMeta(encoder)?.mag ?? 20;
}

// Switch the build target; unless the user unlocked the override, snap the tiling params to the
// encoder's trained resolution (Fork B).
export function bindEncoder(form, encoder) {
  const next = { ...form, encoder };
  if (!form.patch_override) {
    next.patch_size = recommendedPatchSize(encoder);
    next.mag = recommendedMag(encoder);
  }
  return next;
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || 'Working';
}

export function progressPercent(row) {
  const p = Number(row?.progress);
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

export function fmtInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '';
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ── Form → the wire params for each stage ─────────────────────────────────────────────

export function pickSegParams(form) {
  return {
    segmenter: form.segmenter,
    seg_conf_thresh: num(form.seg_conf_thresh, 0.5),
    remove_artifacts: !!form.remove_artifacts,
    remove_holes: !!form.remove_holes,
    remove_penmarks: !!form.remove_penmarks,
  };
}

export function pickTileParams(form) {
  return {
    mag: num(form.mag, 20),
    patch_size: num(form.patch_size, 256),
    overlap: num(form.overlap, 0),
  };
}

// ── DAG artifact matching (reconstruct the pipeline from a slide's rows) ───────────────

export function segParamsMatch(row, sp) {
  if (!row || row.kind !== 'segmentation') return false;
  const p = row.params || {};
  return (p.segmenter || 'hest') === sp.segmenter
    && Math.abs(num(p.seg_conf_thresh, 0.5) - sp.seg_conf_thresh) < 1e-6
    && !!p.remove_artifacts === sp.remove_artifacts
    && !!p.remove_holes === sp.remove_holes
    && !!p.remove_penmarks === sp.remove_penmarks;
}

export function tileParamsMatch(row, tp) {
  if (!row || row.kind !== 'patching') return false;
  const p = row.params || {};
  return num(p.mag) === tp.mag && num(p.patch_size) === tp.patch_size
    && num(p.overlap, 0) === tp.overlap;
}

export function featEncoderMatch(row, encoder) {
  return !!row && row.kind === 'features' && (row.params?.encoder === encoder);
}

export function findSegmentation(rows, sp) {
  return (rows || []).find((r) => segParamsMatch(r, sp)) || null;
}

export function findPatching(rows, segHash, tp) {
  if (!segHash) return null;
  return (rows || []).find((r) => r.parent_hash === segHash && tileParamsMatch(r, tp)) || null;
}

export function findFeatures(rows, patchHash, encoder) {
  if (!patchHash) return null;
  return (rows || []).find((r) => r.parent_hash === patchHash && featEncoderMatch(r, encoder))
    || null;
}

// Resolve the three matched rows for the current form (any may be null = not built yet).
export function matchDag(rows, form) {
  const seg = findSegmentation(rows, pickSegParams(form));
  const patch = seg ? findPatching(rows, seg.art_hash, pickTileParams(form)) : null;
  const feat = patch ? findFeatures(rows, patch.art_hash, form.encoder) : null;
  return { seg, patch, feat };
}

// Reconstruct a form from the deepest READY chain a slide already has, so reopening the panel
// surfaces its existing build instead of an empty default. matchDag is form-first (the form's
// params decide which artifacts count as "built"); on reopen the form resets to DEFAULT_FORM, so a
// build made with any non-default param would otherwise vanish even though it's persisted. Returns
// a new form (baseForm overlaid with the chain's params) or null if the slide has no ready artifact.
export function hydrateFormFromRows(rows, baseForm = DEFAULT_FORM) {
  const list = rows || [];
  const ready = (kind) => list.filter((r) => r.kind === kind && r.status === 'ready');
  const byHash = (h) => list.find((r) => r.art_hash === h) || null;

  // Deepest chain first: a ready features row pins encoder + patch + seg.
  const feat = ready('features')[0] || null;
  const patch = feat ? byHash(feat.parent_hash) : (ready('patching')[0] || null);
  const seg = patch ? byHash(patch.parent_hash) : (ready('segmentation')[0] || null);
  if (!seg && !patch && !feat) return null;

  const form = { ...baseForm };
  if (seg) {
    const p = seg.params || {};
    if (p.segmenter != null) form.segmenter = p.segmenter;
    if (p.seg_conf_thresh != null) form.seg_conf_thresh = Number(p.seg_conf_thresh);
    form.remove_artifacts = !!p.remove_artifacts;
    form.remove_holes = !!p.remove_holes;
    form.remove_penmarks = !!p.remove_penmarks;
  }
  if (feat && feat.params?.encoder) form.encoder = feat.params.encoder;
  if (patch) {
    const p = patch.params || {};
    if (p.mag != null) form.mag = Number(p.mag);
    if (p.patch_size != null) form.patch_size = Number(p.patch_size);
    if (p.overlap != null) form.overlap = Number(p.overlap);
  } else {
    // No patch grid built yet → tiling params follow the (possibly default) encoder.
    form.patch_size = recommendedPatchSize(form.encoder);
    form.mag = recommendedMag(form.encoder);
  }
  // Keep the tiling params visible/editable (not stomped by bindEncoder) when they diverge from
  // the encoder's trained resolution.
  form.patch_override = form.patch_size !== recommendedPatchSize(form.encoder)
    || form.mag !== recommendedMag(form.encoder);
  return form;
}

// ── Status ────────────────────────────────────────────────────────────────────────────

export function isInFlight(row) {
  return row?.status === 'queued' || row?.status === 'running';
}

export function anyInFlight(rows) {
  return (rows || []).some(isInFlight);
}

export function stageState(row) {
  if (!row) return 'none';
  if (row.status === 'ready') return 'ready';
  if (row.status === 'failed') return 'failed';
  if (isInFlight(row)) return 'running';
  return 'unknown';
}

// A normalized descriptor for a stage's matched row (or null). The component renders `state` as a
// colored pill and shows title/detail.
export function describeStage(row, kind) {
  const state = stageState(row);
  if (state === 'none') return { state, title: STAGE_NONE[kind] || 'Not built', detail: '' };
  if (state === 'ready') {
    const n = fmtInt(row.n_items);
    const [one, many] = kind === 'segmentation' ? ['contour', 'contours'] : ['patch', 'patches'];
    const noun = row.n_items === 1 ? one : many;
    return { state, title: 'Ready', detail: n ? `${n} ${noun}` : 'Ready' };
  }
  if (state === 'failed') {
    return { state, title: 'Failed', detail: row.error || 'The build did not complete. Try again.' };
  }
  if (state === 'running') {
    return { state, title: stageLabel(row.stage), detail: `${progressPercent(row)}%` };
  }
  return { state, title: row.status || 'Unknown', detail: '' };
}

// A stage's Run is enabled once its parent is ready (segmentation has no parent → always enabled).
export function stageEnabled(parentRow, isRoot = false) {
  if (isRoot) return true;
  return parentRow?.status === 'ready';
}

// ── Run-all auto-advance (pure decision; drives the component's chain effect) ──────────
// Given the slide's current rows + form, decide the next action. Returns one of:
//   {do:'segment'} | {do:'patch', seg_hash} | {do:'features', patch_hash}
//   {do:'wait'} (a stage is in flight) | {do:'done', feat} | {do:'stop', failed:<kind>}
export function nextChainStep(rows, form) {
  const sp = pickSegParams(form);
  const tp = pickTileParams(form);
  const seg = findSegmentation(rows, sp);
  if (!seg) return { do: 'segment' };
  if (seg.status === 'failed') return { do: 'stop', failed: 'segmentation' };
  if (isInFlight(seg)) return { do: 'wait' };

  const patch = findPatching(rows, seg.art_hash, tp);
  if (!patch) return { do: 'patch', seg_hash: seg.art_hash };
  if (patch.status === 'failed') return { do: 'stop', failed: 'patching' };
  if (isInFlight(patch)) return { do: 'wait' };

  const feat = findFeatures(rows, patch.art_hash, form.encoder);
  if (!feat) return { do: 'features', patch_hash: patch.art_hash };
  if (feat.status === 'failed') return { do: 'stop', failed: 'features' };
  if (isInFlight(feat)) return { do: 'wait' };

  return { do: 'done', feat };
}
