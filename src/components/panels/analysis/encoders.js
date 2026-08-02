// src/components/panels/analysis/encoders.js
// The build vocabulary a feature index is specified in: which encoders this app offers, which
// segmenters, and the encoder→patch_size binding (Fork B) that makes the encoder the *target* of a
// build rather than one more field in it.
//
// This was `panels/preprocessUtils.js`, the pure half of the 3-stage Preprocess panel (Inc 2b-3).
// The panel is gone (Inc 6 · 07) and so is most of the file: DAG matching, per-stage status and
// the Run-all auto-advance (`nextChainStep`) were a browser reconstructing a dependency graph and
// stepping it one stage at a time while somebody kept the tab open. All three are the server's
// now — `agent/gateway/plan.py` addresses the chain and Celery sequences it. What is left is what
// a *form* needs, which is why it lives beside the catalog that renders it.

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

// ── Form → the wire params ────────────────────────────────────────────────────────────

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

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
