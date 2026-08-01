import { describe, expect, it } from 'vitest';
import {
  canDraw, describeArtifact, describeDependant, describeParams, describeScale, describeState,
  formatAge, formatBytes, kindLabel, sortArtifacts,
} from './workspaceUtils.js';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const row = (over = {}) => ({
  kind: 'tissue', art_hash: 'h1', status: 'ready', params: {}, result: {},
  created_at: ago(60_000), ...over,
});

describe('describeParams', () => {
  it('names what each kind was built with', () => {
    expect(describeParams(row({ kind: 'segmentation', params: { segmenter: 'hest', seg_conf_thresh: 0.4 } })))
      .toBe('hest · conf 0.4');
    expect(describeParams(row({ kind: 'patching', params: { patch_size: 256, mag: 20, overlap: 0 } })))
      .toBe('256 px · 20×');
    expect(describeParams(row({ kind: 'features', params: { encoder: 'conch_v1' } })))
      .toBe('conch_v1');
    expect(describeParams(row({ kind: 'tissue', params: { backend: 'hover-next', scope: 'region' } })))
      .toBe('hover-next · region');
  });

  it('mentions overlap only when there is some', () => {
    expect(describeParams(row({ kind: 'patching', params: { patch_size: 256, overlap: 64 } })))
      .toBe('256 px · overlap 64');
  });

  it('says when an artifact came out of the stub pipeline, and stays quiet when it did not', () => {
    // Two segmentations of one slide can coexist since Inc 6 · 05 split their addresses. The stub's
    // is a synthetic 4096 px square with a `segmenter: hest` label it did not earn, so the row has
    // to carry the one word that tells them apart.
    const stub = row({ kind: 'segmentation', params: { segmenter: 'hest', seg_conf_thresh: 0.5, impl: 'stub' } });
    const real = row({ kind: 'segmentation', params: { segmenter: 'hest', seg_conf_thresh: 0.5, impl: 'trident' } });
    expect(describeParams(stub)).toBe('hest · conf 0.5 · stub');
    expect(describeParams(real)).toBe('hest · conf 0.5');
    // Rows written before the split say nothing either — an absent `impl` is not a claim.
    expect(describeParams(row({ kind: 'segmentation', params: { segmenter: 'hest' } }))).toBe('hest');
    expect(describeParams(row({ kind: 'features', params: { encoder: 'conch_v1', impl: 'stub' } })))
      .toBe('conch_v1 · stub');
  });

  it('says nothing rather than something empty', () => {
    expect(describeParams(row({ kind: 'features', params: {} }))).toBe('');
    expect(describeParams(row({ kind: 'mystery', params: { backend: 'cellvit' } }))).toBe('');
    expect(describeParams(null)).toBe('');
  });
});

describe('describeScale', () => {
  it('counts what the build produced, with the right noun', () => {
    expect(describeScale(row({ kind: 'segmentation', n_items: 1 }))).toBe('1 tissue region');
    expect(describeScale(row({ kind: 'segmentation', n_items: 7 }))).toBe('7 tissue regions');
    expect(describeScale(row({ kind: 'patching', n_items: 12345 }))).toBe('12,345 patches');
  });

  it('gives a feature row its dimension', () => {
    expect(describeScale(row({ kind: 'features', n_items: 900, dim: 512 }))).toBe('900 vectors × 512');
    expect(describeScale(row({ kind: 'features', n_items: 900 }))).toBe('900 vectors');
  });

  it('reads a prediction as its label and probability', () => {
    const r = row({
      kind: 'prediction',
      result: { pred_label: 'IDC', pred_index: 0, probs: [0.873, 0.127] },
    });
    expect(describeScale(r)).toBe('IDC 87.3%');
  });

  it('leaves the probability off when the row has no probs', () => {
    expect(describeScale(row({ kind: 'prediction', result: { pred_label: 'ILC' } }))).toBe('ILC');
  });

  it('reads a tissue map as tiles, area and TSR', () => {
    const r = row({ result: { n_core_tiles: 240, covered_mm2: 18.34, tsr: 0.4212 } });
    expect(describeScale(r)).toBe('240 tiles · 18.3 mm² · TSR 42%');
  });

  it('reads a biomarker map as cells and tiles', () => {
    expect(describeScale(row({ kind: 'biomarker', result: { n_cells: 222412, n_tiles: 96 } })))
      .toBe('222,412 cells · 96 tiles');
  });

  it('is empty while a build has produced no numbers yet', () => {
    expect(describeScale(row({ status: 'queued', result: {} }))).toBe('');
    expect(describeScale(row({ kind: 'patching' }))).toBe('');
  });
});

describe('formatAge', () => {
  it('picks the coarsest unit that is still true', () => {
    expect(formatAge(ago(5_000), NOW)).toBe('just now');
    expect(formatAge(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(formatAge(ago(3 * 3600_000), NOW)).toBe('3h ago');
    expect(formatAge(ago(4 * 86400_000), NOW)).toBe('4d ago');
    expect(formatAge(ago(90 * 86400_000), NOW)).toBe('3mo ago');
  });

  it('is empty for a timestamp it cannot read', () => {
    expect(formatAge(undefined, NOW)).toBe('');
    expect(formatAge('not a date', NOW)).toBe('');
  });
});

describe('describeState', () => {
  it('shows progress while building, not an age', () => {
    const r = row({ status: 'running', stage: 'features', progress: 0.42 });
    expect(describeState(r, NOW)).toMatch(/42%$/);
  });

  it('names a stopped build as stopped, not as failed', () => {
    expect(describeState(row({ status: 'cancelled' }), NOW)).toBe('Stopped · 1m ago');
  });

  it('names a failure', () => {
    expect(describeState(row({ status: 'failed' }), NOW)).toBe('Failed · 1m ago');
  });

  it('is just the age once a build is done', () => {
    expect(describeState(row({ status: 'ready' }), NOW)).toBe('1m ago');
  });
});

describe('describeArtifact', () => {
  it('drops the segments that have nothing to say', () => {
    const view = describeArtifact(row({ status: 'queued', params: {}, result: {} }), NOW);
    expect(view.primary).toEqual([]);
    expect(view.secondary).toHaveLength(1);
  });

  it('puts a failure reason on the row', () => {
    const view = describeArtifact(
      row({ status: 'failed', error: 'CUDA out of memory', params: { backend: 'hover-next' } }),
      NOW,
    );
    expect(view.primary).toContain('CUDA out of memory');
    expect(view.failed).toBe(true);
  });

  it('carries the error only when the build actually failed', () => {
    const view = describeArtifact(row({ status: 'ready', error: 'a stale message' }), NOW);
    expect(view.primary).not.toContain('a stale message');
  });

  it('marks which kinds have something to draw', () => {
    expect(canDraw(row({ kind: 'tissue' }))).toBe(true);
    expect(canDraw(row({ kind: 'biomarker' }))).toBe(true);
    expect(canDraw(row({ kind: 'segmentation' }))).toBe(true);
    expect(canDraw(row({ kind: 'features' }))).toBe(false);
    expect(canDraw(row({ kind: 'prediction' }))).toBe(false);
  });

  it('falls back to the raw kind rather than hiding an unknown one', () => {
    expect(kindLabel('mystery')).toBe('mystery');
    expect(describeArtifact(row({ kind: 'mystery' }), NOW).title).toBe('mystery');
  });

  it('reads a nuclei row as its count, area and dominant classes', () => {
    const r = row({
      kind: 'nuclei',
      params: { backend: 'cellvit-sam-h', scope: 'region' },
      result: {
        n_nuclei: 12_403, area_mm2: 4.194,
        counts_by_class: { Neoplastic: 9000, Connective: 3000, Dead: 403 },
      },
    });
    // The backend and not the scope (Inc 6 · 05): `scope` is the row's record of the run that
    // created it, and a nuclei artifact is extended by later runs of a different scope. What it
    // covers is the next line, off its own coverage.
    expect(describeParams(r)).toBe('cellvit-sam-h');
    expect(describeScale(r)).toBe('12,403 nuclei · 4.19 mm² · Neoplastic/Connective');
  });

  it('has an eye, now that there is a mask to switch on', () => {
    const r = row({ kind: 'nuclei' });
    expect(canDraw(r)).toBe(true);
    expect(describeArtifact(r, NOW).canSwitch).toBe(true);
  });
});

describe('sortArtifacts', () => {
  it('puts the newest first and does not mutate its input', () => {
    const rows = [
      row({ art_hash: 'old', created_at: ago(86400_000) }),
      row({ art_hash: 'new', created_at: ago(1_000) }),
      row({ art_hash: 'mid', created_at: ago(3600_000) }),
    ];
    const copy = [...rows];
    expect(sortArtifacts(rows).map((r) => r.art_hash)).toEqual(['new', 'mid', 'old']);
    expect(rows).toEqual(copy);
  });

  it('survives an empty or missing list', () => {
    expect(sortArtifacts([])).toEqual([]);
    expect(sortArtifacts(undefined)).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('says the size the way a person would', () => {
    expect(formatBytes(304_087_040)).toBe('290 MB');
    expect(formatBytes(1_363_148)).toBe('1.3 MB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(253_403_070_464)).toBe('236 GB');
  });

  it('says nothing rather than "0 B" when there is no number', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});

describe('describeDependant', () => {
  it('names a dependant the way its row names itself', () => {
    expect(describeDependant({ kind: 'tissue', params: { backend: 'hover-next' } }))
      .toBe('Tissue map (hover-next)');
    expect(describeDependant({ kind: 'patching', params: { patch_size: 256, mag: 20 } }))
      .toBe('Patching (256 px · 20×)');
  });

  it('falls back to the kind rather than to a hash', () => {
    expect(describeDependant({ kind: 'features', params: {} })).toBe('Features');
  });
});
