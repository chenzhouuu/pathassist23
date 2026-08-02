import { describe, it, expect } from 'vitest';
import {
  ENCODERS, SEGMENTERS, DEFAULT_FORM,
  encoderMeta, encoderLabel, isTextCapable, recommendedPatchSize, recommendedMag, bindEncoder,
  pickSegParams, pickTileParams,
} from './encoders.js';

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
