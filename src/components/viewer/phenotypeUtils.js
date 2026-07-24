// Pure helpers for the phenotype overlay (Inc 3a) — counts, legend tallies, and the hover tooltip.
// Kept pure + unit-tested (like preprocessUtils.js); the overlay component consumes them.

// Per-lineage counts from the geometry's `classes` array (the numbers are always tool-derived).
export function phenotypeCounts(pheno) {
  const counts = {};
  for (const name of pheno?.classes || []) {
    if (name) counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

// Per functional-flag tallies across the cells (e.g. how many PD-1+ / Proliferating).
export function flagCounts(pheno) {
  const counts = {};
  for (const c of pheno?.cells || []) {
    for (const f of c.flags || []) counts[f] = (counts[f] || 0) + 1;
  }
  return counts;
}

// A legend row's label: "68 Cytotoxic T". Count comes from phenotypeCounts.
export function legendLabel(name, counts) {
  return `${counts[name] || 0} ${name}`;
}

// The hover tooltip text for one cell: lineage, flags, and its gate-deciding marker probabilities.
// Probabilities are region-relative predictions (never intensities) — shown to two decimals.
export function cellTooltip(cell) {
  if (!cell) return '';
  const parts = [cell.phenotype || 'Unclassified'];
  if (cell.flags && cell.flags.length) parts.push(cell.flags.join(', '));
  const markers = cell.markers || {};
  const names = Object.keys(markers);
  if (names.length) {
    const shown = names
      .sort((a, b) => markers[b] - markers[a])
      .slice(0, 4)
      .map((m) => `${m} ${Number(markers[m]).toFixed(2)}`)
      .join(', ');
    parts.push(shown);
  }
  return parts.join(' · ');
}

// Index of the nearest cell to a screen point within `maxDist` px, or -1. `project(i)` maps cell i
// to {x, y} screen coords; kept injectable so this stays pure/testable (no OSD in the test).
export function nearestCell(points, project, sx, sy, maxDist = 8) {
  let best = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < points.length; i++) {
    const p = project(i);
    if (!p) continue;
    const d2 = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
