// PanNuke class → copilot overlay colour. Mirrors CellViT COLOR_DICT_CELLS (vendored — the
// service emits class *names*; this maps a name to a canvas rgba). Keep in sync with the agent's
// pannuke.CLASS_HEX and the CellViT service pannuke.TYPE_NAMES.
export const CLASS_COLOR = {
  Neoplastic:   'rgba(255, 0, 0, 0.85)',
  Inflammatory: 'rgba(34, 221, 77, 0.85)',
  Connective:   'rgba(35, 92, 236, 0.85)',
  Dead:         'rgba(254, 255, 0, 0.85)',
  Epithelial:   'rgba(255, 159, 68, 0.85)',
};

// Cyan — the safe default for an unknown / legacy (null-class) nucleus (today's overlay colour).
export const DEFAULT_NUCLEUS_COLOR = 'rgba(34, 211, 238, 0.85)';

export function colorForClass(name) {
  return CLASS_COLOR[name] || DEFAULT_NUCLEUS_COLOR;
}

// Distinct class names actually present in an overlay, in canonical PanNuke order (for the legend).
const ORDER = ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'];
export function presentClasses(nuclei) {
  const set = new Set((nuclei?.classes || []).filter(Boolean));
  return ORDER.filter((n) => set.has(n));
}
