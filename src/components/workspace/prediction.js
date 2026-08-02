// src/components/workspace/prediction.js — what a prediction artifact says, and how its evidence
// map is coloured.
//
// This was `panels/taskUtils.js`, the pure half of the Task panel (Inc 2c). The panel is gone
// (Inc 6 · 07) and so is most of the file: matching a slide's DAG against a task's `feature_spec`,
// planning the missing stages and counting them are the gateway's now (`agent/gateway/plan.py`),
// where they are answered once per submission instead of re-derived on every render by whoever
// has the tab open.
//
// What is left is what the *artifact* says about itself — the call, the probabilities, the
// provenance line — and the colour ramp its evidence map is baked with. Both belong here, beside
// the other kinds' modules, because the row that draws them is the Workspace's.
import { fmtInt } from '../panels/workspaceUtils.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** The build a task's weights were trained on, as one line. Declared by the task, never inferred. */
export function describeSpec(spec) {
  if (!spec) return '';
  const enc = String(spec.encoder || '').replace(/_/g, ' ').toUpperCase();
  const ov = num(spec.overlap, 0);
  return `${enc} · ${num(spec.patch_size, 256)} px · ${num(spec.mag, 20)}×`
    + (ov ? ` · ${ov} px overlap` : ' · no overlap');
}

// ── The artifact ──────────────────────────────────────────────────────────────────────

/**
 * A render-ready view of a prediction row, or null.
 *
 * `probs` is always ordered as the model's classes are, with the winner flagged — never re-sorted,
 * so the bars keep a stable position between two runs of the same task.
 *
 * Reads the row's stored `result` and nothing else. There is no `running` or `failed` case any
 * more: under D9 a row exists only where bytes do, so a prediction row is a prediction that
 * happened. A run still going is in the Runs feed, which is where its progress and its failure
 * live (Inc 6 · 07).
 */
export function describePrediction(row) {
  const res = row?.result;
  if (!res) return null;
  const classes = Array.isArray(res.classes) ? res.classes : [];
  const values = Array.isArray(res.probs) ? res.probs : [];
  const winner = Number.isFinite(res.pred_index)
    ? res.pred_index
    : values.indexOf(Math.max(...values));
  const probs = classes.map((name, i) => ({ name, p: num(values[i], 0), win: i === winner }));
  const confidence = num(values[winner], NaN);
  return {
    label: res.pred_label || classes[winner] || null,
    probs,
    confidence: Number.isFinite(confidence) ? confidence : null,
    provenance: [
      res.n_patches != null ? `${fmtInt(res.n_patches)} patches` : null,
      res.elapsed_ms != null ? `${fmtInt(res.elapsed_ms)} ms` : null,
      res.model_ver || null,
    ].filter(Boolean).join(' · '),
  };
}

/** The class the blue pole of the ramp argues for — the runner-up to the call being shown. */
export function otherClass(view) {
  return (view?.probs || []).find((p) => !p.win)?.name || 'the other class';
}

// ── Evidence → colour ─────────────────────────────────────────────────────────────────

export const VIEW_MODES = Object.freeze(['split', 'overlay']);
export const DEFAULT_OPACITY = 0.55;

const WHITE = [247, 247, 247];   // multiply-neutral: untouched tissue keeps its own colour
const BLUE = [58, 76, 160];      // supports the other class
const RED = [180, 40, 47];       // supports the predicted class

// t ∈ [-1, 1] → [r, g, b]. Diverging blue–white–red, matching the CLAM demo's ramp.
export function colormap(t) {
  const v = Math.max(-1, Math.min(1, num(t, 0)));
  const to = v < 0 ? BLUE : RED;
  const k = Math.abs(v);
  return [
    Math.round(WHITE[0] + (to[0] - WHITE[0]) * k),
    Math.round(WHITE[1] + (to[1] - WHITE[1]) * k),
    Math.round(WHITE[2] + (to[2] - WHITE[2]) * k),
  ];
}

// Symmetric percentile scaling: divide by the p-th percentile of |evidence| so a single extreme
// patch can't flatten the whole map, then clamp. Symmetric about zero because the sign carries the
// meaning — rescaling the two poles independently would misreport which way a patch leans.
export function normaliseEvidence(values, percentile = 0.98) {
  const arr = Array.from(values || [], (v) => num(v, 0));
  if (!arr.length) return [];
  const mags = arr.map(Math.abs).sort((a, b) => a - b);
  const idx = Math.min(mags.length - 1, Math.max(0, Math.round(percentile * (mags.length - 1))));
  const scale = mags[idx];
  if (!(scale > 0)) return arr.map(() => 0);
  return arr.map((v) => Math.max(-1, Math.min(1, v / scale)));
}

// The patch grid an evidence map is baked into: one cell per patch_px of level-0 slide.
// `patch_px` MUST come from the prediction document (coords attrs), never from mag/patch_size —
// 256 px at 20× is 512 level-0 px on a 40× slide and 256 on a 20× slide.
export function gridExtent(coords, patchPx) {
  const px = num(patchPx, 0);
  const flat = coords || [];
  if (!(px > 0) || flat.length < 2) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = num(flat[i]); const y = num(flat[i + 1]);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x0: minX, y0: minY,
    cols: Math.floor((maxX - minX) / px) + 1,
    rows: Math.floor((maxY - minY) / px) + 1,
    patchPx: px,
  };
}

// ── The layer ─────────────────────────────────────────────────────────────────────────

/** What the evidence map is drawn with until somebody touches it. */
export const PREDICTION_LAYER_DEFAULTS = Object.freeze({
  view: 'overlay',
  opacity: DEFAULT_OPACITY,
});

export function withPredictionDefaults(patch) {
  const p = { ...PREDICTION_LAYER_DEFAULTS, ...(patch || {}) };
  return { ...p, view: VIEW_MODES.includes(p.view) ? p.view : 'overlay' };
}
