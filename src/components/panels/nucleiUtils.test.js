import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPACITY, canStop, classRows, classesOf, colorsOf, coverageSummary, describeStage,
  findNucleiRow, findReadySegmentation, formatArea, formatPercent, hasInstances, isRunning,
  isStopped, isStopping, layerLevels, layerSignature, levelOffsetFor, progressPercent,
  startLabel, summaryLine, tileParams, totalNuclei, withNucleiDefaults,
} from './nucleiUtils.js';

const summary = (over = {}) => ({
  n_nuclei: 1200, n_tiles: 3, area_mm2: 12.582,
  counts_by_class: { Neoplastic: 800, Connective: 300, Inflammatory: 100 },
  ...over,
});

describe('findNucleiRow', () => {
  it('picks the nuclei artifact out of the slide\'s rows', () => {
    const rows = [{ kind: 'tissue' }, { kind: 'nuclei', art_hash: 'n1' }, { kind: 'features' }];
    expect(findNucleiRow(rows).art_hash).toBe('n1');
    expect(findNucleiRow([{ kind: 'tissue' }])).toBe(null);
    expect(findNucleiRow()).toBe(null);
  });
});

describe('describeStage', () => {
  it('says where the build got to', () => {
    expect(describeStage(null)).toBe('Not built');
    expect(describeStage({ status: 'ready' })).toBe('Ready');
    expect(describeStage({ status: 'running', progress: 0.5 })).toBe('Working 50%');
    expect(describeStage({ status: 'running', stage: 'nuclei', progress: 0.5 }))
      .toBe('Segmenting 50%');
    expect(describeStage({ status: 'running', stage: 'raster', progress: 0.98 }))
      .toBe('Drawing 98%');
  });

  it('carries the reason a build failed rather than sending the user to a log', () => {
    expect(describeStage({ status: 'failed', error: 'no weights' })).toBe('Failed — no weights');
    expect(describeStage({ status: 'failed' })).toBe('Failed — unknown error');
  });

  it('calls a stopped build stopped, and says what it holds and what is left', () => {
    // Not an error: a stopped build is a complete artifact of a smaller area.
    expect(describeStage({ status: 'cancelled' })).toBe('Stopped — part of the slide');
    expect(describeStage({
      status: 'cancelled', result: { n_nuclei: 4120, remaining: 37 },
    })).toBe('Stopped — 4,120 nuclei, 37 tiles left');
    expect(isStopped({ status: 'cancelled' })).toBe(true);
  });

  it('distinguishes asked-to-stop from stopped', () => {
    const stopping = { status: 'running', stage: 'stopping', job_id: 'j1' };
    expect(isStopping(stopping)).toBe(true);
    expect(describeStage(stopping)).toBe('Stopping — finishing the current tile');
    // Already asked; asking again would do nothing but flicker the button.
    expect(canStop(stopping)).toBe(false);
    expect(canStop({ status: 'running', job_id: 'j1' })).toBe(true);
    // A row with no job has nothing to address — a worker restart leaves rows like this.
    expect(canStop({ status: 'running' })).toBe(false);
  });

  it('labels the start button by what pressing it would do', () => {
    expect(startLabel(null, false)).toBe('Run on region');
    expect(startLabel(null, true)).toBe('Run on whole slide');
    expect(startLabel({ status: 'cancelled' }, true)).toBe('Resume whole slide');
    // Resuming is the same call — coverage is what makes it free — so only the word changes.
    expect(startLabel({ status: 'cancelled' }, false)).toBe('Run on region');
  });

  it('finds the segmentation a whole-slide run needs, and only a ready one', () => {
    const rows = [{ kind: 'segmentation', status: 'running', art_hash: 's0' },
                  { kind: 'segmentation', status: 'ready', art_hash: 's1' }];
    expect(findReadySegmentation(rows).art_hash).toBe('s1');
    expect(findReadySegmentation([{ kind: 'segmentation', status: 'queued' }])).toBe(null);
    expect(findReadySegmentation()).toBe(null);
  });

  it('reports coverage as what the numbers are an account of', () => {
    expect(coverageSummary({ coverage: { n_tiles: 7 }, summary: { area_mm2: 29.36 } }))
      .toEqual({ tiles: 7, mm2: 29.36 });
    expect(coverageSummary({ coverage: { n_tiles: 7 } })).toEqual({ tiles: 7, mm2: null });
    expect(coverageSummary(null)).toBe(null);
  });

  it('treats queued as running, because the panel should be polling either way', () => {
    expect(isRunning({ status: 'queued' })).toBe(true);
    expect(isRunning({ status: 'running' })).toBe(true);
    expect(isRunning({ status: 'ready' })).toBe(false);
  });

  it('clamps a progress the worker reports out of range', () => {
    expect(progressPercent({ progress: 1.4 })).toBe(100);
    expect(progressPercent({ progress: -1 })).toBe(0);
    expect(progressPercent({})).toBe(0);
  });
});

describe('classRows', () => {
  it('lists the classes in PanNuke order with their share of the total', () => {
    const rows = classRows(summary());
    expect(rows.map((r) => r.name)).toEqual(['Neoplastic', 'Inflammatory', 'Connective']);
    expect(rows[0].count).toBe(800);
    expect(formatPercent(rows[0].fraction)).toBe('66.7%');
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

describe('summaryLine', () => {
  it('reads as one line of what is stored', () => {
    expect(summaryLine(summary())).toBe('1,200 nuclei · 12.58 mm² · 3 tiles');
  });

  it('says only what it has', () => {
    expect(summaryLine({ n_nuclei: 1, n_tiles: 1 })).toBe('1 nucleus · 1 tile');
    expect(summaryLine(null)).toBe('');
    expect(summaryLine({})).toBe('');
  });
});
