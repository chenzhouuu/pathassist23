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
  hasInstances, layerLevels, layerSignature, levelOffsetFor, tileParams, totalNuclei,
  withNucleiDefaults,
} from './nuclei.js';

const summary = (over = {}) => ({
  n_nuclei: 1200, n_tiles: 3, area_mm2: 12.582,
  counts_by_class: { Neoplastic: 800, Connective: 300, Inflammatory: 100 },
  ...over,
});

describe('coverageSummary', () => {
  it('reports coverage as what the numbers are an account of', () => {
    expect(coverageSummary({ coverage: { n_tiles: 7 }, summary: { area_mm2: 29.36 } }))
      .toEqual({ tiles: 7, mm2: 29.36 });
    expect(coverageSummary({ coverage: { n_tiles: 7 } })).toEqual({ tiles: 7, mm2: null });
    expect(coverageSummary(null)).toBe(null);
  });
});

describe('classRows', () => {
  it('lists the classes in PanNuke order with their share of the total', () => {
    const rows = classRows(summary());
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic', 'Inflammatory', 'Connective']);
    expect(rows[0].count).toBe(800);
    expect(rows[0].fraction).toBeCloseTo(800 / 1200, 6);
  });

  it('omits a class the build found none of rather than claiming a zero', () => {
    const rows = classRows(summary({ counts_by_class: { Neoplastic: 5, Dead: 0 } }));
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic']);
  });

  it('still shows a class the taxonomy does not name, after the ones it does', () => {
    const rows = classRows(summary({ counts_by_class: { Unknown: 2, Neoplastic: 5 } }));
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic', 'Unknown']);
  });

  it('survives an artifact with nothing stored yet', () => {
    expect(classRows(null)).toEqual([]);
    expect(totalNuclei(null)).toBe(0);
  });
});

describe('formatArea', () => {
  it('is empty when the slide never reported an mpp', () => {
    expect(formatArea(summary({ area_mm2: null }))).toBe('');
    expect(formatArea(summary({ area_mm2: 0 }))).toBe('');
  });

  it('rounds to something a person can read', () => {
    expect(formatArea(summary())).toBe('12.58 mm²');
  });
});

// ── the layer (Inc 5 · 06) ─────────────────────────────────────────────────────────

const META = {
  slide: { width: 4096, height: 4096, mpp: 0.25 },
  classes: ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'],
  colors: { Neoplastic: '#D55E00', Connective: '#0072B2' },
  layers: { classes: { level_offset: 0, levels: 5 }, instances: { level_offset: 0, levels: 5 } },
};

describe('the artifact describes its own layer', () => {
  it('takes the class list and palette from the artifact, not from the frontend', () => {
    expect(classesOf(META)).toEqual(META.classes);
    expect(colorsOf(META).Neoplastic).toBe('#D55E00');
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
  const all = META.classes;

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
      .toEqual({ render: 'classes', opacity: 0.2, hidden: {} });
  });
});

describe('formatCount', () => {
  it('is a thousands separator or nothing — never a zero standing in for a missing number', () => {
    expect(formatCount(15180)).toBe('15,180');
    expect(formatCount(undefined)).toBe('');
    expect(formatCount(null)).toBe('');
  });
});
