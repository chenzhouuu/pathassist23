import { describe, it, expect } from 'vitest';
import {
  colormap, describePrediction, describeSpec, gridExtent, normaliseEvidence, otherClass,
  withPredictionDefaults, DEFAULT_OPACITY, VIEW_MODES,
} from './prediction.js';

// The BRCA task's spec, mirroring services/preprocess tasks.py.
const SPEC = { encoder: 'conch_v1', mag: 20, patch_size: 256, overlap: 0 };

const row = (o) => ({
  kind: 'features', status: 'ready', art_hash: 'f1', parent_hash: 'p1',
  params: {}, n_items: null, result: null, ...o,
});

describe('describeSpec', () => {
  it('reads as the build the user must make', () => {
    expect(describeSpec(SPEC)).toBe('CONCH V1 · 256 px · 20× · no overlap');
  });

  it('names a non-zero overlap', () => {
    expect(describeSpec({ ...SPEC, overlap: 64 })).toContain('64 px overlap');
  });
});

describe('describePrediction', () => {
  const ready = row({
    kind: 'prediction', status: 'ready', art_hash: 'pr1', parent_hash: 'f1',
    params: { task_id: 'brca_idc_ilc' },
    result: {
      classes: ['IDC', 'ILC'], probs: [0.93, 0.07], pred_index: 0, pred_label: 'IDC',
      n_patches: 2731, elapsed_ms: 118, model_ver: 'abmil-conch-brca-fold0-v1',
    },
  });

  it('is null for no row', () => {
    expect(describePrediction(null)).toBeNull();
  });

  it('reads out the call and its confidence', () => {
    const d = describePrediction(ready);
    expect(d.label).toBe('IDC');
    expect(d.confidence).toBeCloseTo(0.93);
  });

  it('keeps the class order the model declared and flags the winner', () => {
    // Never re-sorted: a bar that jumps position between slides is unreadable.
    const d = describePrediction(ready);
    expect(d.probs.map((p) => p.name)).toEqual(['IDC', 'ILC']);
    expect(d.probs.map((p) => p.win)).toEqual([true, false]);
  });

  it('builds a provenance line from the summary', () => {
    expect(describePrediction(ready).provenance)
      .toBe('2,731 patches · 118 ms · abmil-conch-brca-fold0-v1');
  });

  it('is null for a row with no result, rather than a state of its own', () => {
    // Inc 6 · 07: a prediction row is a prediction that happened. A run that is still going, or
    // that failed, is in the Runs feed — reading either off a row would be a second opinion.
    expect(describePrediction({ ...ready, result: null })).toBeNull();
  });

  it('names the class the blue pole of the ramp argues for', () => {
    expect(otherClass(describePrediction(ready))).toBe('ILC');
  });

  it('falls back to argmax when the summary has no pred_index', () => {
    const d = describePrediction({
      ...ready, result: { classes: ['IDC', 'ILC'], probs: [0.2, 0.8] },
    });
    expect(d.label).toBe('ILC');
    expect(d.probs.map((p) => p.win)).toEqual([false, true]);
  });
});

describe('colormap', () => {
  it('is multiply-neutral at zero so untouched tissue keeps its colour', () => {
    expect(colormap(0)).toEqual([247, 247, 247]);
  });

  it('runs blue at the negative pole and red at the positive one', () => {
    expect(colormap(-1)).toEqual([58, 76, 160]);
    expect(colormap(1)).toEqual([180, 40, 47]);
  });

  it('clamps beyond the poles', () => {
    expect(colormap(-9)).toEqual(colormap(-1));
    expect(colormap(9)).toEqual(colormap(1));
  });

  it('treats a non-number as no evidence', () => {
    expect(colormap(undefined)).toEqual([247, 247, 247]);
  });
});

describe('normaliseEvidence', () => {
  it('is empty for no input', () => {
    expect(normaliseEvidence([])).toEqual([]);
    expect(normaliseEvidence(null)).toEqual([]);
  });

  it('keeps the sign — it carries which class a patch supports', () => {
    const out = normaliseEvidence([-2, -1, 0, 1, 2]);
    expect(out[0]).toBeLessThan(0);
    expect(out[2]).toBe(0);
    expect(out[4]).toBeGreaterThan(0);
  });

  it('scales symmetrically, not per pole', () => {
    // A map that leans positive must still read as leaning positive after scaling.
    const out = normaliseEvidence([-1, 4]);
    expect(Math.abs(out[0])).toBeLessThan(Math.abs(out[1]));
  });

  it('stops one extreme patch from flattening the map', () => {
    const values = [...Array(99).fill(1), 1000];
    const out = normaliseEvidence(values);
    expect(out[0]).toBeCloseTo(1, 5);      // the bulk still saturates
    expect(out[99]).toBe(1);               // the outlier is clamped, not the scale
  });

  it('returns all-zero when there is no evidence at all', () => {
    expect(normaliseEvidence([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('clamps into [-1, 1]', () => {
    for (const v of normaliseEvidence([-50, -1, 0, 1, 50])) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('gridExtent', () => {
  it('derives the patch grid from level-0 coords', () => {
    // 3 columns × 2 rows at 512 level-0 px per patch.
    const coords = [0, 0, 512, 0, 1024, 0, 0, 512, 512, 512, 1024, 512];
    expect(gridExtent(coords, 512)).toEqual({
      x0: 0, y0: 0, cols: 3, rows: 2, patchPx: 512,
    });
  });

  it('handles a grid that does not start at the origin', () => {
    const g = gridExtent([2048, 4096, 2560, 4096], 512);
    expect(g).toMatchObject({ x0: 2048, y0: 4096, cols: 2, rows: 1 });
  });

  it('is null without a usable patch size', () => {
    // patch_px comes from the prediction document's coords attrs — never derived from mag.
    expect(gridExtent([0, 0, 512, 0], 0)).toBeNull();
    expect(gridExtent([0, 0], undefined)).toBeNull();
  });

  it('is null for empty coords', () => {
    expect(gridExtent([], 512)).toBeNull();
  });
});

describe('view constants', () => {
  it('offers exactly the two CLAM modes', () => {
    expect(VIEW_MODES).toEqual(['split', 'overlay']);
  });

  it('opens at a half-strength overlay so tissue stays readable', () => {
    expect(DEFAULT_OPACITY).toBeGreaterThan(0);
    expect(DEFAULT_OPACITY).toBeLessThan(1);
  });
});

describe('the layer', () => {
  it("opens as an overlay at the CLAM demo's opacity", () => {
    expect(withPredictionDefaults(null)).toEqual({ view: 'overlay', opacity: DEFAULT_OPACITY });
  });

  it('keeps a stored view and falls back for one it does not have', () => {
    expect(withPredictionDefaults({ view: 'split' }).view).toBe('split');
    expect(withPredictionDefaults({ view: 'sideways' }).view).toBe('overlay');
    expect(VIEW_MODES).toEqual(['split', 'overlay']);
  });
});
