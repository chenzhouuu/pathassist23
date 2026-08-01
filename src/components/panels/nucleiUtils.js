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

export function isStopped(row) {
  return row?.status === 'cancelled';
}

export function progressPercent(row) {
  const p = Number(row?.progress);
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

/** What the build is doing, in the words the panel shows. */
export function describeStage(row) {
  if (!row) return 'Not built';
  if (row.status === 'ready') return 'Ready';
  if (row.status === 'failed') return 'Failed';
  if (row.status === 'cancelled') return 'Stopped';
  if (isRunning(row)) return `Working ${progressPercent(row)}%`;
  return row.status || 'Unknown';
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
