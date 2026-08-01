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
// The panel shares the Analysis poller's query key (Inc 6 · 04), so the runs feed has to answer
// here too — the list is artifacts *union* the runs in flight for this slide.
vi.mock('../../api/index.js', () => ({ listRuns: vi.fn(), cancelJob: vi.fn() }));

import WorkspacePanel from './WorkspacePanel.jsx';
import { deleteArtifact, getArtifactUsage, listArtifacts } from '../../api/preprocessApi.js';
import { getNucleiMeta } from '../../api/nucleiApi.js';
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
    useStore.setState({ activeItem: SLIDE, visibleArtifacts: {}, nucleiLayerParams: {} });
    useRunsStore.setState({ byId: {}, loaded: false, stopping: {} });
    listArtifacts.mockResolvedValue([]);
    listRuns.mockResolvedValue([]);
    getNucleiMeta.mockResolvedValue(null);
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

  it('carries a running build to ready without a manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = [{
      kind: 'tissue', art_hash: 'tis1', status: 'running', stage: 'tiles', progress: 0.42,
      params: { backend: 'hover-next' }, result: {}, created_at: iso(10_000),
    }];
    listArtifacts.mockResolvedValue(running);
    render(<WorkspacePanel />);
    expect(await screen.findByText(/42%/)).toBeInTheDocument();

    listArtifacts.mockResolvedValue([{ ...running[0], status: 'ready', progress: 1, result: { n_core_tiles: 12 } }]);
    await vi.advanceTimersByTimeAsync(2600);
    await waitFor(() => expect(screen.getByText('12 tiles')).toBeInTheDocument());
    expect(screen.queryByText(/42%/)).not.toBeInTheDocument();
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

  it('does not open a kind whose controls have not moved across yet', async () => {
    render(<WorkspacePanel />);
    await screen.findByText('Tissue map');
    await userEvent.click(screen.getByText('Tissue map'));
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
