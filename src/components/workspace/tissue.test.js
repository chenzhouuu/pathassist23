// The panel half of these tests went with the panel in Inc 6 · 06 — a build's stage, its Stop
// button and its "which row is this slide's tissue map" lookup are the Runs list's questions now,
// and are covered against the runs feed in `panels/analysis/runsUtils.test.js`. What is left is
// the artifact half: what the map is made of, and how it is drawn.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONF_FLOOR,
  DEFAULT_HIDDEN,
  LAYER_FOR_RENDER,
  classesOf,
  colorsOf,
  compositionCsv,
  compositionRows,
  coverageSummary,
  formatPercent,
  layerLevels,
  layerSignature,
  levelOffsetFor,
  tileParams,
  tsrOf,
} from './tissue.js';

const CLASSES = ['Tumour', 'Stroma', 'Inflammatory', 'Necrosis', 'Others'];

const CATALOG = {
  default_backend: 'bcss_fcn_unet',
  backends: {
    bcss_fcn_unet: {
      classes: CLASSES,
      colors: { Tumour: '#D55E00', Stroma: '#0072B2', Inflammatory: '#009E73',
                Necrosis: '#CC79A7', Others: '#999999' },
      trained_on: 'BCSS · breast (H&E)',
      weights_license: 'CC-BY-NC-4.0',
    },
  },
};

const META = {
  backend: 'bcss_fcn_unet',
  classes: CLASSES,
  colors: CATALOG.backends.bcss_fcn_unet.colors,
  slide: { width: 8192, height: 4096, mpp: 0.25 },
  layers: { classes: { level_offset: 2, levels: 5 }, probs: { level_offset: 2, levels: 5 } },
  coverage: { core: 2048, n_tiles: 47 },
  summary: {
    pixels: { Tumour: 100, Stroma: 80, Inflammatory: 20, Necrosis: 0, Others: 0 },
    fraction: { Tumour: 0.5, Stroma: 0.4, Inflammatory: 0.1, Necrosis: 0, Others: 0 },
    fraction_soft: { Tumour: 0.46, Stroma: 0.42, Inflammatory: 0.12, Necrosis: 0, Others: 0 },
    tsr: 0.444, covered_mm2: 12.43,
  },
};

describe('tileParams', () => {
  it('omits show when every class is visible — a shorter URL is a better cache key', () => {
    expect(tileParams('classes', { show: CLASSES, classes: CLASSES })).toEqual({ conf: '1' });
  });

  it('sorts the class filter so an equivalent selection is one cache entry', () => {
    const a = tileParams('classes', { show: ['Stroma', 'Tumour'], classes: CLASSES });
    const b = tileParams('classes', { show: ['Tumour', 'Stroma'], classes: CLASSES });
    expect(a.show).toBe('Stroma,Tumour');
    expect(a).toEqual(b);
  });

  it('carries the confidence ramp only for the classes look', () => {
    expect(tileParams('classes', { conf: true }).conf).toBe('1');
    expect(tileParams('classes', { conf: false }).conf).toBe('0');
    expect(tileParams('probs', { conf: true }).conf).toBeUndefined();
  });

  it('sends conf_floor only when it differs from the default', () => {
    expect(tileParams('classes', {}).conf_floor).toBeUndefined();
    expect(tileParams('classes', { confFloor: 0.5 }).conf_floor).toBe('0.5');
    expect(DEFAULT_CONF_FLOOR).toBeLessThan(1);
  });

  it('sends alpha only when it is not fully opaque', () => {
    expect(tileParams('probs', { opacity: 1 }).alpha).toBeUndefined();
    expect(tileParams('probs', { opacity: 0.45 }).alpha).toBe('0.45');
  });

  it('carries the coverage, so a map that grows is a different picture', () => {
    // Without it the transparent tiles fetched while a whole-slide build was still working would
    // stay in the browser's cache, and the map would keep showing the emptiness it had when you
    // first looked at it (the same reason `workspace/nuclei.js` carries one).
    expect(tileParams('classes', { rev: 43 }).rev).toBe('43');
    expect(tileParams('classes', {}).rev).toBeUndefined();
    expect(tileParams('classes', { rev: 0 }).rev).toBeUndefined();
  });

  it('asks for a thicker outline so the line survives downsampling', () => {
    expect(tileParams('outline', {}).width).toBe('2');
  });
});

describe('layer mapping', () => {
  it('shares one stored layer between the two argmax looks', () => {
    expect(LAYER_FOR_RENDER.classes).toBe('classes');
    expect(LAYER_FOR_RENDER.outline).toBe('classes');
    expect(LAYER_FOR_RENDER.probs).toBe('probs');
  });

  it('reads geometry from meta so the frontend hardcodes no resolution', () => {
    expect(levelOffsetFor(META, 'classes')).toBe(2);
    expect(layerLevels(META, 'probs')).toBe(5);
    expect(levelOffsetFor(null, 'classes')).toBe(2);
    expect(layerLevels(null, 'classes')).toBe(1);
  });
});

describe('layerSignature', () => {
  it('is stable under key reordering so OSD does not refetch every tile', () => {
    expect(layerSignature('classes', 'h1', { conf: '1', alpha: '0.45' }))
      .toBe(layerSignature('classes', 'h1', { alpha: '0.45', conf: '1' }));
  });

  it('changes when the picture changes', () => {
    const a = layerSignature('classes', 'h1', { conf: '1' });
    expect(layerSignature('outline', 'h1', { conf: '1' })).not.toBe(a);
    expect(layerSignature('classes', 'h2', { conf: '1' })).not.toBe(a);
    expect(layerSignature('classes', 'h1', { conf: '0' })).not.toBe(a);
  });

  it('collapses when there is nothing to show', () => {
    expect(layerSignature('classes', null, {})).toBe('none');
  });
});

describe('catalog readers', () => {
  it('prefers the artifact class list over the catalog', () => {
    expect(classesOf({ classes: ['A', 'B'] }, CATALOG)).toEqual(['A', 'B']);
    expect(classesOf(null, CATALOG)).toEqual(CLASSES);
    expect(classesOf(null, null)).toEqual(CLASSES);      // fallback, never empty
  });

  it('takes colours from the artifact so a recolour cannot drift from the map', () => {
    expect(colorsOf(META, CATALOG).Tumour).toBe('#D55E00');
    expect(colorsOf(null, CATALOG).Stroma).toBe('#0072B2');
    expect(colorsOf(null, null)).toEqual({});
  });

  it('hides the grab-bag class by default but keeps it in the class list', () => {
    expect(DEFAULT_HIDDEN).toEqual(['Others']);
    expect(classesOf(META, CATALOG)).toContain('Others');
  });
});

describe('composition', () => {
  it('keeps the class order fixed so the legend does not reshuffle as coverage grows', () => {
    const rows = compositionRows(META, CATALOG);
    expect(rows.map((r) => r.name)).toEqual(CLASSES);
    expect(rows[0]).toMatchObject({ name: 'Tumour', color: '#D55E00', fraction: 0.5, soft: 0.46 });
  });

  it('reports both the hard and the soft fraction — they differ where the model is unsure', () => {
    const rows = compositionRows(META, CATALOG);
    expect(rows[0].fraction).not.toBe(rows[0].soft);
    expect(rows.every((r) => r.fraction !== null)).toBe(true);
  });

  it('is all-nulls rather than zeros before anything is built', () => {
    const rows = compositionRows(null, CATALOG);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.fraction === null)).toBe(true);
  });

  it('reports TSR as a number or nothing, never as a category', () => {
    expect(tsrOf(META)).toBe(0.444);
    expect(tsrOf({ summary: {} })).toBe(null);
    expect(tsrOf(null)).toBe(null);
  });

  it('summarises coverage in real units', () => {
    expect(coverageSummary(META)).toEqual({ tiles: 47, mm2: 12.43 });
    expect(coverageSummary({})).toBe(null);
  });

  it('formats a missing fraction as a dash rather than as zero', () => {
    expect(formatPercent(0.432)).toBe('43.2%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('csv export', () => {
  it('carries the covered area and the backend on every row', () => {
    const csv = compositionCsv(META, CATALOG);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'class,pixels,fraction,fraction_soft,covered_mm2,core_tiles,backend');
    expect(lines).toHaveLength(6);
    // a fraction over 3% of a slide and one over the whole slide are not the same claim
    expect(lines[1]).toContain('12.43');
    expect(lines[1]).toContain('bcss_fcn_unet');
    expect(lines[1].startsWith('Tumour,100,0.5,0.46')).toBe(true);
  });
});
