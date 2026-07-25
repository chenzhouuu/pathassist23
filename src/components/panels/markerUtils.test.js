import { describe, it, expect } from 'vitest';
import {
  DAPI_WEIGHT,
  DEFAULT_DISPLAY,
  channelParam,
  coverageSummary,
  describeStage,
  findBiomarkerRow,
  findReadySegmentation,
  layerSignature,
  layerLevels,
  levelOffsetFor,
  markerLabel,
  phenotypeLegend,
  presetChannels,
  presetNames,
  separableMarkers,
  tileParams,
} from './markerUtils.js';

const CATALOG = {
  presets: {
    Immune: [{ marker: 'CD3', color: 'ff0000' }, { marker: 'CD8', color: '8000ff' }],
    Structural: [{ marker: 'CK', color: '00ffff' }],
  },
  markers: ['CD3', 'CD8', 'CK'],
  equivalents: { Transgelin: 'SM22α — near-equivalent of α-SMA' },
};

describe('channelParam', () => {
  it('builds an ordered marker:colour spec and strips the hash', () => {
    expect(channelParam([
      { marker: 'CK', color: '#00ffff' },
      { marker: 'CD8', color: '8000ff' },
    ])).toBe('CK:00ffff,CD8:8000ff');
  });

  it('drops unchecked channels', () => {
    expect(channelParam([
      { marker: 'CK', color: '#00ffff', enabled: true },
      { marker: 'CD8', color: '#8000ff', enabled: false },
    ])).toBe('CK:00ffff');
  });

  it('is empty for no channels', () => {
    expect(channelParam([])).toBe('');
    expect(channelParam()).toBe('');
  });
});

describe('tileParams', () => {
  it('carries the selection and the display transfer function for markers', () => {
    const p = tileParams('markers', {
      channels: [{ marker: 'CK', color: '#00ffff' }],
      display: { gamma: 0.5 },
      dapi: '#808080',
    });
    expect(p.ch).toBe('CK:00ffff');
    expect(p.dapi).toBe('808080:0.35');   // colour:weight — DAPI rides behind the markers
    expect(p.gamma).toBe('0.5');
    expect(p.lo).toBe(String(DEFAULT_DISPLAY.lo));   // unspecified keys keep the default
  });

  it('lets the caller dim DAPI independently of the markers', () => {
    const p = tileParams('markers', { channels: [], dapi: '808080', dapiWeight: 0.1 });
    expect(p.dapi).toBe('808080:0.1');
    expect(DAPI_WEIGHT).toBeLessThan(1);   // the default must not drown the coloured channels
  });

  it('carries only the lineage filter for phenotype', () => {
    expect(tileParams('pheno', { show: ['Tumour', 'Cytotoxic T'] }))
      .toEqual({ show: 'Tumour,Cytotoxic T' });
    expect(tileParams('pheno', {})).toEqual({});
  });
});

describe('layerSignature', () => {
  it('is stable under key reordering so OSD does not refetch every tile', () => {
    const a = layerSignature('markers', 'h1', { ch: 'CK:00ffff', gamma: '0.8', lo: '0.15' });
    const b = layerSignature('markers', 'h1', { lo: '0.15', ch: 'CK:00ffff', gamma: '0.8' });
    expect(a).toBe(b);
  });

  it('changes when the picture changes', () => {
    const a = layerSignature('markers', 'h1', { ch: 'CK:00ffff' });
    expect(layerSignature('markers', 'h1', { ch: 'CD8:00ffff' })).not.toBe(a);
    expect(layerSignature('pheno', 'h1', { ch: 'CK:00ffff' })).not.toBe(a);
    expect(layerSignature('markers', 'h2', { ch: 'CK:00ffff' })).not.toBe(a);
  });

  it('collapses to the mode when there is nothing to show', () => {
    expect(layerSignature('he', null, {})).toBe('he');
  });
});

describe('level offsets', () => {
  it('reads the offset from meta so the frontend hardcodes no resolution', () => {
    const meta = { layers: { markers: { level_offset: 2, levels: 9 },
                             pheno: { level_offset: 0, levels: 11 } } };
    expect(levelOffsetFor(meta, 'markers')).toBe(2);
    expect(levelOffsetFor(meta, 'pheno')).toBe(0);
    expect(layerLevels(meta, 'pheno')).toBe(11);
  });

  it('falls back to the designed offsets when meta is missing', () => {
    expect(levelOffsetFor(null, 'markers')).toBe(2);
    expect(levelOffsetFor(null, 'pheno')).toBe(0);
    expect(layerLevels(null, 'markers')).toBe(1);
  });
});

describe('presets', () => {
  it('returns a preset as an enabled channel set with # colours', () => {
    expect(presetChannels(CATALOG, 'Immune')).toEqual([
      { marker: 'CD3', color: '#ff0000', enabled: true },
      { marker: 'CD8', color: '#8000ff', enabled: true },
    ]);
  });

  it('is empty for an unknown preset rather than throwing', () => {
    expect(presetChannels(CATALOG, 'Nope')).toEqual([]);
    expect(presetChannels(null, 'Immune')).toEqual([]);
  });

  it('lists the available preset names', () => {
    expect(presetNames(CATALOG)).toEqual(['Immune', 'Structural']);
    expect(presetNames(null)).toEqual([]);
  });
});

describe('markerLabel', () => {
  it('labels a near-equivalent as one instead of renaming it', () => {
    expect(markerLabel(CATALOG, 'Transgelin')).toContain('α-SMA');
    expect(markerLabel(CATALOG, 'Transgelin')).toMatch(/^Transgelin/);
  });

  it('leaves a real antibody alone', () => {
    expect(markerLabel(CATALOG, 'CD8')).toBe('CD8');
  });
});

describe('artifact rows', () => {
  const rows = [
    { kind: 'segmentation', status: 'ready', art_hash: 'seg1' },
    { kind: 'biomarker', status: 'running', progress: 0.42, stage: 'tiles' },
  ];

  it('finds the map row and the ready segmentation it needs', () => {
    expect(findBiomarkerRow(rows).kind).toBe('biomarker');
    expect(findReadySegmentation(rows).art_hash).toBe('seg1');
    expect(findReadySegmentation([{ kind: 'segmentation', status: 'running' }])).toBe(null);
    expect(findBiomarkerRow([])).toBe(null);
  });

  it('describes a build concretely enough to tell it is alive', () => {
    expect(describeStage(null)).toBe('Not built');
    expect(describeStage(rows[1])).toBe('Analysing tiles 42%');
    expect(describeStage({ status: 'running', stage: 'sampling', progress: 0.03 }))
      .toBe('Sampling thresholds 3%');
    expect(describeStage({ status: 'ready', result: { n_cells: 12345 } }))
      .toBe('Ready — 12,345 cells');
    expect(describeStage({ status: 'failed', error: 'no tissue' })).toContain('no tissue');
  });
});

describe('meta readers', () => {
  const meta = {
    slide: { mpp: 0.25 },
    coverage: { core: 2048, n_tiles: 4 },
    thresholds: { CK: 0.42, CD8: 0.31, FOXP3: null },
    summary: { counts_by_phenotype: { Tumour: 900, 'Cytotoxic T': 120, 'Mast cell': 0 } },
  };

  it('orders the legend by count and drops empty lineages', () => {
    expect(phenotypeLegend(meta)).toEqual([
      { name: 'Tumour', count: 900 },
      { name: 'Cytotoxic T', count: 120 },
    ]);
    expect(phenotypeLegend(null)).toEqual([]);
  });

  it('lists only markers with a separable positive population', () => {
    // a null threshold means "not bimodal on this slide", not "everything is negative"
    expect(separableMarkers(meta)).toEqual(['CK', 'CD8']);
    expect(separableMarkers(null)).toEqual([]);
  });

  it('summarises coverage in real units', () => {
    // 4 tiles x (2048 * 0.25 / 1000 mm)^2 = 4 * 0.512^2 ≈ 1.05 mm²
    expect(coverageSummary(meta)).toEqual({ tiles: 4, mm2: 1.05 });
    expect(coverageSummary({})).toBe(null);
  });
});
