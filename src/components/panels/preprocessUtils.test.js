import { describe, it, expect } from 'vitest';
import {
  ENCODERS, SEGMENTERS, DEFAULT_PARAMS,
  encoderMeta, encoderLabel, isTextCapable, stageLabel, progressPercent, fmtInt,
  normalizeParams, paramsMatch, findMatchingIndex, isInFlight, anyInFlight, describeIndex,
} from './preprocessUtils.js';

describe('encoder catalog', () => {
  it('marks conch_v1 as text-capable and the UNI encoders as image-only (F1)', () => {
    expect(isTextCapable('conch_v1')).toBe(true);
    expect(isTextCapable('uni_v2')).toBe(false);
    expect(isTextCapable('uni_v1')).toBe(false);
    // Gated encoders not offered on this deployment resolve as unknown → not text-capable.
    expect(isTextCapable('conch_v15')).toBe(false);
  });
  it('every encoder has a human label', () => {
    for (const e of ENCODERS) expect(e.label).toBeTruthy();
    expect(encoderLabel('conch_v1')).toBe('CONCH v1');
  });
  it('encoderLabel falls back to the raw id for an unknown encoder', () => {
    expect(encoderLabel('mystery')).toBe('mystery');
    expect(encoderMeta('mystery')).toBeNull();
    expect(isTextCapable('mystery')).toBe(false);
  });
  it('defaults to the text-capable encoder at 20× / 256 / hest', () => {
    expect(DEFAULT_PARAMS).toEqual({
      encoder: 'conch_v1', mag: 20, patch_size: 256, segmenter: 'hest',
    });
    expect(isTextCapable(DEFAULT_PARAMS.encoder)).toBe(true);  // default build enables text search
    expect(SEGMENTERS.map((s) => s.id)).toContain('hest');
  });
});

describe('stage / progress / int formatting', () => {
  it('maps known stages and falls back for unknown', () => {
    expect(stageLabel('segmentation')).toBe('Segmenting tissue');
    expect(stageLabel('features')).toBe('Encoding features');
    expect(stageLabel('whatever')).toBe('Working');
  });
  it('clamps and rounds progress to 0–100', () => {
    expect(progressPercent({ progress: 0.5 })).toBe(50);
    expect(progressPercent({ progress: 0 })).toBe(0);
    expect(progressPercent({ progress: 1.4 })).toBe(100);
    expect(progressPercent({})).toBe(0);
    expect(progressPercent(null)).toBe(0);
  });
  it('formats integers with separators, blanks non-numbers', () => {
    expect(fmtInt(8412)).toBe((8412).toLocaleString());
    expect(fmtInt(undefined)).toBe('');
    expect(fmtInt(null)).toBe('');
  });
});

describe('normalizeParams', () => {
  it('coerces mag and patch_size to numbers', () => {
    const out = normalizeParams({ encoder: 'conch_v1', mag: '20', patch_size: '256', segmenter: 'hest' });
    expect(out).toEqual({ encoder: 'conch_v1', mag: 20, patch_size: 256, segmenter: 'hest' });
  });
});

describe('paramsMatch / findMatchingIndex', () => {
  const params = { encoder: 'conch_v1', mag: 20, patch_size: 256, segmenter: 'hest' };
  it('matches a row with equal params, numeric-coercing mag/patch_size', () => {
    expect(paramsMatch({ encoder: 'conch_v1', mag: '20', patch_size: '256', segmenter: 'hest' }, params)).toBe(true);
  });
  it('treats a missing row segmenter as the default', () => {
    expect(paramsMatch({ encoder: 'conch_v1', mag: 20, patch_size: 256 }, params)).toBe(true);
  });
  it('does not match on a different encoder or mag', () => {
    expect(paramsMatch({ encoder: 'conch_v15', mag: 20, patch_size: 256, segmenter: 'hest' }, params)).toBe(false);
    expect(paramsMatch({ encoder: 'conch_v1', mag: 40, patch_size: 256, segmenter: 'hest' }, params)).toBe(false);
    expect(paramsMatch(null, params)).toBe(false);
  });
  it('finds the matching row among several, else null', () => {
    const rows = [
      { encoder: 'conch_v15', mag: 20, patch_size: 256, segmenter: 'hest' },
      { encoder: 'conch_v1', mag: 20, patch_size: 256, segmenter: 'hest', status: 'ready' },
    ];
    expect(findMatchingIndex(rows, params)?.status).toBe('ready');
    expect(findMatchingIndex(rows, { ...params, mag: 5 })).toBeNull();
    expect(findMatchingIndex([], params)).toBeNull();
    expect(findMatchingIndex(undefined, params)).toBeNull();
  });
});

describe('in-flight detection', () => {
  it('treats queued/running as in-flight, ready/failed as settled', () => {
    expect(isInFlight({ status: 'queued' })).toBe(true);
    expect(isInFlight({ status: 'running' })).toBe(true);
    expect(isInFlight({ status: 'ready' })).toBe(false);
    expect(isInFlight({ status: 'failed' })).toBe(false);
    expect(anyInFlight([{ status: 'ready' }, { status: 'running' }])).toBe(true);
    expect(anyInFlight([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
    expect(anyInFlight([])).toBe(false);
  });
});

describe('describeIndex', () => {
  it('describes an absent index as not preprocessed', () => {
    const d = describeIndex(null);
    expect(d.state).toBe('none');
    expect(d.title).toMatch(/not preprocessed/i);
  });
  it('describes a ready index with encoder, mag, and patch count', () => {
    const d = describeIndex({ status: 'ready', encoder: 'conch_v1', mag: 20, n_patches: 8412 });
    expect(d.state).toBe('ready');
    expect(d.title).toContain('CONCH v1');
    expect(d.title).toContain('20×');
    expect(d.detail).toContain((8412).toLocaleString());
  });
  it('describes an in-flight index with stage and percent', () => {
    const d = describeIndex({ status: 'running', stage: 'features', progress: 0.7 });
    expect(d.state).toBe('running');
    expect(d.title).toContain('Encoding features');
    expect(d.detail).toBe('70%');
  });
  it('describes a failed index with its error', () => {
    const d = describeIndex({ status: 'failed', error: 'slide not found' });
    expect(d.state).toBe('failed');
    expect(d.detail).toBe('slide not found');
  });
});
