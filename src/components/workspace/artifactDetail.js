// src/components/workspace/artifactDetail.js — what an artifact row says when it is opened.
//
// One registry, keyed by kind (Inc 6 · 04). An entry says three things: which slice of the store
// holds that kind's layer parameters, how to fill in the parameters nobody has set, and how to
// turn the artifact's stored meta into the three blocks the expanded row draws —
//
//   stats     the numbers the artifact stores, as label/value pairs
//   segments  one row per class: colour, count, fraction, and whether it is drawn
//   config    the controls the layer is drawn with — render modes and opacity
//
// Nuclei is the only entry this ticket fills. Tissue and biomarker are 06 and are meant to arrive
// as two more entries rather than as a second copy of this file, which is why nothing below
// branches on kind outside the table.
//
// Everything here reads the artifact's *own* meta, never the call that made it. That is what makes
// the numbers survive a reload: they came off disk, and the palette they are coloured with came
// off the same object as the mask on the slide, so a swatch and the picture cannot disagree.
import {
  RENDERS, RENDER_LABEL, classRows, colorsOf, coverageSummary, formatArea, formatCount,
  hasInstances, layerLevels, totalNuclei, withNucleiDefaults,
} from '../panels/nucleiUtils.js';

/** The name a class is stored and displayed under has to be the same string, or hiding breaks. */
const segment = (name, count, fraction, colors, hidden) => ({
  key: name,
  label: name,
  colorHex: colors[name] || '#888888',
  count,
  fraction,
  visible: !hidden[name],
});

const DETAILS = Object.freeze({
  nuclei: {
    // The layer's settings live in the store, not in this panel: the mask keeps rendering while
    // the Workspace is closed, and the right panel unmounts a panel on every tab switch. The
    // Workspace is where they are *edited*, which is not where they live.
    layerKey: 'nucleiLayerParams',
    setterKey: 'setNucleiLayerParams',
    withDefaults: withNucleiDefaults,

    detail(meta, layer) {
      const summary = meta?.summary || null;
      const cov = coverageSummary(meta);
      const n = totalNuclei(summary);
      const colors = colorsOf(meta);
      const area = formatArea(summary);

      const stats = [];
      // Coverage first, because it is what everything under it is a complete account *of*: a count
      // over 3 % of a slide and a count over all of it are not the same claim.
      if (cov) {
        stats.push({
          key: 'covered',
          label: 'Covered',
          value: `${cov.tiles} ${cov.tiles === 1 ? 'tile' : 'tiles'}`
            + (cov.mm2 ? ` · ${cov.mm2.toFixed(2)} mm²` : ''),
        });
      }
      // "Total", not "Nuclei": the row this opens under is already called Nuclei, and a label that
      // repeats its own heading is a line the reader has to discard.
      if (n > 0) stats.push({ key: 'total', label: 'Total', value: formatCount(n) });
      if (area) stats.push({ key: 'area', label: 'Area', value: area });

      return {
        stats,
        // Hiding a class removes it from the *picture*. Its count stays in this list either way —
        // hiding a class from the map must not hide it from the arithmetic.
        segments: n > 0
          ? classRows(summary).map(c => segment(c.name, c.count, c.fraction, colors, layer.hidden))
          : [],
        config: {
          // Offered only once the per-cell plane exists: an artifact built before ticket 08 has
          // one on its next run, and a mode button that renders nothing is worse than no button.
          modes: hasInstances(meta)
            ? RENDERS.map(r => ({ value: r, label: RENDER_LABEL[r] }))
            : [],
          mode: layer.render,
          opacity: layer.opacity,
          // Nothing to tune until there is a picture to tune. `layerLevels` is 0 while a build has
          // stored polygons but not yet rasterised them.
          drawn: layerLevels(meta) > 0,
          note: layer.render === 'instances' && hasInstances(meta)
            ? 'A colour per cell, not per class — so touching nuclei read as separate. '
              + 'The colours carry no meaning of their own.'
            : null,
        },
      };
    },

    /** Turning a segment's eye into a layer patch. The store holds `hidden`, the row shows `visible`. */
    toggleSegment(layer, key) {
      return { hidden: { ...layer.hidden, [key]: !layer.hidden[key] } };
    },
  },
});

/** Whether this kind has moved its controls into the Workspace yet. */
export function hasDetail(kind) {
  return Object.prototype.hasOwnProperty.call(DETAILS, kind);
}

/** Which store slice a kind's layer lives in, and how to fill in what nobody has set. */
export function layerBinding(kind) {
  const entry = DETAILS[kind];
  if (!entry) return null;
  return {
    layerKey: entry.layerKey,
    setterKey: entry.setterKey,
    withDefaults: entry.withDefaults,
    toggleSegment: entry.toggleSegment,
  };
}

/**
 * The three blocks an opened row draws, or null for a kind that has not moved across.
 *
 * `meta` is the artifact's stored metadata; `layer` is the store's parameters for that kind, with
 * defaults already applied. Passing both rather than reading the store keeps this testable without
 * a React tree, which is where the interesting cases are — a build with no raster yet, a class the
 * run found none of, an artifact whose palette predates a class.
 */
export function detailFor(kind, meta, layer) {
  const entry = DETAILS[kind];
  if (!entry) return null;
  return entry.detail(meta || null, entry.withDefaults(layer));
}
