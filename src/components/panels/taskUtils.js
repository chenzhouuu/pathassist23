// src/components/panels/taskUtils.js
// Pure helpers for the Task panel (Inc 2c) — matching a slide's preprocess DAG against a task's
// required feature build, planning the build when it's missing, describing a prediction, and the
// evidence colour ramp. Kept out of the React shell so it's unit-testable with no render harness
// (same split as preprocessUtils.js, whose DAG primitives this builds on).

import {
  DEFAULT_FORM, matchDag, nextChainStep, hydrateFormFromRows,
  progressPercent, stageLabel, fmtInt,
} from './preprocessUtils.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ── Feature-spec matching ─────────────────────────────────────────────────────────────
// A task declares the build its weights were trained on. The encoder lives on the features row;
// mag/patch_size/overlap live on its patching parent — so matching walks one link up the DAG.
// `segmenter` is deliberately NOT compared (it propagates seg_hash → patch_hash → feat_hash, so
// constraining it would reject every otherwise-valid index and force a redundant rebuild). The
// server's FeatureSpec.matches makes the same choice; keep the two in step.

export function specSatisfiedBy(rows, featRow, spec) {
  if (!featRow || featRow.kind !== 'features') return false;
  if (featRow.params?.encoder !== spec?.encoder) return false;
  const patch = (rows || []).find((r) => r.art_hash === featRow.parent_hash) || null;
  if (!patch || patch.kind !== 'patching') return false;   // can't verify ⇒ don't claim a match
  const p = patch.params || {};
  return num(p.mag) === num(spec.mag)
    && num(p.patch_size) === num(spec.patch_size)
    && num(p.overlap, 0) === num(spec.overlap, 0);
}

// The ready features artifact this task can run on, or null.
export function matchFeatureSpec(rows, spec) {
  if (!spec) return null;
  return (rows || []).find(
    (r) => r.kind === 'features' && r.status === 'ready' && specSatisfiedBy(rows, r, spec),
  ) || null;
}

// A preprocess form that builds exactly what the task needs. Segmentation params are seeded from
// the slide's existing ready chain so an already-segmented slide is reused rather than re-cut;
// the task's own four fields then override, with patch_override on so bindEncoder can't snap
// patch_size back to the encoder default.
export function buildFormForSpec(spec, rows = [], baseForm = DEFAULT_FORM) {
  const seeded = hydrateFormFromRows(rows, baseForm) || { ...baseForm };
  return {
    ...seeded,
    encoder: spec.encoder,
    mag: num(spec.mag, 20),
    patch_size: num(spec.patch_size, 256),
    overlap: num(spec.overlap, 0),
    patch_override: true,
  };
}

export function describeSpec(spec) {
  if (!spec) return '';
  const enc = String(spec.encoder || '').replace(/_/g, ' ').toUpperCase();
  const ov = num(spec.overlap, 0);
  return `${enc} · ${num(spec.patch_size, 256)} px · ${num(spec.mag, 20)}×`
    + (ov ? ` · ${ov} px overlap` : ' · no overlap');
}

// ── Feature readiness (drives the panel's build card) ─────────────────────────────────
// { state: 'ready'|'building'|'failed'|'missing', feat, detail, progress, stage }

export function describeFeatureState(rows, spec) {
  const feat = matchFeatureSpec(rows, spec);
  if (feat) {
    const n = fmtInt(feat.n_items);
    return {
      state: 'ready', feat,
      detail: n ? `${n} patches indexed.` : 'Feature index ready.',
      progress: 100, stage: null,
    };
  }
  if (!spec) return { state: 'missing', feat: null, detail: '', progress: 0, stage: null };

  const form = buildFormForSpec(spec, rows);
  const step = nextChainStep(rows, form);
  if (step.do === 'stop') {
    const failed = matchDag(rows, form)[
      { segmentation: 'seg', patching: 'patch', features: 'feat' }[step.failed]
    ];
    return {
      state: 'failed', feat: null, progress: 0, stage: step.failed,
      detail: failed?.error || `${step.failed} failed. Try building again.`,
    };
  }
  if (step.do === 'wait') {
    const { seg, patch, feat: f } = matchDag(rows, form);
    const live = [seg, patch, f].find((r) => r && (r.status === 'queued' || r.status === 'running'));
    return {
      state: 'building', feat: null, stage: live?.stage || null,
      progress: progressPercent(live), detail: stageLabel(live?.stage),
    };
  }
  // 'done' can only happen if a chain finished with params matchDag accepts but the spec walk
  // rejected — treat it as missing rather than silently running on the wrong features.
  return {
    state: 'missing', feat: null, progress: 0, stage: null,
    detail: 'No matching feature index for this slide.',
  };
}

// How many of the three stages still have to run — so the panel can say what it is about to spend.
export function pendingStages(rows, spec) {
  if (!spec) return [];
  const form = buildFormForSpec(spec, rows);
  const { seg, patch, feat } = matchDag(rows, form);
  const out = [];
  if (seg?.status !== 'ready') out.push('segmentation');
  if (patch?.status !== 'ready') out.push('patching');
  if (feat?.status !== 'ready') out.push('features');
  return out;
}

// ── Predictions ───────────────────────────────────────────────────────────────────────

export function findPrediction(rows, featHash, taskId) {
  if (!featHash || !taskId) return null;
  return (rows || []).find(
    (r) => r.kind === 'prediction' && r.parent_hash === featHash && r.params?.task_id === taskId,
  ) || null;
}

// A render-ready view of a prediction row (or null). `probs` is always ordered as the model's
// classes are, with the winner flagged — never re-sorted, so the bars keep a stable position.
export function describePrediction(row) {
  if (!row) return null;
  const state = row.status === 'ready' ? 'ready'
    : row.status === 'failed' ? 'failed'
      : (row.status === 'queued' || row.status === 'running') ? 'running' : 'unknown';
  if (state !== 'ready') {
    return {
      state, label: null, confidence: null, probs: [],
      detail: state === 'failed'
        ? (row.error || 'The task did not complete. Try again.')
        : 'Running…',
      provenance: '',
    };
  }
  const res = row.result || {};
  const classes = Array.isArray(res.classes) ? res.classes : [];
  const values = Array.isArray(res.probs) ? res.probs : [];
  const winner = Number.isFinite(res.pred_index) ? res.pred_index : values.indexOf(Math.max(...values));
  const probs = classes.map((name, i) => ({
    name, p: num(values[i], 0), win: i === winner,
  }));
  const label = res.pred_label || classes[winner] || null;
  const confidence = num(values[winner], NaN);
  return {
    state, label, probs,
    confidence: Number.isFinite(confidence) ? confidence : null,
    detail: '',
    provenance: [
      res.n_patches != null ? `${fmtInt(res.n_patches)} patches` : null,
      res.elapsed_ms != null ? `${fmtInt(res.elapsed_ms)} ms` : null,
      res.model_ver || null,
    ].filter(Boolean).join(' · '),
  };
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
