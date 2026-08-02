// src/components/workspace/artifactDetail.js — what an artifact row says when it is opened.
//
// One registry, keyed by kind (Inc 6 · 04). An entry says four things: which slice of the store
// holds that kind's layer parameters, how to fill in the parameters nobody has set, how to turn a
// control back into a store patch, and how to turn the artifact's stored meta into the three
// blocks the expanded row draws —
//
//   stats     the numbers the artifact stores, as label/value pairs
//   segments  one row per class, phenotype or channel: colour, count, fraction, and whether it is
//             drawn
//   config    the controls the layer is drawn with — modes, opacity, and whatever else that kind
//             actually has
//
// Nuclei arrived in 04; tissue and biomarker in 06, as two more entries rather than as a second
// copy of this file, which is why nothing outside the table branches on kind. What the two of them
// added was breadth: a tissue map has a confidence ramp and an H&E fade, and a marker map has a
// panel preset, a channel list and a display transfer function. So `config` grew from
// modes+opacity into a small vocabulary — `choices`, `toggles`, `sliders`, `actions` — that
// `ArtifactConfig` renders without knowing what any of them mean.
//
// Everything here reads the artifact's *own* meta, never the call that made it. That is what makes
// the numbers survive a reload: they came off disk, and the palette they are coloured with came
// off the same object as the picture on the slide, so a swatch and the map cannot disagree. The
// one exception is the marker vocabulary and phenotype palette, which live in the service's
// catalog rather than in any artifact — passed in as `catalog`, from the same call
// `ArtifactLayers` makes.
import {
  DEFAULT_DISPLAY, MODES, MODE_LABEL, coverageSummary as markerCoverage, markerLabel,
  phenotypeLegend, presetChannels, presetNames, separableMarkers, withMarkerDefaults,
} from './markers.js';
import {
  RENDERS, RENDER_LABEL, classRows, colorsOf, coverageSummary, formatArea, formatCount,
  hasInstances, layerLevels, totalNuclei, withNucleiDefaults,
} from './nuclei.js';
import {
  RENDERS as TISSUE_RENDERS, RENDER_LABEL as TISSUE_RENDER_LABEL,
  colorsOf as tissueColorsOf, compositionCsv, compositionRows,
  coverageSummary as tissueCoverage, tsrOf, withTissueDefaults,
} from './tissue.js';

/** The name a class is stored and displayed under has to be the same string, or hiding breaks. */
const segment = (name, count, fraction, colors, hidden) => ({
  key: name,
  label: name,
  colorHex: colors[name] || '#888888',
  count,
  fraction,
  visible: !hidden[name],
});

const modes = (values, labels) => values.map(v => ({ value: v, label: labels[v] }));

/** The H&E under a dense layer. Every drawable kind but nuclei has one, and it is the same slider. */
const heFadeSlider = (v) => ({ key: 'heFade', label: 'H&E', value: v, min: 0, max: 1, step: 0.05 });

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
          modes: hasInstances(meta) ? modes(RENDERS, RENDER_LABEL) : [],
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

    patch(layer, key, value) {
      return { [key === 'mode' ? 'render' : key]: value };
    },
  },

  // ── tissue (Inc 6 · 06) ────────────────────────────────────────────────────────────
  tissue: {
    layerKey: 'tissueLayerParams',
    setterKey: 'setTissueLayerParams',
    withDefaults: withTissueDefaults,

    detail(meta, layer) {
      const cov = tissueCoverage(meta);
      const tsr = tsrOf(meta);
      const rows = compositionRows(meta, null, null);
      const colors = tissueColorsOf(meta, null, null);
      // The tissue service writes its meta only after the pyramid, so meta existing *is* a raster
      // existing — the same test `ArtifactLayers` mounts on, deliberately, so the controls appear
      // exactly when there is a picture to point them at.
      const drawn = !!meta;

      const stats = [];
      if (cov) {
        stats.push({
          key: 'covered',
          label: 'Covered',
          value: `${cov.tiles} ${cov.tiles === 1 ? 'tile' : 'tiles'}`
            + (cov.mm2 != null ? ` · ${cov.mm2} mm²` : ''),
        });
      }
      // A number, never a category. Reported as stroma / (tumour + stroma) — the same figure the
      // artifact stores, not one recomputed from the fractions above it.
      if (tsr != null) stats.push({ key: 'tsr', label: 'TSR', value: tsr.toFixed(3) });

      return {
        stats,
        segments: rows
          // A class the artifact has no fraction for is a class this map cannot speak about; a row
          // of dashes would read as "none of it", which is a different claim.
          .filter(r => r.fraction != null)
          .map(r => ({
            key: r.name,
            label: r.name,
            colorHex: colors[r.name] || r.color,
            fraction: r.fraction,
            visible: !layer.hidden[r.name],
            // Hard and soft differ exactly where the model was unsure, and that difference is
            // information — carried only when it is big enough to mean something.
            note: r.soft != null && Math.abs(r.soft - r.fraction) >= 0.005
              ? `soft ${(r.soft * 100).toFixed(1)}%` : null,
          })),
        config: {
          drawn,
          modes: modes(TISSUE_RENDERS, TISSUE_RENDER_LABEL),
          mode: layer.render,
          opacity: layer.opacity,
          toggles: layer.render === 'classes'
            ? [{ key: 'conf', label: 'Alpha follows confidence', value: layer.conf }]
            : [],
          sliders: [
            ...(layer.render === 'classes' && layer.conf
              ? [{ key: 'confFloor', label: 'Faintest', value: layer.confFloor,
                   min: 0, max: 1, step: 0.05 }]
              : []),
            heFadeSlider(layer.heFade),
          ],
          // The panel's Export CSV, kept: a composition is a measurement, and a measurement people
          // are expected to write up has to be able to leave the browser. The file carries the
          // covered area and the backend on every row, because a fraction over 3 % of a slide and
          // a fraction over all of it are not the same number.
          actions: cov
            ? [{ key: 'csv', label: 'Export CSV',
                 download: { name: 'composition.csv', type: 'text/csv',
                             text: compositionCsv(meta, null, null) } }]
            : [],
          note: null,
        },
      };
    },

    toggleSegment(layer, key) {
      return { hidden: { ...layer.hidden, [key]: !layer.hidden[key] } };
    },

    patch(layer, key, value) {
      return { [key === 'mode' ? 'render' : key]: value };
    },
  },

  // ── biomarker (Inc 6 · 06) ─────────────────────────────────────────────────────────
  //
  // Two mutually exclusive pictures (Inc 3b · D8), and the mode is what the whole panel is about:
  // it decides what the segment list is a list *of*. Markers mode lists the channels being
  // composited; Phenotype mode lists the cell lineages. Stacking them was rejected because a
  // marker composite and a phenotype map are both dense and saturated, and neither survives the
  // other — so this is one segmented control, not two eyes.
  biomarker: {
    layerKey: 'markerLayerParams',
    setterKey: 'setMarkerLayerParams',
    withDefaults: withMarkerDefaults,

    detail(meta, layer, catalog) {
      const cov = markerCoverage(meta);
      const cells = meta?.summary?.n_cells;
      const legend = phenotypeLegend(meta);
      const separable = separableMarkers(meta);
      const markers = layer.mode === 'markers';

      const stats = [];
      if (cov) {
        stats.push({
          key: 'covered', label: 'Covered',
          value: `${cov.tiles} ${cov.tiles === 1 ? 'tile' : 'tiles'} · ${cov.mm2} mm²`,
        });
      }
      if (Number.isFinite(cells)) {
        stats.push({ key: 'cells', label: 'Cells', value: Number(cells).toLocaleString() });
      }

      const total = legend.reduce((a, l) => a + l.count, 0);
      const unused = (catalog?.markers || []).filter(
        m => !(layer.channels || []).some(c => c.marker === m),
      );

      return {
        stats,
        segments: markers
          ? (layer.channels || []).map(c => ({
              key: c.marker,
              label: markerLabel(catalog, c.marker),
              colorHex: c.color,
              visible: c.enabled !== false,
              // A marker whose threshold came out null could not be split into a positive and a
              // negative population on this slide. It is still viewable as a channel — saying so
              // is the difference between "not measurable here" and "all negative".
              note: separable.length && !separable.includes(c.marker)
                ? 'no separable positive population' : null,
            }))
          : legend.map(l => ({
              key: l.name,
              label: l.name,
              colorHex: catalog?.phenotype_colors?.[l.name] || '#888888',
              count: l.count,
              fraction: total ? l.count / total : null,
              visible: !layer.hidden[l.name],
            })),
        config: {
          drawn: !!meta,
          modes: modes(MODES, MODE_LABEL),
          mode: layer.mode,
          // No opacity. The marker composite's strength is its display transfer function, below —
          // an alpha on top of it would be a second brightness control fighting the first.
          opacity: null,
          choices: markers
            ? [
                { key: 'preset', label: 'Panel', value: layer.preset,
                  options: presetNames(catalog).map(n => ({ value: n, label: n })) },
                // A select that adds rather than selects: it always reads "Add a marker…", and
                // picking one appends it to the composite. The alternative is a chip cloud, which
                // is the one thing this row has no width for.
                ...(unused.length
                  ? [{ key: 'addMarker', label: 'Add', value: '',
                       options: [{ value: '', label: 'Add a marker…' },
                                 ...unused.map(m => ({ value: m, label: m }))] }]
                  : []),
              ]
            : [],
          toggles: markers
            ? [{ key: 'dapiOn', label: 'DAPI (nuclear reference)', value: layer.dapiOn }]
            : [],
          sliders: markers
            ? [
                ...(layer.dapiOn
                  ? [{ key: 'dapiW', label: 'DAPI', value: layer.dapiW,
                       min: 0, max: 1, step: 0.05 }]
                  : []),
                { key: 'display.lo', label: 'Low', value: layer.display.lo,
                  min: 0, max: 1, step: 0.05 },
                { key: 'display.hi', label: 'High', value: layer.display.hi,
                  min: 0, max: 1, step: 0.05 },
                { key: 'display.gamma', label: 'Gamma', value: layer.display.gamma,
                  min: 0.2, max: 2, step: 0.05 },
                heFadeSlider(layer.heFade),
              ]
            : [heFadeSlider(layer.heFade)],
          actions: [],
          // Every number this artifact carries is a predicted positivity, and the row is where
          // that has to be said — the panel that used to say it is gone.
          note: 'Predicted marker-positivity probability from H&E — not a stain, not a '
            + 'measurement. Positivity is relative to this slide.',
        },
      };
    },

    /** Markers mode hides a channel from the composite; phenotype mode hides a lineage. */
    toggleSegment(layer, key) {
      if (layer.mode !== 'markers') {
        return { hidden: { ...layer.hidden, [key]: !layer.hidden[key] } };
      }
      return {
        channels: (layer.channels || []).map(
          c => (c.marker === key ? { ...c, enabled: c.enabled === false } : c),
        ),
      };
    },

    recolourSegment(layer, key, colorHex) {
      if (layer.mode !== 'markers') return null;
      return {
        channels: (layer.channels || []).map(
          c => (c.marker === key ? { ...c, color: colorHex } : c),
        ),
      };
    },

    patch(layer, key, value, catalog) {
      // Picking a preset replaces the whole channel set. The colours in a preset were chosen to be
      // separable *together* under additive compositing, so carrying half of one across is how a
      // composite becomes illegible.
      if (key === 'preset') return { preset: value, channels: presetChannels(catalog, value) };
      if (key === 'addMarker') {
        if (!value || (layer.channels || []).some(c => c.marker === value)) return null;
        return { channels: [...(layer.channels || []),
                            { marker: value, color: '#ffffff', enabled: true }] };
      }
      if (key.startsWith('display.')) {
        const field = key.slice('display.'.length);
        return { display: { ...DEFAULT_DISPLAY, ...layer.display, [field]: value } };
      }
      return { [key]: value };
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
    // Only the marker map has editable colours; withholding the function is what leaves the
    // other kinds' rows without the menu entry (the same rule DataRow uses for every callback).
    recolourSegment: entry.recolourSegment || null,
    patch: entry.patch,
  };
}

/**
 * The three blocks an opened row draws, or null for a kind that has not moved across.
 *
 * `meta` is the artifact's stored metadata; `layer` is the store's parameters for that kind, with
 * defaults already applied; `catalog` is the owning service's vocabulary, for the one kind whose
 * palette is not in its own artifact. Passing all three rather than reading the store keeps this
 * testable without a React tree, which is where the interesting cases are — a build with no raster
 * yet, a class the run found none of, an artifact whose palette predates a class.
 */
export function detailFor(kind, meta, layer, catalog = null) {
  const entry = DETAILS[kind];
  if (!entry) return null;
  return entry.detail(meta || null, entry.withDefaults(layer, catalog), catalog);
}
