import { describe, it, expect } from 'vitest';
import {
  ENCODERS, SEGMENTERS, DEFAULT_FORM,
  encoderMeta, encoderLabel, isTextCapable, recommendedPatchSize, recommendedMag, bindEncoder,
  stageLabel, progressPercent, fmtInt,
  pickSegParams, pickTileParams,
  segParamsMatch, tileParamsMatch, featEncoderMatch,
  findSegmentation, findPatching, findFeatures, matchDag, hydrateFormFromRows,
  isInFlight, anyInFlight, stageState, describeStage, stageEnabled, nextChainStep,
} from './preprocessUtils.js';

describe('encoder catalog + binding (Fork B)', () => {
  it('marks only the text-aligned CONCH variant text-capable', () => {
    // One checkpoint, two near-orthogonal spaces (per-patch cos ~0.005). Only the projected
    // variant lives in the text space; searching the vision one would be meaningless.
    expect(isTextCapable('conch_v1_text')).toBe(true);
    expect(isTextCapable('conch_v1')).toBe(false);
    expect(isTextCapable('uni_v2')).toBe(false);
    expect(isTextCapable('mystery')).toBe(false);
    expect(encoderMeta('mystery')).toBeNull();
    expect(encoderLabel('conch_v1')).toBe('CONCH v1 · vision');
    expect(encoderLabel('conch_v1_text')).toBe('CONCH v1 · text-aligned');
  });
  it('binds each encoder to its trained patch_size / mag', () => {
    expect(recommendedPatchSize('conch_v1')).toBe(512);
    expect(recommendedPatchSize('uni_v2')).toBe(256);
    expect(recommendedMag('conch_v1')).toBe(20);
    expect(ENCODERS.every((e) => e.patch_size && e.mag)).toBe(true);
    expect(SEGMENTERS.map((s) => s.id)).toContain('hest');
  });
  it('bindEncoder snaps patch_size to the encoder unless override is on', () => {
    const a = bindEncoder({ ...DEFAULT_FORM, patch_override: false }, 'uni_v2');
    expect(a.encoder).toBe('uni_v2');
    expect(a.patch_size).toBe(256);
    // override on → keep the user's patch_size
    const b = bindEncoder({ ...DEFAULT_FORM, patch_size: 384, patch_override: true }, 'uni_v2');
    expect(b.patch_size).toBe(384);
  });
  it('default form targets the text variant at its trained 512-px grid', () => {
    // Default builds keep powering Copilot search; a task asks for the vision variant itself.
    expect(DEFAULT_FORM.encoder).toBe('conch_v1_text');
    expect(DEFAULT_FORM.patch_size).toBe(512);
    expect(isTextCapable(DEFAULT_FORM.encoder)).toBe(true);
  });
});

describe('stage / progress / int formatting', () => {
  it('maps known stages, falls back for unknown', () => {
    expect(stageLabel('segmentation')).toBe('Segmenting tissue');
    expect(stageLabel('patching')).toBe('Extracting patches');
    expect(stageLabel('features')).toBe('Encoding features');
    expect(stageLabel('whatever')).toBe('Working');
  });
  it('clamps/rounds progress and formats ints', () => {
    expect(progressPercent({ progress: 0.5 })).toBe(50);
    expect(progressPercent({ progress: 1.4 })).toBe(100);
    expect(progressPercent(null)).toBe(0);
    expect(fmtInt(8412)).toBe((8412).toLocaleString());
    expect(fmtInt(undefined)).toBe('');
  });
});

describe('form → wire params', () => {
  it('pickSegParams coerces conf + bools', () => {
    expect(pickSegParams({ segmenter: 'otsu', seg_conf_thresh: '0.4', remove_holes: true }))
      .toEqual({
        segmenter: 'otsu', seg_conf_thresh: 0.4,
        remove_artifacts: false, remove_holes: true, remove_penmarks: false,
      });
  });
  it('pickTileParams coerces to numbers', () => {
    expect(pickTileParams({ mag: '20', patch_size: '512', overlap: '0' }))
      .toEqual({ mag: 20, patch_size: 512, overlap: 0 });
  });
});

describe('DAG artifact matching', () => {
  const seg = {
    kind: 'segmentation', art_hash: 's1', parent_hash: null, status: 'ready',
    params: { segmenter: 'hest', seg_conf_thresh: 0.5,
      remove_artifacts: false, remove_holes: false, remove_penmarks: false },
  };
  const patch = {
    kind: 'patching', art_hash: 'p1', parent_hash: 's1', status: 'ready',
    params: { mag: 20, patch_size: 512, overlap: 0 }, n_items: 6290,
  };
  const featC = {
    kind: 'features', art_hash: 'f1', parent_hash: 'p1', status: 'ready',
    params: { encoder: 'conch_v1_text' }, n_items: 6290, dim: 512,
  };
  const rows = [seg, patch, featC];

  it('matches segmentation on all seg params', () => {
    expect(segParamsMatch(seg, pickSegParams(DEFAULT_FORM))).toBe(true);
    // a different conf does not match
    expect(segParamsMatch(seg, { ...pickSegParams(DEFAULT_FORM), seg_conf_thresh: 0.4 })).toBe(false);
    // wrong kind never matches
    expect(segParamsMatch(patch, pickSegParams(DEFAULT_FORM))).toBe(false);
  });
  it('matches patching on parent_hash + tile params', () => {
    expect(tileParamsMatch(patch, { mag: 20, patch_size: 512, overlap: 0 })).toBe(true);
    expect(tileParamsMatch(patch, { mag: 20, patch_size: 256, overlap: 0 })).toBe(false);
    expect(findPatching(rows, 's1', { mag: 20, patch_size: 512, overlap: 0 })).toBe(patch);
    expect(findPatching(rows, 'other', { mag: 20, patch_size: 512, overlap: 0 })).toBeNull();
  });
  it('matches features on parent_hash + encoder', () => {
    expect(featEncoderMatch(featC, 'conch_v1_text')).toBe(true);
    expect(featEncoderMatch(featC, 'uni_v2')).toBe(false);
    expect(findFeatures(rows, 'p1', 'conch_v1_text')).toBe(featC);
    expect(findFeatures(rows, 'p1', 'uni_v2')).toBeNull();
  });
  it('never matches the sibling CONCH variant', () => {
    // The two variants are near-orthogonal spaces; a text index must not satisfy a request for
    // the vision one (that collision is what made a task silently return a coin flip).
    expect(featEncoderMatch(featC, 'conch_v1')).toBe(false);
    expect(findFeatures(rows, 'p1', 'conch_v1')).toBeNull();
  });
  it('matchDag resolves the full chain for the default form', () => {
    const { seg: s, patch: p, feat: f } = matchDag(rows, DEFAULT_FORM);
    expect([s?.art_hash, p?.art_hash, f?.art_hash]).toEqual(['s1', 'p1', 'f1']);
  });
  it('a different encoder shares seg+patch but has no features yet', () => {
    // uni_v2 wants a 256 grid → the 512 patch does NOT match, so patch is null too
    const uniForm = bindEncoder(DEFAULT_FORM, 'uni_v2');
    const { seg: s, patch: p, feat: f } = matchDag(rows, uniForm);
    expect(s).toBe(seg);       // same segmentation reused
    expect(p).toBeNull();      // 256-px grid not built
    expect(f).toBeNull();
  });
  it('two encoders sharing a 256 grid reuse the same patch row', () => {
    const patch256 = {
      kind: 'patching', art_hash: 'p2', parent_hash: 's1', status: 'ready',
      params: { mag: 20, patch_size: 256, overlap: 0 },
    };
    const rows2 = [seg, patch256];
    expect(matchDag(rows2, bindEncoder(DEFAULT_FORM, 'uni_v2')).patch).toBe(patch256);
    expect(matchDag(rows2, bindEncoder(DEFAULT_FORM, 'uni_v1')).patch).toBe(patch256);
  });
});

describe('status descriptors', () => {
  it('classifies in-flight vs settled', () => {
    expect(isInFlight({ status: 'queued' })).toBe(true);
    expect(isInFlight({ status: 'ready' })).toBe(false);
    expect(anyInFlight([{ status: 'ready' }, { status: 'running' }])).toBe(true);
    expect(stageState(null)).toBe('none');
    expect(stageState({ status: 'ready' })).toBe('ready');
  });
  it('describeStage renders per-stage titles/details', () => {
    expect(describeStage(null, 'segmentation').title).toBe('Not segmented');
    expect(describeStage({ status: 'ready', n_items: 12 }, 'segmentation').detail).toBe('12 contours');
    expect(describeStage({ status: 'ready', n_items: 6290 }, 'features').detail)
      .toBe(`${(6290).toLocaleString()} patches`);
    expect(describeStage({ status: 'running', stage: 'features', progress: 0.7 }, 'features').detail)
      .toBe('70%');
    expect(describeStage({ status: 'failed', error: 'boom' }, 'patching').detail).toBe('boom');
  });
  it('stageEnabled gates on the parent being ready', () => {
    expect(stageEnabled(null, true)).toBe(true);              // root (segmentation)
    expect(stageEnabled({ status: 'ready' })).toBe(true);
    expect(stageEnabled({ status: 'running' })).toBe(false);
    expect(stageEnabled(null)).toBe(false);
  });
});

describe('nextChainStep (Run-all auto-advance)', () => {
  const segReady = {
    kind: 'segmentation', art_hash: 's1', parent_hash: null, status: 'ready',
    params: pickSegParams(DEFAULT_FORM),
  };
  const patchReady = {
    kind: 'patching', art_hash: 'p1', parent_hash: 's1', status: 'ready',
    params: pickTileParams(DEFAULT_FORM),
  };

  it('starts by segmenting when nothing exists', () => {
    expect(nextChainStep([], DEFAULT_FORM)).toEqual({ do: 'segment' });
  });
  it('waits while a stage is in flight', () => {
    expect(nextChainStep([{ ...segReady, status: 'running' }], DEFAULT_FORM)).toEqual({ do: 'wait' });
  });
  it('advances to patch once segmentation is ready', () => {
    expect(nextChainStep([segReady], DEFAULT_FORM)).toEqual({ do: 'patch', seg_hash: 's1' });
  });
  it('advances to features once patching is ready', () => {
    expect(nextChainStep([segReady, patchReady], DEFAULT_FORM))
      .toEqual({ do: 'features', patch_hash: 'p1' });
  });
  it('is done when the feature index is ready', () => {
    const feat = {
      kind: 'features', art_hash: 'f1', parent_hash: 'p1', status: 'ready',
      params: { encoder: 'conch_v1_text' },
    };
    expect(nextChainStep([segReady, patchReady, feat], DEFAULT_FORM).do).toBe('done');
  });
  it('stops on a failed stage', () => {
    expect(nextChainStep([{ ...segReady, status: 'failed' }], DEFAULT_FORM))
      .toEqual({ do: 'stop', failed: 'segmentation' });
  });
});

describe('hydrateFormFromRows (reopen surfaces an existing build)', () => {
  // A full ready chain built with NON-default seg options — the exact case that made a reopened
  // panel look empty (matchDag against DEFAULT_FORM never matched these params).
  const seg = {
    kind: 'segmentation', art_hash: 's1', parent_hash: null, status: 'ready',
    params: {
      segmenter: 'otsu', seg_conf_thresh: 0.3,
      remove_holes: true, remove_penmarks: true, remove_artifacts: true,
    },
  };
  const patch = {
    kind: 'patching', art_hash: 'p1', parent_hash: 's1', status: 'ready',
    params: { mag: 20, patch_size: 256, overlap: 64 },
  };
  const feat = {
    kind: 'features', art_hash: 'f1', parent_hash: 'p1', status: 'ready',
    params: { encoder: 'uni_v2' },
  };

  it('returns null when nothing is ready', () => {
    expect(hydrateFormFromRows([])).toBeNull();
    expect(hydrateFormFromRows([{ ...seg, status: 'running' }])).toBeNull();
  });

  it('rebuilds the form from the deepest ready chain, and matchDag then matches it', () => {
    const form = hydrateFormFromRows([feat, patch, seg]);
    expect(form.encoder).toBe('uni_v2');
    expect(form.segmenter).toBe('otsu');
    expect(form.seg_conf_thresh).toBe(0.3);
    expect(form.remove_holes).toBe(true);
    expect(form.remove_artifacts).toBe(true);
    expect(form.mag).toBe(20);
    expect(form.patch_size).toBe(256);
    expect(form.overlap).toBe(64);
    // 256 IS uni_v2's trained resolution → no override needed.
    expect(form.patch_override).toBe(false);
    // the whole point: the hydrated form re-matches the persisted rows.
    const m = matchDag([feat, patch, seg], form);
    expect(m.seg?.art_hash).toBe('s1');
    expect(m.patch?.art_hash).toBe('p1');
    expect(m.feat?.art_hash).toBe('f1');
  });

  it('flags patch_override when the built grid diverges from the encoder default', () => {
    // conch_v1 features over a 256-px grid (not its trained 512) → override on so the UI shows it.
    const f = { ...feat, params: { encoder: 'conch_v1' } };
    const form = hydrateFormFromRows([f, patch, seg]);
    expect(form.encoder).toBe('conch_v1');
    expect(form.patch_size).toBe(256);
    expect(form.patch_override).toBe(true);
  });

  it('hydrates a segmentation-only slide (no tiling yet) with encoder-default tiling', () => {
    const form = hydrateFormFromRows([seg]);
    expect(form.segmenter).toBe('otsu');
    expect(form.remove_penmarks).toBe(true);
    // no patch grid → tiling follows the default encoder (conch_v1_text → 512/20)
    expect(form.encoder).toBe('conch_v1_text');
    expect(form.patch_size).toBe(512);
    expect(form.mag).toBe(20);
  });
});
