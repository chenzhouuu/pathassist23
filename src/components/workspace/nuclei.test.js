// The nuclei artifact: what it stores, and how its mask is drawn (Inc 5 · 05-08; Inc 6 · 05).
//
// Was `panels/nucleiUtils.test.js`. Twelve assertions left with the panel they described — is a
// build running, what its Stop button says, how far along it is — because a nuclei run is a Girder
// job now and `analysis/runsUtils.test.js` asserts those questions about jobs, once, for every
// kind. What is here is what the two remaining readers need: the numbers the expanded Workspace
// row shows, and the tile URLs the mask is drawn from.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPACITY, classRows, classesOf, colorsOf, coverageSummary, formatArea, formatCount,
  hasInstances, hiddenIn, layerLevels, layerSignature, levelOffsetFor, resolveTaxonomy,
  taxonomiesOf, tileParams, totalNuclei, unlabelledTiles, withNucleiDefaults,
} from './nuclei.js';

const PANNUKE_CLASSES = ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'];

/**
 * An artifact's meta, in the shape the service sends since Inc 7: one entry per naming, each with
 * its own class list, palette, coverage and counts.
 */
const meta = ({ counts, area = 12.582, tiles = 3, outlineTiles = 3, extra = [] } = {}) => ({
  slide: { width: 4096, height: 4096, mpp: 0.25 },
  coverage: { n_tiles: outlineTiles },
  layers: { classes: { level_offset: 0, levels: 5 }, instances: { level_offset: 0, levels: 5 } },
  taxonomies: [
    {
      id: 'pannuke', label: 'PanNuke', organ: 'pan-organ (19 tissues)',
      classes: PANNUKE_CLASSES,
      display: Object.fromEntries(PANNUKE_CLASSES.map((c) => [c, c])),
      colors: { Neoplastic: '#D55E00', Connective: '#0072B2' },
      coverage: { n_tiles: tiles },
      summary: {
        n_nuclei: 1200, n_tiles: tiles, area_mm2: area,
        counts_by_class: counts
          || { Neoplastic: 800, Connective: 300, Inflammatory: 100 },
      },
    },
    ...extra,
  ],
});

const NUCLS = {
  id: 'nucls_super', label: 'NuCLS super', organ: 'breast (TCGA-BRCA)',
  classes: ['tumor_any', 'nonTIL_stromal', 'sTIL', 'other_nucleus'],
  display: { tumor_any: 'Tumour (any)', nonTIL_stromal: 'Stromal (non-TIL)', sTIL: 'sTIL',
             other_nucleus: 'Other' },
  colors: { tumor_any: '#D55E00', sTIL: '#009E73' },
  coverage: { n_tiles: 2 },
  summary: { n_nuclei: 700, n_tiles: 2, area_mm2: 8.4,
             counts_by_class: { tumor_any: 500, sTIL: 200 } },
};

describe('coverageSummary', () => {
  it('reports coverage as what the numbers are an account of', () => {
    expect(coverageSummary(meta({ tiles: 7, area: 29.36 }))).toEqual({ tiles: 7, mm2: 29.36 });
    expect(coverageSummary(meta({ tiles: 7, area: null }))).toEqual({ tiles: 7, mm2: null });
    expect(coverageSummary(null)).toBe(null);
  });

  it('is the naming\'s own coverage, not the artifact\'s', () => {
    // The case this exists for: a region segmented after a classify run has outlines nobody has
    // named, so a count reported over the artifact's tile list would be over a bigger area than
    // the number is an account of.
    const m = meta({ outlineTiles: 5, tiles: 5, extra: [NUCLS] });
    expect(coverageSummary(m, 'pannuke').tiles).toBe(5);
    expect(coverageSummary(m, 'nucls_super').tiles).toBe(2);
    expect(unlabelledTiles(m, 'nucls_super')).toBe(3);
    expect(unlabelledTiles(m, 'pannuke')).toBe(0);
  });
});

describe('classRows', () => {
  it('lists the classes in the taxonomy\'s order with their share of the total', () => {
    const rows = classRows(meta());
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic', 'Inflammatory', 'Connective']);
    expect(rows[0].count).toBe(800);
    expect(rows[0].fraction).toBeCloseTo(800 / 1200, 6);
  });

  it('omits a class the build found none of rather than claiming a zero', () => {
    const rows = classRows(meta({ counts: { Neoplastic: 5, Dead: 0 } }));
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic']);
  });

  it('still shows a class the taxonomy does not name, after the ones it does', () => {
    const rows = classRows(meta({ counts: { Unknown: 2, Neoplastic: 5 } }));
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic', 'Unknown']);
  });

  it('keys on the stored name and labels with the readable one', () => {
    // Rewording a label must not un-hide a class: the eye toggle keys on `name`.
    const rows = classRows(meta({ extra: [NUCLS] }), 'nucls_super');
    expect(rows.map((r) => r.name)).toEqual(['tumor_any', 'sTIL']);
    expect(rows.map((r) => r.label)).toEqual(['Tumour (any)', 'sTIL']);
  });

  it('survives an artifact with nothing stored yet', () => {
    expect(classRows(null)).toEqual([]);
    expect(totalNuclei(null)).toBe(0);
  });
});

describe('formatArea', () => {
  it('is empty when the slide never reported an mpp', () => {
    expect(formatArea(meta({ area: null }))).toBe('');
    expect(formatArea(meta({ area: 0 }))).toBe('');
  });

  it('rounds to something a person can read', () => {
    expect(formatArea(meta())).toBe('12.58 mm²');
  });
});

describe('picking a naming', () => {
  it('falls back to the one the artifact has when the store asks for one it does not', () => {
    // A taxonomy selected on a classified artifact must not blank the panel on one that has only
    // ever been segmented.
    expect(resolveTaxonomy(meta(), 'nucls_super')).toBe('pannuke');
    expect(resolveTaxonomy(meta({ extra: [NUCLS] }), 'nucls_super')).toBe('nucls_super');
    expect(resolveTaxonomy(null, 'nucls_super')).toBe('pannuke');
  });

  it('lists every naming the artifact carries, PanNuke first', () => {
    expect(taxonomiesOf(meta({ extra: [NUCLS] })).map((t) => t.id))
      .toEqual(['pannuke', 'nucls_super']);
    expect(taxonomiesOf(null)).toEqual([]);
  });

  it('hides classes per naming, because `Other` means different things in each', () => {
    const layer = { hidden: { pannuke: { Dead: true }, nucls_super: { other_nucleus: true } } };
    expect(hiddenIn(layer, 'pannuke')).toEqual({ Dead: true });
    expect(hiddenIn(layer, 'nucls_super')).toEqual({ other_nucleus: true });
    expect(hiddenIn(layer, 'midog')).toEqual({});
    expect(hiddenIn({}, 'pannuke')).toEqual({});
  });
});

// ── the layer (Inc 5 · 06) ─────────────────────────────────────────────────────────

const META = meta();

describe('the artifact describes its own layer', () => {
  it('takes the class list and palette from the artifact, not from the frontend', () => {
    expect(classesOf(META)).toEqual(PANNUKE_CLASSES);
    expect(colorsOf(META).Neoplastic).toBe('#D55E00');
  });

  it('takes them per naming, so switching recolours from the artifact\'s own palette', () => {
    const m = meta({ extra: [NUCLS] });
    expect(classesOf(m, 'nucls_super')).toEqual(NUCLS.classes);
    expect(colorsOf(m, 'nucls_super').sTIL).toBe('#009E73');
    // Tumour keeps one colour across namings — switching changes the subdivision, not the
    // colour language (Inc 7 D11).
    expect(colorsOf(m, 'nucls_super').tumor_any).toBe(colorsOf(m, 'pannuke').Neoplastic);
  });

  it('falls back to PanNuke order when meta says nothing, and to no palette at all', () => {
    expect(classesOf(null)[0]).toBe('Neoplastic');
    expect(colorsOf(null)).toEqual({});
  });

  it('reads the stored resolution and the pyramid depth off the artifact', () => {
    expect(levelOffsetFor(META)).toBe(0);
    expect(layerLevels(META)).toBe(5);
    expect(layerLevels(META, 'instances')).toBe(5);
  });

  it('offers the per-cell view only when the artifact carries that raster', () => {
    // One built before ticket 08 has class tiles and no ids until its next run redraws it.
    expect(hasInstances(META)).toBe(true);
    expect(hasInstances({ layers: { classes: { levels: 5 } } })).toBe(false);
    expect(hasInstances(null)).toBe(false);
  });

  it('reports no levels for a build with no picture, so the layer is not mounted', () => {
    expect(layerLevels({ slide: META.slide })).toBe(0);
    expect(layerLevels(null)).toBe(0);
  });
});

describe('tileParams', () => {
  const all = PANNUKE_CLASSES;

  it('omits show when nothing is hidden — a shorter URL is a better cache key', () => {
    expect(tileParams('classes', { show: all, opacity: 1, classes: all })).toEqual({});
  });

  it('names the classes still shown, sorted, so the URL is stable', () => {
    const p = tileParams('classes', { show: ['Connective', 'Neoplastic'], classes: all });
    expect(p.show).toBe('Connective,Neoplastic');
  });

  it('leaves opacity out of the URL — it is a layer property, not a tile one', () => {
    // The panel passes opacity: 1 here and applies the real value to the mounted layer, so
    // dragging the slider must not change a single tile URL.
    expect(tileParams('classes', { show: all, opacity: 1, classes: all }).alpha).toBeUndefined();
    expect(tileParams('classes', { opacity: 0.5 }).alpha).toBe('0.5');
  });

  it('does not filter the per-cell view by class', () => {
    // Its colours say which cell, not which kind — hiding a class there would remove cells
    // without saying what they had in common.
    const p = tileParams('instances', { show: ['Neoplastic'], classes: all });
    expect(p.show).toBeUndefined();
  });
});

describe('layerSignature', () => {
  it('changes when the picture changes and not when it does not', () => {
    const a = layerSignature('classes', 'n1', { show: 'Neoplastic' });
    expect(layerSignature('classes', 'n1', { show: 'Neoplastic' })).toBe(a);
    expect(layerSignature('classes', 'n1', { show: 'Dead' })).not.toBe(a);
    expect(layerSignature('classes', 'n2', { show: 'Neoplastic' })).not.toBe(a);
    // Switching the view is a different picture of the same artifact.
    expect(layerSignature('instances', 'n1', { show: 'Neoplastic' })).not.toBe(a);
    expect(layerSignature('classes', null, {})).toBe('none');
  });
});

describe('withNucleiDefaults', () => {
  it('is a patch over one set of defaults', () => {
    expect(withNucleiDefaults(null).opacity).toBe(DEFAULT_OPACITY);
    expect(withNucleiDefaults(null).render).toBe('classes');
    expect(withNucleiDefaults({ opacity: 0.2 }))
      .toEqual({ render: 'classes', opacity: 0.2, taxonomy: 'pannuke', hidden: {} });
  });
});

describe('formatCount', () => {
  it('is a thousands separator or nothing — never a zero standing in for a missing number', () => {
    expect(formatCount(15180)).toBe('15,180');
    expect(formatCount(undefined)).toBe('');
    expect(formatCount(null)).toBe('');
  });
});
