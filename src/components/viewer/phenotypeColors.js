// Cell phenotype (lineage) → copilot overlay colour (Inc 3a). Sibling of pannukeColors.js: the
// biomarker service emits a lineage *name* per cell; this maps a name to a canvas rgba. Keep the
// names in sync with the agent's markers.PHENOTYPE_ORDER / LINEAGE_RULES.
export const PHENOTYPE_COLOR = {
  Tumour:         'rgba(220, 38, 38, 0.85)',   // red
  Endothelial:    'rgba(236, 72, 153, 0.85)',  // pink
  'Plasma cell':  'rgba(245, 158, 11, 0.85)',  // amber
  'B cell':       'rgba(139, 92, 246, 0.85)',  // violet
  'Cytotoxic T':  'rgba(37, 99, 235, 0.85)',   // blue
  'Helper T':     'rgba(6, 182, 212, 0.85)',   // cyan
  'T cell':       'rgba(56, 189, 248, 0.85)',  // sky
  Myeloid:        'rgba(249, 115, 22, 0.85)',  // orange
  'Mast cell':    'rgba(180, 83, 9, 0.85)',    // brown
};

// Slate — the neutral default for an unclassified ("Other") or unknown-lineage cell.
export const DEFAULT_PHENOTYPE_COLOR = 'rgba(148, 163, 184, 0.8)';

export function colorForPhenotype(name) {
  return PHENOTYPE_COLOR[name] || DEFAULT_PHENOTYPE_COLOR;
}

// Canonical lineage order (matches the agent's markers.PHENOTYPE_ORDER), for a stable legend.
export const PHENOTYPE_ORDER = [
  'Tumour', 'Endothelial', 'Plasma cell', 'B cell', 'Cytotoxic T', 'Helper T', 'T cell',
  'Myeloid', 'Mast cell', 'Other',
];

// Distinct phenotypes actually present in an overlay, in canonical order (for the legend).
export function presentPhenotypes(pheno) {
  const set = new Set((pheno?.classes || []).filter(Boolean));
  return PHENOTYPE_ORDER.filter((n) => set.has(n));
}
