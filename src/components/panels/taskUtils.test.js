import { describe, it, expect } from 'vitest';
import {
  specSatisfiedBy, matchFeatureSpec, buildFormForSpec, describeSpec,
  describeFeatureState, pendingStages,
  findPrediction, describePrediction,
  colormap, normaliseEvidence, gridExtent, VIEW_MODES, DEFAULT_OPACITY,
} from './taskUtils.js';

// The BRCA task's spec, mirroring services/preprocess tasks.py.
const SPEC = { encoder: 'conch_v1', mag: 20, patch_size: 256, overlap: 0 };

const row = (o) => ({
  kind: 'features', status: 'ready', art_hash: 'f1', parent_hash: 'p1',
  params: {}, n_items: null, error: null, result: null, ...o,
});

// A slide whose DAG was built at the task's resolution.
function chain({ ps = 256, mag = 20, overlap = 0, encoder = 'conch_v1', segmenter = 'hest',
  featStatus = 'ready', n = 2731 } = {}) {
  return [
    row({ kind: 'features', status: featStatus, art_hash: 'f1', parent_hash: 'p1',
      params: { encoder }, n_items: n }),
    row({ kind: 'patching', art_hash: 'p1', parent_hash: 's1',
      params: { mag, patch_size: ps, overlap } }),
    row({ kind: 'segmentation', art_hash: 's1', parent_hash: null,
      params: { segmenter, seg_conf_thresh: 0.5 } }),
  ];
}

describe('feature-spec matching', () => {
  it('accepts a chain built at the task resolution', () => {
    expect(matchFeatureSpec(chain(), SPEC)?.art_hash).toBe('f1');
  });

  it('rejects the panel default of 512 px — the whole reason the task carries a spec', () => {
    // preprocessUtils binds CONCH → 512 px, but every hgmil BRCA model trained on 256 px.
    expect(matchFeatureSpec(chain({ ps: 512 }), SPEC)).toBeNull();
  });

  it('rejects the text-aligned CONCH variant at the right resolution', () => {
    // Same checkpoint, same 512-d, same grid — but a near-orthogonal space (per-patch cos ≈0.005).
    // Before the ids were split this matched, and the task returned a coin flip on noise.
    expect(matchFeatureSpec(chain({ encoder: 'conch_v1_text' }), SPEC)).toBeNull();
  });

  it.each([
    ['encoder', { encoder: 'uni_v2' }],
    ['magnification', { mag: 40 }],
    ['overlap', { overlap: 64 }],
  ])('rejects a mismatched %s', (_label, over) => {
    expect(matchFeatureSpec(chain(over), SPEC)).toBeNull();
  });

  it('ignores the segmenter, so an otsu-segmented slide still counts', () => {
    expect(matchFeatureSpec(chain({ segmenter: 'otsu' }), SPEC)?.art_hash).toBe('f1');
  });

  it('does not match a features row that is still building', () => {
    expect(matchFeatureSpec(chain({ featStatus: 'running' }), SPEC)).toBeNull();
  });

  it('refuses to claim a match when the patching parent is absent', () => {
    // mag/patch_size live on the parent; with no parent there is nothing to verify against.
    const orphan = [row({ params: { encoder: 'conch_v1' } })];
    expect(specSatisfiedBy(orphan, orphan[0], SPEC)).toBe(false);
    expect(matchFeatureSpec(orphan, SPEC)).toBeNull();
  });

  it('picks the matching index when the slide has several', () => {
    const rows = [
      row({ art_hash: 'fA', parent_hash: 'pA', params: { encoder: 'conch_v1' } }),
      row({ kind: 'patching', art_hash: 'pA', parent_hash: 's1',
        params: { mag: 20, patch_size: 512, overlap: 0 } }),
      ...chain(),
    ];
    expect(matchFeatureSpec(rows, SPEC)?.art_hash).toBe('f1');
  });
});

describe('describeSpec', () => {
  it('reads as the build the user must make', () => {
    expect(describeSpec(SPEC)).toBe('CONCH V1 · 256 px · 20× · no overlap');
  });

  it('names a non-zero overlap', () => {
    expect(describeSpec({ ...SPEC, overlap: 64 })).toContain('64 px overlap');
  });
});

describe('buildFormForSpec', () => {
  it('pins the four constrained fields and locks the override', () => {
    const form = buildFormForSpec(SPEC, []);
    expect(form).toMatchObject({
      encoder: 'conch_v1', mag: 20, patch_size: 256, overlap: 0, patch_override: true,
    });
  });

  it('reuses an existing segmentation instead of re-cutting the slide', () => {
    const rows = chain({ segmenter: 'otsu', ps: 512 });
    expect(buildFormForSpec(SPEC, rows).segmenter).toBe('otsu');
  });

  it('falls back to the default segmenter on an untouched slide', () => {
    expect(buildFormForSpec(SPEC, []).segmenter).toBe('hest');
  });
});

describe('describeFeatureState', () => {
  it('is ready and counts the patches', () => {
    const s = describeFeatureState(chain(), SPEC);
    expect(s.state).toBe('ready');
    expect(s.detail).toBe('2,731 patches indexed.');
    expect(s.feat.art_hash).toBe('f1');
  });

  it('is missing on an untouched slide', () => {
    expect(describeFeatureState([], SPEC).state).toBe('missing');
  });

  it('is missing when the only index is at the wrong resolution', () => {
    expect(describeFeatureState(chain({ ps: 512 }), SPEC).state).toBe('missing');
  });

  it('reports a build in flight with its stage and progress', () => {
    const rows = chain({ featStatus: 'running' });
    rows[0].stage = 'features';
    rows[0].progress = 0.42;
    const s = describeFeatureState(rows, SPEC);
    expect(s.state).toBe('building');
    expect(s.progress).toBe(42);
    expect(s.detail).toBe('Encoding features');
  });

  it('surfaces the worker error when a stage failed', () => {
    const rows = chain({ featStatus: 'failed' });
    rows[0].error = 'CUDA out of memory';
    const s = describeFeatureState(rows, SPEC);
    expect(s.state).toBe('failed');
    expect(s.detail).toBe('CUDA out of memory');
  });
});

describe('pendingStages', () => {
  it('is empty when the right index already exists', () => {
    expect(pendingStages(chain(), SPEC)).toEqual([]);
  });

  it('is all three on an untouched slide', () => {
    expect(pendingStages([], SPEC)).toEqual(['segmentation', 'patching', 'features']);
  });

  it('skips a segmentation that can be reused', () => {
    // Same segmenter params, but tiled at 512 — only the tiling and encoding need to run.
    expect(pendingStages(chain({ ps: 512 }), SPEC)).toEqual(['patching', 'features']);
  });
});

describe('findPrediction', () => {
  const pred = row({
    kind: 'prediction', art_hash: 'pr1', parent_hash: 'f1',
    params: { task_id: 'brca_idc_ilc' },
  });

  it('finds the prediction for this features index and task', () => {
    expect(findPrediction([pred], 'f1', 'brca_idc_ilc')?.art_hash).toBe('pr1');
  });

  it('ignores a prediction from another task or another index', () => {
    expect(findPrediction([pred], 'f2', 'brca_idc_ilc')).toBeNull();
    expect(findPrediction([pred], 'f1', 'nsclc')).toBeNull();
  });

  it('is null without a features index', () => {
    expect(findPrediction([pred], null, 'brca_idc_ilc')).toBeNull();
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
    expect(d.state).toBe('ready');
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

  it('reports a run in flight', () => {
    const d = describePrediction({ ...ready, status: 'running', result: null });
    expect(d.state).toBe('running');
    expect(d.probs).toEqual([]);
  });

  it('surfaces the failure reason', () => {
    const d = describePrediction({
      ...ready, status: 'failed', result: null, error: "weights for 'brca_idc_ilc' not found",
    });
    expect(d.state).toBe('failed');
    expect(d.detail).toContain('weights');
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
