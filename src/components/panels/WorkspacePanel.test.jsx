// The Workspace list (Inc 5 · 02). Two things are worth asserting: that a row says the four things
// §5.2 asks for, read off the artifact table and nothing else, and that a build in flight arrives
// at ready on its own.
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/preprocessApi.js', () => ({
  listArtifacts: vi.fn(),
  getArtifactUsage: vi.fn(),
  deleteArtifact: vi.fn(),
}));

import WorkspacePanel from './WorkspacePanel.jsx';
import { deleteArtifact, getArtifactUsage, listArtifacts } from '../../api/preprocessApi.js';
import { useStore } from '../../store/index.js';

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
    useStore.setState({ activeItem: SLIDE, visibleArtifacts: {} });
    listArtifacts.mockResolvedValue([]);
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
