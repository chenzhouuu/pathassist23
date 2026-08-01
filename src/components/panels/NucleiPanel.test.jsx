// The Nuclei panel (Inc 5 · 05). The claim is that the numbers on screen came off disk: the panel
// reports the stored artifact's meta, not whatever the call that started the build returned.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/preprocessApi.js', () => ({ listArtifacts: vi.fn() }));
vi.mock('../../api/nucleiApi.js', () => ({ startNuclei: vi.fn(), getNucleiMeta: vi.fn() }));

import NucleiPanel from './NucleiPanel.jsx';
import { listArtifacts } from '../../api/preprocessApi.js';
import { getNucleiMeta, startNuclei } from '../../api/nucleiApi.js';
import { useStore } from '../../store/index.js';

const SLIDE = { _id: 'item-1', name: 'slide.svs' };
const ROI = { x: 100, y: 200, width: 512, height: 512 };

const READY_ROW = { kind: 'nuclei', art_hash: 'n1', status: 'ready', params: {}, result: {} };
const META = {
  art_hash: 'n1',
  slide: { width: 4096, height: 4096, mpp: 0.25 },
  summary: {
    n_nuclei: 1200, n_tiles: 3, area_mm2: 12.582,
    counts_by_class: { Neoplastic: 800, Connective: 300, Inflammatory: 100 },
  },
};

describe('NucleiPanel', () => {
  beforeEach(() => {
    useStore.setState({ activeItem: SLIDE, copilotRoi: null });
    listArtifacts.mockResolvedValue([]);
    getNucleiMeta.mockResolvedValue(META);
    startNuclei.mockResolvedValue({ kind: 'nuclei', art_hash: 'n1', status: 'queued' });
  });

  it('asks for a slide first', () => {
    useStore.setState({ activeItem: null });
    render(<NucleiPanel />);
    expect(screen.getByText(/Open a slide/)).toBeInTheDocument();
  });

  it('will not run without a region, and says why', async () => {
    render(<NucleiPanel />);
    const run = await screen.findByRole('button', { name: /Run on region/ });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringContaining('Draw a region first'));
  });

  it('runs on the drawn region', async () => {
    useStore.setState({ copilotRoi: ROI });
    render(<NucleiPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /Run on region/ }));
    await waitFor(() => expect(startNuclei).toHaveBeenCalledWith('item-1', { bbox: ROI }));
  });

  it('reports the stored counts, read back from the artifact', async () => {
    listArtifacts.mockResolvedValue([READY_ROW]);
    render(<NucleiPanel />);

    expect(await screen.findByText('1,200 nuclei · 12.58 mm² · 3 tiles')).toBeInTheDocument();
    expect(getNucleiMeta).toHaveBeenCalledWith('item-1', 'n1');
    expect(screen.getByText('Neoplastic')).toBeInTheDocument();
    expect(screen.getByText('800 · 66.7%')).toBeInTheDocument();
    expect(screen.getByText('12.58 mm²')).toBeInTheDocument();
  });

  it('shows progress while a build is running', async () => {
    listArtifacts.mockResolvedValue([
      { ...READY_ROW, status: 'running', progress: 0.42 },
    ]);
    render(<NucleiPanel />);
    expect(await screen.findByText('Working 42%')).toBeInTheDocument();
  });

  it('says a build is not built before there is one', async () => {
    render(<NucleiPanel />);
    expect(await screen.findByText('Not built')).toBeInTheDocument();
    expect(getNucleiMeta).not.toHaveBeenCalled();
  });

  it('says whole-slide is not available yet rather than offering a button that refuses', async () => {
    render(<NucleiPanel />);
    expect(await screen.findByText(/Whole-slide runs are not built yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /whole slide/i })).not.toBeInTheDocument();
  });

  it('shows the reason when a run is refused', async () => {
    useStore.setState({ copilotRoi: ROI });
    startNuclei.mockRejectedValue(new Error('the nuclei worker has no segmentation weights'));
    render(<NucleiPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /Run on region/ }));
    expect(await screen.findByText(/no segmentation weights/)).toBeInTheDocument();
  });

  it('keeps working when the artifact has a row but nothing stored yet', async () => {
    listArtifacts.mockResolvedValue([{ ...READY_ROW, status: 'queued' }]);
    getNucleiMeta.mockRejectedValue(new Error('404'));
    render(<NucleiPanel />);

    expect(await screen.findByText('Working 0%')).toBeInTheDocument();
    expect(screen.queryByText(/nuclei ·/)).not.toBeInTheDocument();
  });
});
