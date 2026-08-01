// The Workspace list (Inc 5 · 02). Two things are worth asserting: that a row says the four things
// §5.2 asks for, read off the artifact table and nothing else, and that a build in flight arrives
// at ready on its own.
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/preprocessApi.js', () => ({ listArtifacts: vi.fn() }));

import WorkspacePanel from './WorkspacePanel.jsx';
import { listArtifacts } from '../../api/preprocessApi.js';
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
