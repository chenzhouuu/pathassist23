// What an opened artifact row says (Inc 6 · 04).
//
// The meta below is the shape the cellvit service really stores — read back off disk, which is the
// point of the module: reload the page and the same counts come back.
import { describe, expect, it } from 'vitest';
import { detailFor, hasDetail, layerBinding } from './artifactDetail.js';

const META = {
  summary: {
    n_nuclei: 15180,
    area_mm2: 19.28425585508351,
    counts_by_class: {
      Connective: 10955, Neoplastic: 3836, Inflammatory: 168, Epithelial: 221,
    },
  },
  coverage: { n_tiles: 72 },
  classes: ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'],
  colors: {
    Neoplastic: '#e94560', Inflammatory: '#4da6ff', Connective: '#4caf82',
    Dead: '#888888', Epithelial: '#f5a623',
  },
  layers: { classes: { levels: 5, level_offset: 2 }, instances: { levels: 5, level_offset: 2 } },
};

const detail = (over = {}, layer = {}) => detailFor('nuclei', { ...META, ...over }, layer);

describe('which kinds have moved across', () => {
  it('is nuclei, and only nuclei, in this ticket', () => {
    expect(hasDetail('nuclei')).toBe(true);
    // 06 adds these two as entries in the same table, not as a second copy of the module.
    expect(hasDetail('tissue')).toBe(false);
    expect(hasDetail('biomarker')).toBe(false);
  });

  it('never has detail for a kind with nothing to draw', () => {
    expect(hasDetail('features')).toBe(false);
    expect(detailFor('features', META, {})).toBeNull();
  });
});

describe('the numbers the artifact stores', () => {
  it('leads with coverage, because it is what the counts are an account of', () => {
    expect(detail().stats[0]).toEqual({
      key: 'covered', label: 'Covered', value: '72 tiles · 19.28 mm²',
    });
  });

  it('reports the total and the area it was measured over', () => {
    const byKey = Object.fromEntries(detail().stats.map(s => [s.key, s.value]));
    expect(byKey.total).toBe('15,180');
    expect(byKey.area).toBe('19.28 mm²');
    // Not "Nuclei" — the row this opens under is already called that.
    expect(detail().stats.find(s => s.key === 'total').label).toBe('Total');
  });

  it('says nothing about a number the artifact does not carry', () => {
    // A slide with no mpp has no area. An omitted row is a fact; "0 mm²" would not be one.
    const stats = detail({ summary: { ...META.summary, area_mm2: undefined } }).stats;
    expect(stats.find(s => s.key === 'area')).toBeUndefined();
    expect(stats.find(s => s.key === 'total')).toBeTruthy();
  });

  it('has no coverage row for an artifact that recorded none', () => {
    expect(detail({ coverage: undefined }).stats.find(s => s.key === 'covered')).toBeUndefined();
  });
});

describe('one row per class', () => {
  it('is in PanNuke order with counts and fractions', () => {
    const segs = detail().segments;
    expect(segs.map(s => s.label)).toEqual(
      ['Neoplastic', 'Inflammatory', 'Connective', 'Epithelial']);
    const conn = segs.find(s => s.label === 'Connective');
    expect(conn.count).toBe(10955);
    expect(conn.fraction).toBeCloseTo(10955 / 15180);
  });

  it('omits a class the run found none of', () => {
    // `Dead` is in the palette and in the class list, and the region had none. A zero row would be
    // a claim about biology that a region-scale count cannot support.
    expect(detail().segments.find(s => s.label === 'Dead')).toBeUndefined();
  });

  it('takes its colour off the artifact, so a swatch cannot drift from the mask', () => {
    expect(detail().segments.find(s => s.label === 'Neoplastic').colorHex).toBe('#e94560');
  });

  it('falls back to grey for a class the palette predates', () => {
    const segs = detail({ colors: { Neoplastic: '#e94560' } }).segments;
    expect(segs.find(s => s.label === 'Connective').colorHex).toBe('#888888');
  });

  it('reads a hidden class as not visible, and still counts it', () => {
    const segs = detail({}, { hidden: { Connective: true } }).segments;
    const conn = segs.find(s => s.label === 'Connective');
    expect(conn.visible).toBe(false);
    expect(conn.count).toBe(10955);
  });

  it('has no rows at all before anything has been counted', () => {
    expect(detail({ summary: { n_nuclei: 0, counts_by_class: {} } }).segments).toEqual([]);
  });
});

describe('the controls the layer is drawn with', () => {
  it('offers both views once the per-cell raster exists', () => {
    expect(detail().config.modes.map(m => m.value)).toEqual(['classes', 'instances']);
  });

  it('offers no view switch for an artifact built before the per-cell plane', () => {
    const cfg = detail({ layers: { classes: { levels: 5 } } }).config;
    expect(cfg.modes).toEqual([]);
    expect(cfg.drawn).toBe(true);
  });

  it('is not drawable while a build has polygons but no raster', () => {
    expect(detail({ layers: {} }).config.drawn).toBe(false);
  });

  it('carries the stored opacity and mode, and the defaults when nobody has set them', () => {
    expect(detail().config.opacity).toBe(0.65);
    expect(detail().config.mode).toBe('classes');
    expect(detail({}, { opacity: 0.2, render: 'instances' }).config.opacity).toBe(0.2);
  });

  it('explains the instance view only while it is showing', () => {
    expect(detail().config.note).toBeNull();
    expect(detail({}, { render: 'instances' }).config.note).toMatch(/colour per cell/);
  });
});

describe('an eye on a class row', () => {
  it('patches the store rather than replacing it', () => {
    const { toggleSegment } = layerBinding('nuclei');
    const patch = toggleSegment({ hidden: { Dead: true } }, 'Connective');
    expect(patch).toEqual({ hidden: { Dead: true, Connective: true } });
  });

  it('turns a hidden class back on', () => {
    const { toggleSegment } = layerBinding('nuclei');
    expect(toggleSegment({ hidden: { Connective: true } }, 'Connective'))
      .toEqual({ hidden: { Connective: false } });
  });

  it('names the store slice the layer lives in, not a local copy', () => {
    expect(layerBinding('nuclei')).toMatchObject({
      layerKey: 'nucleiLayerParams', setterKey: 'setNucleiLayerParams',
    });
    expect(layerBinding('tissue')).toBeNull();
  });
});
