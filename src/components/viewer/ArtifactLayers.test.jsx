// The layer owner (Inc 5 · 03a). The claim under test is the one the ticket exists for: what is on
// the viewer follows the store, and nothing else — not a panel being open, not a tab being active.
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/tissueApi.js', () => ({
  getTissueMeta: vi.fn(),
  tileUrl: (item, hash, layer, z, x, y) => `/t/${hash}/${layer}/${z}/${x}/${y}.png`,
  tileAjaxHeaders: () => ({}),
}));
vi.mock('../../api/biomarkerApi.js', () => ({
  getBiomarkerMeta: vi.fn(),
  getCatalog: vi.fn(),
}));
vi.mock('../../api/preprocessApi.js', () => ({ getSegmentationContours: vi.fn() }));
vi.mock('./markerLayers.js', () => ({
  syncMarkerLayer: vi.fn(() => 'marker-signature'),
  setMarkersBase: vi.fn(),
  clearMarkerLayers: vi.fn(),
}));
vi.mock('./overlayLayers.js', () => ({
  buildTileSource: vi.fn(() => ({ fake: 'tileSource' })),
  syncLayer: vi.fn(() => 'mounted-signature'),
  removeLayer: vi.fn(),
  setBasePreference: vi.fn(),
  LAYER_ORDER: ['tissue', 'markers', 'pheno'],
}));

import ArtifactLayers, { visibleHashOf } from './ArtifactLayers.jsx';
import { getTissueMeta } from '../../api/tissueApi.js';
import { getBiomarkerMeta, getCatalog } from '../../api/biomarkerApi.js';
import { getSegmentationContours } from '../../api/preprocessApi.js';
import { syncMarkerLayer } from './markerLayers.js';
import { removeLayer, syncLayer } from './overlayLayers.js';
import { useStore } from '../../store/index.js';

const META = {
  slide: { width: 40000, height: 30000 },
  classes: ['Tumour', 'Stroma', 'Others'],
  levels: 6,
  level_offset: 2,
};

const BIO_META = { slide: { width: 40000, height: 30000 }, levels: 6, level_offset: 2 };
const CONTOURS = { type: 'FeatureCollection', features: [] };

const VIEWER = { id: 'osd' };

describe('ArtifactLayers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTissueMeta.mockResolvedValue(META);
    getBiomarkerMeta.mockResolvedValue(BIO_META);
    getCatalog.mockResolvedValue({ dapi_color: '808080', presets: {} });
    getSegmentationContours.mockResolvedValue(CONTOURS);
    useStore.setState({
      viewer: VIEWER,
      activeItem: { _id: 'item-1' },
      visibleArtifacts: {},
      tissueLayerParams: {},
      markerLayerParams: {},
      tissueContours: {},
    });
  });

  it('draws nothing while no artifact is switched on', async () => {
    render(<ArtifactLayers />);
    await waitFor(() => expect(removeLayer).toHaveBeenCalledWith(VIEWER, 'tissue'));
    expect(syncLayer).not.toHaveBeenCalled();
    expect(getTissueMeta).not.toHaveBeenCalled();
  });

  it('mounts the tissue layer once its artifact is visible', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);

    await waitFor(() => expect(syncLayer).toHaveBeenCalled());
    expect(getTissueMeta).toHaveBeenCalledWith('item-1', 'tis1');
    const [viewer, opts] = syncLayer.mock.calls.at(-1);
    expect(viewer).toBe(VIEWER);
    expect(opts.key).toBe('tissue');
    expect(opts.signature).toContain('tis1');
  });

  it('takes it down again when the eye is switched off', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);
    await waitFor(() => expect(syncLayer).toHaveBeenCalled());

    removeLayer.mockClear();
    useStore.getState().setArtifactVisible('tis1', 'tissue', false);
    await waitFor(() => expect(removeLayer).toHaveBeenCalledWith(VIEWER, 'tissue'));
  });

  it('re-renders the layer when the panel changes a parameter', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);
    await waitFor(() => expect(syncLayer).toHaveBeenCalled());
    const before = syncLayer.mock.calls.length;

    useStore.getState().setTissueLayerParams({ opacity: 0.9 });
    await waitFor(() => expect(syncLayer.mock.calls.length).toBeGreaterThan(before));
    expect(syncLayer.mock.calls.at(-1)[1].opacity).toBe(0.9);
  });

  it('asks for a different picture when the render mode changes', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);
    await waitFor(() => expect(syncLayer).toHaveBeenCalled());
    const first = syncLayer.mock.calls.at(-1)[1].signature;

    useStore.getState().setTissueLayerParams({ render: 'probs' });
    await waitFor(() => expect(syncLayer.mock.calls.at(-1)[1].signature).not.toBe(first));
  });

  it('leaves no layer stranded when the viewer goes away', async () => {
    const { unmount } = render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);
    await waitFor(() => expect(syncLayer).toHaveBeenCalled());

    removeLayer.mockClear();
    unmount();
    expect(removeLayer).toHaveBeenCalledWith(VIEWER, 'tissue');
  });

  it('does not mount a build that has nothing to draw yet', async () => {
    getTissueMeta.mockRejectedValue(new Error('404'));
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);

    await waitFor(() => expect(getTissueMeta).toHaveBeenCalled());
    expect(syncLayer).not.toHaveBeenCalled();
  });
});

describe('one layer slot per kind', () => {
  beforeEach(() => useStore.setState({ visibleArtifacts: {} }));

  it('switching on a second tissue map switches off the first', () => {
    const { setArtifactVisible } = useStore.getState();
    setArtifactVisible('tis1', 'tissue', true);
    setArtifactVisible('tis2', 'tissue', true);
    // Otherwise the first row keeps an open eye over a map that is no longer drawn.
    expect(useStore.getState().visibleArtifacts).toEqual({ tis2: { kind: 'tissue' } });
  });

  it('leaves other kinds alone', () => {
    const { setArtifactVisible } = useStore.getState();
    setArtifactVisible('bio1', 'biomarker', true);
    setArtifactVisible('tis1', 'tissue', true);
    expect(useStore.getState().visibleArtifacts)
      .toEqual({ bio1: { kind: 'biomarker' }, tis1: { kind: 'tissue' } });
  });

  it('finds the visible artifact of a kind, or nothing', () => {
    expect(visibleHashOf({ a: { kind: 'tissue' } }, 'tissue')).toBe('a');
    expect(visibleHashOf({ a: { kind: 'tissue' } }, 'biomarker')).toBe(null);
    expect(visibleHashOf({}, 'tissue')).toBe(null);
    expect(visibleHashOf(undefined, 'tissue')).toBe(null);
  });
});

describe('the biomarker layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBiomarkerMeta.mockResolvedValue(BIO_META);
    getCatalog.mockResolvedValue({ dapi_color: '808080', presets: {} });
    getTissueMeta.mockResolvedValue(META);
    getSegmentationContours.mockResolvedValue(CONTOURS);
    useStore.setState({
      viewer: VIEWER, activeItem: { _id: 'item-1' },
      visibleArtifacts: {}, tissueLayerParams: {}, markerLayerParams: {}, tissueContours: {},
    });
  });

  it('mounts nothing until a biomarker artifact is switched on', async () => {
    render(<ArtifactLayers />);
    await waitFor(() => expect(syncMarkerLayer).toHaveBeenCalled());
    expect(syncMarkerLayer.mock.calls.at(-1)[1].layer).toBe(null);
    expect(getBiomarkerMeta).not.toHaveBeenCalled();
  });

  it('mounts the markers layer, in the mode the panel chose', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('bio1', 'biomarker', true);

    await waitFor(() => expect(syncMarkerLayer.mock.calls.at(-1)[1].layer).toBe('markers'));
    expect(getBiomarkerMeta).toHaveBeenCalledWith('item-1', 'bio1');

    useStore.getState().setMarkerLayerParams({ mode: 'pheno' });
    await waitFor(() => expect(syncMarkerLayer.mock.calls.at(-1)[1].layer).toBe('pheno'));
  });

  it('takes it down when the eye is switched off', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('bio1', 'biomarker', true);
    await waitFor(() => expect(syncMarkerLayer.mock.calls.at(-1)[1].layer).toBe('markers'));

    useStore.getState().setArtifactVisible('bio1', 'biomarker', false);
    await waitFor(() => expect(syncMarkerLayer.mock.calls.at(-1)[1].layer).toBe(null));
  });

  it('draws a tissue map and a biomarker layer at the same time', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('tis1', 'tissue', true);
    useStore.getState().setArtifactVisible('bio1', 'biomarker', true);

    await waitFor(() => expect(syncLayer).toHaveBeenCalled());
    await waitFor(() => expect(syncMarkerLayer.mock.calls.at(-1)[1].layer).toBe('markers'));
    expect(syncLayer.mock.calls.at(-1)[1].key).toBe('tissue');
  });
});

describe('the segmentation outline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSegmentationContours.mockResolvedValue(CONTOURS);
    getTissueMeta.mockResolvedValue(META);
    getBiomarkerMeta.mockResolvedValue(BIO_META);
    getCatalog.mockResolvedValue({ dapi_color: '808080', presets: {} });
    useStore.setState({
      viewer: VIEWER, activeItem: { _id: 'item-1' },
      visibleArtifacts: {}, tissueLayerParams: {}, markerLayerParams: {}, tissueContours: {},
    });
  });

  it('fetches the contours when a segmentation is switched on', async () => {
    render(<ArtifactLayers />);
    expect(getSegmentationContours).not.toHaveBeenCalled();

    useStore.getState().setArtifactVisible('seg1', 'segmentation', true);
    await waitFor(() => expect(getSegmentationContours).toHaveBeenCalledWith('item-1', 'seg1'));
    await waitFor(() => expect(useStore.getState().tissueContours.seg1).toEqual(CONTOURS));
  });

  it('does not fetch them again to switch the outline back on', async () => {
    render(<ArtifactLayers />);
    useStore.getState().setArtifactVisible('seg1', 'segmentation', true);
    await waitFor(() => expect(useStore.getState().tissueContours.seg1).toEqual(CONTOURS));

    useStore.getState().setArtifactVisible('seg1', 'segmentation', false);
    useStore.getState().setArtifactVisible('seg1', 'segmentation', true);
    await waitFor(() => expect(useStore.getState().tissueContours.seg1).toEqual(CONTOURS));
    expect(getSegmentationContours).toHaveBeenCalledTimes(1);
  });
});
