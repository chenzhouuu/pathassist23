import { describe, expect, it } from 'vitest';
import {
  classRows, describeStage, findNucleiRow, formatArea, formatPercent, isRunning, isStopped,
  progressPercent, summaryLine, totalNuclei,
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
    expect(describeStage({ status: 'failed' })).toBe('Failed');
    expect(describeStage({ status: 'running', progress: 0.5 })).toBe('Working 50%');
  });

  it('calls a stopped build stopped, not failed', () => {
    expect(describeStage({ status: 'cancelled' })).toBe('Stopped');
    expect(isStopped({ status: 'cancelled' })).toBe(true);
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
