// src/components/panels/workspaceUtils.js — artifact row → the four things a Workspace row says.
//
// The layout is Inc 5 §5.2: kind · params · scale · state+age. Everything here is read off the
// `params` and `result` JSONB the gateway already stores, so the panel adds no server fields and
// makes no second call per row.
//
// One rule runs through the whole file: say what the row actually carries, and say nothing when it
// carries nothing. A missing number renders as an omitted phrase, never as a zero or a guess —
// "0 patches" and "unknown" both read as facts, and neither would be one.
import { fmtInt, isInFlight, progressPercent, stageLabel } from './preprocessUtils.js';

export const KIND_LABEL = Object.freeze({
  segmentation: 'Segmentation',
  patching: 'Patching',
  features: 'Features',
  prediction: 'Prediction',
  tissue: 'Tissue map',
  biomarker: 'Biomarker map',
});

// Kinds with something to put on the slide. The rest are still listed — they answer "what has this
// slide cost me" — but they get no eye (Inc 5 D2). `nuclei` joins this set in ticket 06.
export const DRAWABLE = Object.freeze(['segmentation', 'tissue', 'biomarker']);

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || 'Artifact';
}

export function canDraw(row) {
  return DRAWABLE.includes(row?.kind);
}

// ── The four segments ────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** Segment 2 — what it was built with. '' when the row records nothing worth naming. */
export function describeParams(row) {
  const p = row?.params || {};
  const bits = [];
  switch (row?.kind) {
    case 'segmentation':
      if (p.segmenter) bits.push(p.segmenter);
      if (Number.isFinite(Number(p.seg_conf_thresh))) bits.push(`conf ${p.seg_conf_thresh}`);
      break;
    case 'patching':
      if (p.patch_size) bits.push(`${p.patch_size} px`);
      if (p.mag) bits.push(`${p.mag}×`);
      if (Number(p.overlap) > 0) bits.push(`overlap ${p.overlap}`);
      break;
    case 'features':
      if (p.encoder) bits.push(p.encoder);
      break;
    case 'prediction':
      if (p.task_id) bits.push(p.task_id);
      if (p.model_ver) bits.push(p.model_ver);
      break;
    case 'tissue':
      if (p.backend) bits.push(p.backend);
      if (p.scope) bits.push(p.scope);
      break;
    case 'biomarker':
      if (p.scope) bits.push(p.scope);
      break;
    default:
      break;
  }
  return bits.join(' · ');
}

/** Segment 3 — how much of it there is. '' until the build has produced numbers. */
export function describeScale(row) {
  const r = row?.result || {};
  const n = row?.n_items;
  switch (row?.kind) {
    case 'segmentation':
      return Number.isFinite(n) ? plural(n, 'tissue region', 'tissue regions') : '';
    case 'patching':
      return Number.isFinite(n) ? plural(n, 'patch', 'patches') : '';
    case 'features': {
      if (!Number.isFinite(n)) return '';
      const vectors = plural(n, 'vector', 'vectors');
      return row.dim ? `${vectors} × ${row.dim}` : vectors;
    }
    case 'prediction': {
      if (!r.pred_label) return '';
      const probs = Array.isArray(r.probs) ? r.probs : null;
      const p = probs && Number.isFinite(Number(probs[r.pred_index]))
        ? ` ${(Number(probs[r.pred_index]) * 100).toFixed(1)}%`
        : '';
      return `${r.pred_label}${p}`;
    }
    case 'tissue': {
      const bits = [];
      if (Number.isFinite(r.n_core_tiles)) bits.push(plural(r.n_core_tiles, 'tile', 'tiles'));
      if (Number.isFinite(Number(r.covered_mm2))) bits.push(`${Number(r.covered_mm2).toFixed(1)} mm²`);
      if (Number.isFinite(Number(r.tsr))) bits.push(`TSR ${(Number(r.tsr) * 100).toFixed(0)}%`);
      return bits.join(' · ');
    }
    case 'biomarker': {
      const bits = [];
      if (Number.isFinite(r.n_cells)) bits.push(plural(r.n_cells, 'cell', 'cells'));
      if (Number.isFinite(r.n_tiles)) bits.push(plural(r.n_tiles, 'tile', 'tiles'));
      return bits.join(' · ');
    }
    default:
      return '';
  }
}

/** How long ago, in the coarsest unit that is still true. '' for an unparseable timestamp. */
export function formatAge(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** Segment 4 — where the build got to, and when. A running build shows its progress instead. */
export function describeState(row, now = Date.now()) {
  const age = formatAge(row?.created_at, now);
  if (isInFlight(row)) {
    const pct = progressPercent(row);
    return pct > 0 ? `${stageLabel(row.stage)} ${pct}%` : stageLabel(row.stage);
  }
  if (row?.status === 'failed') return age ? `Failed · ${age}` : 'Failed';
  if (row?.status === 'cancelled') return age ? `Stopped · ${age}` : 'Stopped';
  return age;
}

// ── The row ──────────────────────────────────────────────────────────────────────────

/**
 * One artifact as the four things DataRow needs. `primary` is the block under the title;
 * `secondary` is the right-aligned state. Empty segments are dropped rather than rendered blank,
 * so a queued row is one line and a finished tissue map is two.
 */
export function describeArtifact(row, now = Date.now()) {
  const params = describeParams(row);
  const scale = describeScale(row);
  const state = describeState(row, now);
  const failed = row?.status === 'failed';
  return {
    key: row?.art_hash,
    title: kindLabel(row?.kind),
    // A failed build's reason belongs on the row. It is the only thing that row has to say, and
    // sending the user to a log for it would be the panel withholding what it already knows.
    primary: [params, scale, failed ? row?.error : ''].filter(Boolean),
    secondary: [state].filter(Boolean),
    canDraw: canDraw(row),
    failed,
  };
}

/** Newest first — the artifact you just built is the one you are looking for. */
export function sortArtifacts(rows) {
  return [...(rows || [])].sort(
    (a, b) => (Date.parse(b?.created_at) || 0) - (Date.parse(a?.created_at) || 0),
  );
}

export { isInFlight };
