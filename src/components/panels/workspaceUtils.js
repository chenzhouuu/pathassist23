// src/components/panels/workspaceUtils.js — artifact row → the four things a Workspace row says.
//
// The layout is Inc 5 §5.2: kind · params · scale · state+age. Everything here is read off the
// `params` and `result` JSONB the gateway already stores, so the panel adds no server fields and
// makes no second call per row.
//
// One rule runs through the whole file: say what the row actually carries, and say nothing when it
// carries nothing. A missing number renders as an omitted phrase, never as a zero or a guess —
// "0 patches" and "unknown" both read as facts, and neither would be one.
import { SWITCHABLE_KINDS } from '../viewer/ArtifactLayers.jsx';

/** A count, or nothing. Never a zero standing in for a number the row does not have. */
export function fmtInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '';
}

export const KIND_LABEL = Object.freeze({
  segmentation: 'Segmentation',
  patching: 'Patching',
  features: 'Features',
  prediction: 'Prediction',
  tissue: 'Tissue map',
  biomarker: 'Biomarker map',
  nuclei: 'Nuclei',
  // Not an artifact kind — no `classify` row is ever written, because a classification names the
  // cells of the nuclei artifact it was handed. It is here because a *run* of that kind can still
  // reach this table through `describeGhost`, and a row reading "classify" would be the only place
  // in the UI where a raw route name is shown to a user.
  classify: 'Cell classification',
});

// Kinds with something to put on the slide. The rest are still listed — they answer "what has this
// slide cost me" — but they get no eye (Inc 5 D2).
export const DRAWABLE = Object.freeze(['segmentation', 'tissue', 'biomarker', 'nuclei']);

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || 'Artifact';
}

export function canDraw(row) {
  return DRAWABLE.includes(row?.kind);
}

/**
 * Whether the eye is offered for this row. Every drawable kind has a working eye since 03b, so
 * this is `canDraw` — it stays a separate name because it asks a different question of the same
 * answer: `canDraw` is about the artifact, this is about what the viewer can mount.
 */
export function canSwitch(row) {
  return SWITCHABLE_KINDS.includes(row?.kind);
}

// ── The four segments ────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/**
 * Which pipeline produced this artifact, when that is worth saying.
 *
 * Only the stub. The preprocess service ships a GPU-free stub — a synthetic 4096 px tissue square,
 * the same coords for every slide — beside the real Trident path, and since Inc 6 · 05 the two have
 * separate content addresses, so both can be on one slide at once. A row built by the stub has to
 * say so: its numbers are about a placeholder. A row built by the real thing needs no badge,
 * because that is what a row is expected to be.
 */
const implNote = (p) => (p?.impl && p.impl !== 'trident' ? p.impl : '');

/** Segment 2 — what it was built with. '' when the row records nothing worth naming. */
export function describeParams(row) {
  const p = row?.params || {};
  const bits = [];
  switch (row?.kind) {
    case 'segmentation':
      if (p.segmenter) bits.push(p.segmenter);
      if (Number.isFinite(Number(p.seg_conf_thresh))) bits.push(`conf ${p.seg_conf_thresh}`);
      if (implNote(p)) bits.push(implNote(p));
      break;
    case 'patching':
      if (p.patch_size) bits.push(`${p.patch_size} px`);
      if (p.mag) bits.push(`${p.mag}×`);
      if (Number(p.overlap) > 0) bits.push(`overlap ${p.overlap}`);
      if (implNote(p)) bits.push(implNote(p));
      break;
    case 'features':
      if (p.encoder) bits.push(p.encoder);
      if (implNote(p)) bits.push(implNote(p));
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
    case 'nuclei':
      // The backend only. `scope` is on the row and is deliberately not shown (Inc 6 · 05): a
      // nuclei artifact is built by however many runs it took, each with its own scope, and the
      // row records the one that created it. Showing that as the artifact's own would say
      // "region" about a map that three later runs extended over the whole slide. What the
      // artifact actually covers is `describeScale`, off its coverage record.
      if (p.backend) bits.push(p.backend);
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
    case 'nuclei': {
      const bits = [];
      if (Number.isFinite(r.n_nuclei)) bits.push(plural(r.n_nuclei, 'nucleus', 'nuclei'));
      if (Number.isFinite(Number(r.area_mm2))) bits.push(`${Number(r.area_mm2).toFixed(2)} mm²`);
      // The class mix, biggest first — the row says what this slide is made of, not just how much.
      const mix = Object.entries(r.counts_by_class || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
      if (mix.length) bits.push(mix.join('/'));
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

/**
 * Segment 4 — when this artifact was made, and whether the run that made it finished.
 *
 * No progress, and no failure: from Inc 6 · 07 a row exists only where bytes do, so there is no
 * such thing as a row that is 40 % built or one that failed. Both of those are runs, and runs are
 * in the Runs feed. What is left that a row can say about itself is that its run was **stopped**,
 * which is not a state — it is a fact about how much of the slide the numbers beside it cover.
 */
export function describeState(row, now = Date.now()) {
  const age = formatAge(row?.created_at, now);
  if (row?.status === 'cancelled') return age ? `Stopped · ${age}` : 'Stopped';
  return age;
}

// ── The row ──────────────────────────────────────────────────────────────────────────

/**
 * One artifact as the things DataRow needs. `primary` is the block under the title; `secondary` is
 * the right-aligned state. Empty segments are dropped rather than rendered blank, so a bare
 * segmentation is one line and a finished tissue map is two.
 */
export function describeArtifact(row, now = Date.now()) {
  const params = describeParams(row);
  const scale = describeScale(row);
  const state = describeState(row, now);
  return {
    key: row?.art_hash,
    kind: row?.kind,
    title: kindLabel(row?.kind),
    canSwitch: canSwitch(row),
    primary: [params, scale].filter(Boolean),
    secondary: [state].filter(Boolean),
    canDraw: canDraw(row),
    // The row itself, for the one kind whose detail *is* the row — a prediction's whole result is
    // already stored here (`metaIsRow`), so fetching a meta document would be a call to rediscover
    // what is in hand.
    row,
  };
}

/**
 * Bytes as the unit a person would say them in. Deliberately coarse: this appears in a delete
 * confirmation, where "290 MB" is the whole point and "290.4 MB" is noise.
 */
export function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** One dependant, said the way the rows say themselves — never a bare hash. */
export function describeDependant(dep) {
  const params = describeParams(dep);
  return params ? `${kindLabel(dep?.kind)} (${params})` : kindLabel(dep?.kind);
}

/** Newest first — the artifact you just built is the one you are looking for. */
export function sortArtifacts(rows) {
  return [...(rows || [])].sort(
    (a, b) => (Date.parse(b?.created_at) || 0) - (Date.parse(a?.created_at) || 0),
  );
}
