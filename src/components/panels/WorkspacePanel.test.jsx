// The Workspace list (Inc 5 · 02). Two things are worth asserting: that a row says the four things
// §5.2 asks for, read off the artifact table and nothing else, and that a build in flight arrives
// at ready on its own.
import React from 'react';
import { act, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/preprocessApi.js', () => ({
  listArtifacts: vi.fn(),
  getArtifactUsage: vi.fn(),
  deleteArtifact: vi.fn(),
}));
vi.mock('../../api/nucleiApi.js', () => ({ getNucleiMeta: vi.fn() }));
// Tissue and biomarker joined the same registry in Inc 6 · 06, so the panel now reads three kinds'
// meta — and the marker map's one catalog, whose palette is the deployed model's rather than any
// artifact's.
vi.mock('../../api/tissueApi.js', () => ({ getTissueMeta: vi.fn() }));
vi.mock('../../api/biomarkerApi.js', () => ({ getBiomarkerMeta: vi.fn(), getCatalog: vi.fn() }));
// The panel shares the Analysis poller's query key (Inc 6 · 04), so the runs feed has to answer
// here too — the list is artifacts *union* the runs in flight for this slide.
vi.mock('../../api/index.js', () => ({ listRuns: vi.fn(), cancelJob: vi.fn() }));

import WorkspacePanel from './WorkspacePanel.jsx';
import { deleteArtifact, getArtifactUsage, listArtifacts } from '../../api/preprocessApi.js';
import { getNucleiMeta } from '../../api/nucleiApi.js';
import { getTissueMeta } from '../../api/tissueApi.js';
import { getBiomarkerMeta, getCatalog } from '../../api/biomarkerApi.js';
import { listRuns } from '../../api/index.js';
import { useStore } from '../../store/index.js';
import { useRunsStore } from '../../store/runs.js';

const render = (ui = <WorkspacePanel />) => rtlRender(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>,
);

const SLIDE = { _id: 'item-1', name: 'slide.svs' };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** The row a title sits in — every row's controls are scoped to it, and titles repeat across rows. */
const rowFor = (title) => screen.getByText(title).closest('[data-cy="data-row"]');

const ROWS = [
  {
    kind: 'segmentation', art_hash: 'seg1', status: 'ready', n_items: 3,
    params: { segmenter: 'hest' }, result: {}, created_at: iso(3 * 3600_000),
  },
  {
    kind: 'features', art_hash: 'feat1', status: 'ready', n_items: 900, dim: 512,
    params: { encoder: 'conch_v1' }, result: {}, created_at: iso(2 * 3600_000),
  },
  {
    kind: 'tissue', art_hash: 'tis1', status: 'ready',
    params: { backend: 'hover-next' },
    result: { n_core_tiles: 240, covered_mm2: 18.34, tsr: 0.42 },
    created_at: iso(60_000),
  },
];

describe('WorkspacePanel', () => {
  beforeEach(() => {
    useStore.setState({
      activeItem: SLIDE, visibleArtifacts: {},
      nucleiLayerParams: {}, tissueLayerParams: {}, markerLayerParams: {},
    });
    useRunsStore.setState({ byId: {}, loaded: false, stopping: {} });
    listArtifacts.mockResolvedValue([]);
    listRuns.mockResolvedValue([]);
    getNucleiMeta.mockResolvedValue(null);
    getTissueMeta.mockResolvedValue(null);
    getBiomarkerMeta.mockResolvedValue(null);
    getCatalog.mockResolvedValue(CATALOG);
    getArtifactUsage.mockResolvedValue({ bytes: 0, dependants: [] });
    deleteArtifact.mockResolvedValue({ deleted: true, dependants: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('asks for a slide before fetching anything', () => {
    useStore.setState({ activeItem: null });
    render(<WorkspacePanel />);
    expect(screen.getByText('No slide selected')).toBeInTheDocument();
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  it('says so when the slide has never been built on', async () => {
    render(<WorkspacePanel />);
    expect(await screen.findByText(/Nothing has been built/)).toBeInTheDocument();
  });

  it('lists every kind, drawable or not, with its params, scale and age', async () => {
    listArtifacts.mockResolvedValue(ROWS);
    render(<WorkspacePanel />);

    expect(await screen.findByText('Artifacts (3)')).toBeInTheDocument();
    expect(screen.getByText('Segmentation')).toBeInTheDocument();
    expect(screen.getByText('Features')).toBeInTheDocument();      // no overlay, still a row
    expect(screen.getByText('Tissue map')).toBeInTheDocument();

    expect(screen.getByText('3 tissue regions')).toBeInTheDocument();
    expect(screen.getByText('900 vectors × 512')).toBeInTheDocument();
    expect(screen.getByText('240 tiles · 18.3 mm² · TSR 42%')).toBeInTheDocument();
    expect(screen.getByText('hover-next')).toBeInTheDocument();
    expect(screen.getByText('1m ago')).toBeInTheDocument();
  });

  it('puts the newest artifact at the top', async () => {
    listArtifacts.mockResolvedValue(ROWS);
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');
    const titles = screen.getAllByText(/^(Segmentation|Features|Tissue map)$/)
      .map((el) => el.textContent);
    expect(titles).toEqual(['Tissue map', 'Features', 'Segmentation']);
  });

  it('offers an eye to every drawable kind and to no other', async () => {
    listArtifacts.mockResolvedValue(ROWS);
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');
    // Segmentation and tissue can be drawn; a features artifact has nothing to put on a slide.
    expect(screen.getAllByRole('button', { name: /^(Show|Hide)$/ })).toHaveLength(2);
    expect(within(rowFor('Features')).queryByRole('button', { name: /^(Show|Hide)$/ }))
      .not.toBeInTheDocument();
  });

  it('records the artifact as visible when its eye is clicked, and clears it when clicked again',
    async () => {
      listArtifacts.mockResolvedValue(ROWS);
      render(<WorkspacePanel />);
      await screen.findByText('Tissue map');

      await userEvent.click(within(rowFor('Tissue map')).getByRole('button', { name: 'Show' }));
      expect(useStore.getState().visibleArtifacts).toEqual({ tis1: { kind: 'tissue' } });

      await userEvent.click(within(rowFor('Tissue map')).getByRole('button', { name: 'Hide' }));
      expect(useStore.getState().visibleArtifacts).toEqual({});
    });

  it('lets a tissue map and an outline be on the slide at the same time', async () => {
    listArtifacts.mockResolvedValue(ROWS);
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');

    await userEvent.click(within(rowFor('Tissue map')).getByRole('button', { name: 'Show' }));
    await userEvent.click(within(rowFor('Segmentation')).getByRole('button', { name: 'Show' }));
    // Different kinds, different layer slots — switching one on must not switch the other off.
    expect(useStore.getState().visibleArtifacts)
      .toEqual({ tis1: { kind: 'tissue' }, seg1: { kind: 'segmentation' } });
  });

  it('nothing is on the slide until an eye is clicked', async () => {
    listArtifacts.mockResolvedValue(ROWS);
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');
    expect(useStore.getState().visibleArtifacts).toEqual({});
    expect(within(rowFor('Tissue map')).getByRole('button', { name: 'Show' })).toBeInTheDocument();
  });

  it('carries a growing build to its finished counts without a manual refresh', async () => {
    // The row cannot say it is building any more (Inc 6 · 07 — a row exists only where bytes do),
    // so what keeps this list moving is the *run*: while one is unfinished, its counts are still
    // being written and the list re-reads them.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listRuns.mockResolvedValue([{
      id: 'j1', status: 2, artHash: 'tis1', slideKey: 'item-1', lane: 'pathassist',
      created: iso(10_000), progress: { current: 4, total: 43, message: '4 / 43 · tiles' },
    }]);
    const partial = [{
      kind: 'tissue', art_hash: 'tis1', status: 'ready',
      params: { backend: 'hover-next' }, result: { n_core_tiles: 4 }, created_at: iso(10_000),
    }];
    listArtifacts.mockResolvedValue(partial);
    render(<WorkspacePanel />);
    expect(await screen.findByText('4 / 43 · tiles')).toBeInTheDocument();

    listArtifacts.mockResolvedValue([{ ...partial[0], result: { n_core_tiles: 12 } }]);
    await vi.advanceTimersByTimeAsync(2600);
    await waitFor(() => expect(screen.getByText('12 tiles')).toBeInTheDocument());
  });

  it('stops polling once nothing is building', async () => {
    listArtifacts.mockResolvedValue(ROWS);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');
    const calls = listArtifacts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listArtifacts.mock.calls.length).toBe(calls);
  });

  it('shows the reason when the list cannot be fetched', async () => {
    listArtifacts.mockRejectedValue(new Error('gateway unreachable'));
    render(<WorkspacePanel />);
    expect(await screen.findByText('gateway unreachable')).toBeInTheDocument();
  });
});

describe('deleting an artifact', () => {
  const openMenu = async (title) => {
    await userEvent.click(within(rowFor(title)).getByRole('button', { name: 'Actions' }));
    return screen.getByRole('menuitem', { name: /delete/i });
  };

  beforeEach(() => {
    useStore.setState({ activeItem: SLIDE, visibleArtifacts: {} });
    listArtifacts.mockResolvedValue(ROWS);
    getArtifactUsage.mockResolvedValue({ bytes: 0, dependants: [] });
    deleteArtifact.mockResolvedValue({ deleted: true, dependants: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('names the artifact and what it frees before deleting anything', async () => {
    getArtifactUsage.mockResolvedValue({ bytes: 304_087_040, dependants: [] });
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');

    await userEvent.click(await openMenu('Tissue map'));

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    const asked = window.confirm.mock.calls[0][0];
    expect(asked).toContain('Tissue map (hover-next)');
    expect(asked).toContain('290 MB');
    expect(asked).toMatch(/cannot be undone/i);
    expect(deleteArtifact).toHaveBeenCalledWith('item-1', 'tis1');
  });

  it('deletes nothing when the confirm is declined', async () => {
    window.confirm.mockReturnValue(false);
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');

    await userEvent.click(await openMenu('Tissue map'));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(deleteArtifact).not.toHaveBeenCalled();
  });

  it('refuses without asking when something was built from it, and names what', async () => {
    getArtifactUsage.mockResolvedValue({
      bytes: 1024,
      dependants: [
        { kind: 'tissue', art_hash: 't1', params: { backend: 'hover-next' } },
        { kind: 'patching', art_hash: 'p1', params: { patch_size: 256, mag: 20 } },
      ],
    });
    render(<WorkspacePanel />);
    await screen.findByText('Segmentation');

    await userEvent.click(await openMenu('Segmentation'));

    expect(await screen.findByText(/was used to build 2 other artifacts/)).toBeInTheDocument();
    expect(screen.getByText('Tissue map (hover-next)')).toBeInTheDocument();
    expect(screen.getByText('Patching (256 px · 20×)')).toBeInTheDocument();
    // Not a question — there is nothing for the user to agree to.
    expect(window.confirm).not.toHaveBeenCalled();
    expect(deleteArtifact).not.toHaveBeenCalled();
  });

  it('takes the gateway as the authority when the list has gone stale', async () => {
    deleteArtifact.mockResolvedValue({
      deleted: false,
      dependants: [{ kind: 'tissue', art_hash: 't1', params: {} }],
    });
    render(<WorkspacePanel />);
    await screen.findByText('Segmentation');

    await userEvent.click(await openMenu('Segmentation'));
    expect(await screen.findByText(/was used to build another artifact/)).toBeInTheDocument();
  });

  it('reloads the list once the artifact is gone', async () => {
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');
    listArtifacts.mockResolvedValue(ROWS.filter((r) => r.art_hash !== 'tis1'));

    await userEvent.click(await openMenu('Tissue map'));
    await waitFor(() => expect(screen.queryByText('Tissue map')).not.toBeInTheDocument());
    expect(screen.getByText('Artifacts (2)')).toBeInTheDocument();
  });

  it('shows the reason when the delete itself fails', async () => {
    deleteArtifact.mockRejectedValue(new Error('gateway unreachable'));
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');

    await userEvent.click(await openMenu('Tissue map'));
    expect(await screen.findByText('gateway unreachable')).toBeInTheDocument();
  });
});

// ── Inc 6 · 04 — a row has an inside ────────────────────────────────────────────────────
//
// The controls that used to be the body of NucleiPanel now open under the artifact they belong to.
// What is worth asserting is the part that is not obvious from the code: that hiding a class from
// the picture leaves its count on screen, that the parameters go to the store rather than to local
// state (the mask keeps drawing while this panel is closed), and that a job with no artifact row
// yet still puts something on the list.

const NUCLEI_ROW = {
  kind: 'nuclei', art_hash: 'nuc1', status: 'ready',
  params: {}, result: { n_nuclei: 15180 }, created_at: iso(60_000),
};

const NUCLEI_META = {
  summary: {
    n_nuclei: 15180,
    area_mm2: 19.28,
    counts_by_class: { Connective: 10955, Neoplastic: 3836, Inflammatory: 168, Epithelial: 221 },
  },
  coverage: { n_tiles: 72 },
  classes: ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'],
  colors: { Neoplastic: '#e94560', Connective: '#4caf82' },
  layers: { classes: { levels: 5 }, instances: { levels: 5 } },
};

// ── the two kinds that joined the registry in Inc 6 · 06 ───────────────────────────────

const CATALOG = {
  presets: { Lineage: [{ marker: 'CK', color: '00ffff' }, { marker: 'CD3', color: 'ff0000' }] },
  markers: ['CK', 'CD3', 'CD8'],
  equivalents: {},
  phenotype_colors: { Tumour: '#e94560', 'Cytotoxic T': '#4da6ff' },
};

const TISSUE_META = {
  backend: 'bcss_fcn_unet',
  classes: ['Tumour', 'Stroma', 'Others'],
  colors: { Tumour: '#D55E00', Stroma: '#0072B2', Others: '#999999' },
  coverage: { n_tiles: 43 },
  layers: { classes: { levels: 4 }, probs: { levels: 4 } },
  summary: {
    covered_mm2: 11.28, tsr: 0.4212,
    fraction: { Tumour: 0.5, Stroma: 0.45, Others: 0.05 },
    fraction_soft: { Tumour: 0.5, Stroma: 0.45, Others: 0.05 },
    pixels: { Tumour: 500, Stroma: 450, Others: 50 },
  },
};

const BIO_ROW = {
  kind: 'biomarker', art_hash: 'bio1', status: 'ready',
  params: {}, result: { n_cells: 222412, n_tiles: 4 }, created_at: iso(30_000),
};

const BIO_META = {
  coverage: { core: 2048, n_tiles: 4 },
  slide: { mpp: 0.25 },
  thresholds: { CK: 0.42, CD3: null },
  summary: { n_cells: 222412, counts_by_phenotype: { Tumour: 900, 'Cytotoxic T': 120 } },
  layers: { markers: { levels: 4 }, pheno: { levels: 6 } },
};

/** These blocks sit outside `describe('WorkspacePanel')`, so they set their own world up. */
const freshSlide = () => {
  useStore.setState({
    activeItem: SLIDE, visibleArtifacts: {},
    nucleiLayerParams: {}, tissueLayerParams: {}, markerLayerParams: {},
  });
  useRunsStore.setState({ byId: {}, loaded: false, stopping: {} });
  listRuns.mockResolvedValue([]);
  getArtifactUsage.mockResolvedValue({ bytes: 0, dependants: [] });
};

describe('an opened tissue map', () => {
  beforeEach(() => {
    freshSlide();
    listArtifacts.mockResolvedValue(ROWS);
    getTissueMeta.mockResolvedValue(TISSUE_META);
  });

  const open = async () => {
    render(<WorkspacePanel />);
    await userEvent.click(await screen.findByText('Tissue map'));
    await screen.findByTestId('artifact-config');
  };

  it('reads its composition off the artifact, not off the row that started it', async () => {
    await open();
    expect(screen.getByText('43 tiles · 11.28 mm²')).toBeInTheDocument();
    expect(screen.getByText('0.421')).toBeInTheDocument();          // TSR, as a number
    expect(screen.getByText('50.0%')).toBeInTheDocument();          // Tumour's share
    expect(getTissueMeta).toHaveBeenCalledWith('item-1', 'tis1');
  });

  it('puts the confidence ramp and the H&E fade in the store, where the layer reads them',
    async () => {
      await open();
      expect(screen.getByTestId('heFade-value')).toHaveTextContent('1.00');
      await userEvent.click(screen.getByTestId('artifact-toggle-conf'));
      expect(useStore.getState().tissueLayerParams.conf).toBe(false);
    });

  it('drops the confidence controls in a mode that has no confidence', async () => {
    await open();
    expect(screen.getByTestId('artifact-toggle-conf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Probability' }));
    expect(useStore.getState().tissueLayerParams.render).toBe('probs');
    await waitFor(() =>
      expect(screen.queryByTestId('artifact-toggle-conf')).not.toBeInTheDocument());
  });

  it('hides a class from the map without hiding it from the arithmetic', async () => {
    await open();
    const classRow = screen.getByText('Tumour').closest('[data-cy="data-row"]');
    await userEvent.click(within(classRow).getByRole('button', { name: 'Hide' }));
    expect(useStore.getState().tissueLayerParams.hidden.Tumour).toBe(true);
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('still offers the composition as a file, now that the panel is gone', async () => {
    await open();
    expect(screen.getByTestId('artifact-action-csv')).toBeInTheDocument();
  });
});

describe('an opened marker map', () => {
  beforeEach(() => {
    freshSlide();
    listArtifacts.mockResolvedValue([BIO_ROW, ...ROWS]);
    getBiomarkerMeta.mockResolvedValue(BIO_META);
    getCatalog.mockResolvedValue(CATALOG);
  });

  const open = async () => {
    render(<WorkspacePanel />);
    await userEvent.click(await screen.findByText('Biomarker map'));
    await screen.findByTestId('artifact-config');
  };

  it('lists the channels being composited, from the service\'s own vocabulary', async () => {
    await open();
    await waitFor(() => expect(screen.getByText('CK')).toBeInTheDocument());
    expect(screen.getByText('CD3')).toBeInTheDocument();
    expect(getCatalog).toHaveBeenCalled();
  });

  it('swaps the whole list when the mode changes — the two pictures are exclusive', async () => {
    await open();
    await waitFor(() => expect(screen.getByText('CK')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: 'Phenotype' }));
    expect(useStore.getState().markerLayerParams.mode).toBe('pheno');
    await waitFor(() => expect(screen.getByText('Cytotoxic T')).toBeInTheDocument());
    expect(screen.queryByText('CD3')).not.toBeInTheDocument();
  });

  it('appends a marker the composite does not have, keeping the ones it does', async () => {
    await open();
    await screen.findByText('CK');
    await userEvent.selectOptions(screen.getByLabelText('Add'), 'CD8');
    expect(useStore.getState().markerLayerParams.channels.map((c) => c.marker))
      .toEqual(['CK', 'CD3', 'CD8']);
  });

  it('says on the row that these are predictions, not stains', async () => {
    await open();
    expect(screen.getByText(/not a stain/)).toBeInTheDocument();
  });
});

describe('an opened artifact row', () => {
  beforeEach(() => {
    listArtifacts.mockResolvedValue([NUCLEI_ROW, ...ROWS]);
    getNucleiMeta.mockResolvedValue(NUCLEI_META);
  });

  const openNuclei = async () => {
    render(<WorkspacePanel />);
    await screen.findByText('Nuclei');
    await userEvent.click(screen.getByText('Nuclei'));
    return screen.findByTestId ? null : null;
  };

  it('shows the numbers the artifact stores, read back off disk', async () => {
    await openNuclei();
    expect(await screen.findByText('72 tiles · 19.28 mm²')).toBeInTheDocument();
    expect(screen.getByText('15,180')).toBeInTheDocument();
    expect(getNucleiMeta).toHaveBeenCalledWith('item-1', 'nuc1');
  });

  it('shows one row per class, with its count and its share', async () => {
    await openNuclei();
    await screen.findByText('Connective');
    expect(screen.getByText('10,955 · 72.2%')).toBeInTheDocument();
    // A class the run found none of is not a zero row.
    expect(screen.queryByText('Dead')).not.toBeInTheDocument();
  });

  it('hides a class from the picture without hiding its count', async () => {
    await openNuclei();
    await screen.findByText('Connective');
    const classRow = screen.getByText('Connective').closest('[data-cy="data-row"]');

    await userEvent.click(within(classRow).getByRole('button', { name: 'Hide' }));

    expect(useStore.getState().nucleiLayerParams.hidden).toEqual({ Connective: true });
    // The whole point: the count is still on screen.
    expect(screen.getByText('10,955 · 72.2%')).toBeInTheDocument();
  });

  it('puts the opacity in the store, where the layer can outlive this panel', async () => {
    await openNuclei();
    await screen.findByTestId('artifact-config');
    expect(screen.getByTestId('opacity-value')).toHaveTextContent('0.65');

    // The store is the authority; the panel renders what it holds.
    useStore.getState().setNucleiLayerParams({ opacity: 0.3 });
    await waitFor(() => expect(screen.getByTestId('opacity-value')).toHaveTextContent('0.30'));
  });

  it('offers the two views over the one raster', async () => {
    await openNuclei();
    await screen.findByTestId('artifact-config');
    await userEvent.click(screen.getByRole('tab', { name: 'Each cell' }));
    expect(useStore.getState().nucleiLayerParams.render).toBe('instances');
  });

  it('closes on a second click, so two sliders are never on screen at once', async () => {
    await openNuclei();
    await screen.findByTestId('artifact-config');
    await userEvent.click(screen.getByText('Nuclei'));
    await waitFor(() => expect(screen.queryByTestId('artifact-config')).not.toBeInTheDocument());
  });

  it('does not open a kind that has nothing to draw', async () => {
    // A `features` row is listed — it answers "what has this slide cost me" — but it has no
    // picture, no palette and no controls, so a row that opened onto nothing would be worse than
    // one that does not open. Tissue and biomarker stopped being examples of this in 06.
    render(<WorkspacePanel />);
    await screen.findByText('Features');
    await userEvent.click(screen.getByText('Features'));
    expect(screen.queryByTestId('artifact-detail')).not.toBeInTheDocument();
  });

  it('says so when the artifact has stored nothing yet', async () => {
    getNucleiMeta.mockRejectedValue(new Error('404'));
    await openNuclei();
    expect(await screen.findByText('Nothing stored for this artifact yet.')).toBeInTheDocument();
  });
});

describe('a run with no artifact row yet', () => {
  const SLIDE_WITH_FILE = { ...SLIDE, largeImage: { fileId: 'file-1' } };

  it('still puts something on the list', async () => {
    useStore.setState({ activeItem: SLIDE_WITH_FILE });
    listRuns.mockResolvedValue([{
      id: 'j1', status: 2, created: '2026-08-01T19:48:34Z', lane: 'pathassist',
      slideKey: 'file-1', kind: 'nuclei', artHash: 'ghost1', title: 'Nuclei segmentation',
      started: true, progress: { current: 3, total: 12, message: '3 / 12 · nuclei' },
    }]);
    render(<WorkspacePanel />);

    expect(await screen.findByText('3 / 12 · nuclei')).toBeInTheDocument();
    expect(screen.getByText('Starting…')).toBeInTheDocument();
  });

  it('becomes the real row under the same key once the artifact exists', async () => {
    useStore.setState({ activeItem: SLIDE_WITH_FILE });
    listRuns.mockResolvedValue([{
      id: 'j1', status: 3, created: '2026-08-01T19:48:34Z', lane: 'pathassist',
      slideKey: 'file-1', kind: 'nuclei', artHash: 'nuc1', title: 'Nuclei segmentation',
      started: true, progress: null,
    }]);
    listArtifacts.mockResolvedValue([NUCLEI_ROW]);
    render(<WorkspacePanel />);

    await screen.findByText('Nuclei');
    // One row, not a ghost beside a real one — they share `art_hash`, so they are one row.
    expect(screen.getAllByText('Nuclei')).toHaveLength(1);
    expect(screen.queryByText('Starting…')).not.toBeInTheDocument();
  });
  it('goes and looks for the row when the run that would have written it finishes', async () => {
    // The only signal there is (Inc 6 · 05). Nuclei has no artifact row while it builds, so the
    // list gains its row at the moment a job leaves the unfinished set — and nothing polls the
    // artifact list in the meantime, because from its point of view nothing was ever building.
    useStore.setState({ activeItem: SLIDE_WITH_FILE });
    const run = {
      id: 'j1', created: '2026-08-01T19:48:34Z', lane: 'pathassist', slideKey: 'file-1',
      kind: 'nuclei', artHash: 'nuc1', title: 'Nuclei segmentation', started: true,
    };
    listRuns.mockResolvedValue([{ ...run, status: 2 }]);
    listArtifacts.mockResolvedValue([]);
    render(<WorkspacePanel />);
    await screen.findByText('Starting…');

    listRuns.mockResolvedValue([{ ...run, status: 3 }]);
    listArtifacts.mockResolvedValue([NUCLEI_ROW]);
    await act(async () => { useRunsStore.getState().applyJobEvent({ ...run, status: 3 }); });

    expect(await screen.findByText('Nuclei')).toBeInTheDocument();
    expect(screen.queryByText('Starting…')).not.toBeInTheDocument();
  });
});
