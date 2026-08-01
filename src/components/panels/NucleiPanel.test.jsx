// Starting a nuclei build (Inc 5 · 05-08; Inc 6 · 04).
//
// Seven tests left this file when the stored counts and the mask's controls moved into the
// artifact's own row in the Workspace. They were not dropped: what they asserted is now asserted
// where it lives — `workspace/artifactDetail.test.js` for the numbers, the class rows, the palette
// and the render modes, and `WorkspacePanel.test.jsx` for the eye that hides a class without
// hiding its count and for the opacity reaching the store.
//
// What is left is the claim this panel still makes: a build starts, stops and resumes, and it says
// what the artifact table says about it.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/preprocessApi.js', () => ({ listArtifacts: vi.fn() }));
vi.mock('../../api/nucleiApi.js', () => ({ startNuclei: vi.fn(), cancelNuclei: vi.fn() }));

import NucleiPanel from './NucleiPanel.jsx';
import { listArtifacts } from '../../api/preprocessApi.js';
import { cancelNuclei, startNuclei } from '../../api/nucleiApi.js';
import { useStore } from '../../store/index.js';

const SLIDE = { _id: 'item-1', name: 'slide.svs' };
const ROI = { x: 100, y: 200, width: 512, height: 512 };

const READY_ROW = { kind: 'nuclei', art_hash: 'n1', status: 'ready', params: {}, result: {} };
const SEG_ROW = { kind: 'segmentation', art_hash: 's1', status: 'ready', params: {} };

describe('NucleiPanel', () => {
  beforeEach(() => {
    useStore.setState({
      activeItem: SLIDE, copilotRoi: null, nucleiLayerParams: {}, visibleArtifacts: {},
    });
    listArtifacts.mockResolvedValue([]);
    startNuclei.mockResolvedValue({ kind: 'nuclei', art_hash: 'n1', status: 'queued' });
    cancelNuclei.mockResolvedValue({ status: 'running', stage: 'stopping' });
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
    await waitFor(() => expect(startNuclei)
      .toHaveBeenCalledWith('item-1', { bbox: ROI, seg_hash: null }));
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
  });

  it('will not run the whole slide without a segmentation, and says why', async () => {
    render(<NucleiPanel />);
    const whole = await screen.findByRole('button', { name: /Run on whole slide/ });
    expect(whole).toBeDisabled();
    expect(whole).toHaveAttribute('title', expect.stringContaining('Segment the slide first'));
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
    render(<NucleiPanel />);

    expect(await screen.findByText('Working 0%')).toBeInTheDocument();
    expect(screen.queryByText(/nuclei ·/)).not.toBeInTheDocument();
  });

  // ── whole slide, stop, resume (Inc 5 · 07) ───────────────────────────────────────

  it('runs the whole slide once the tissue is segmented', async () => {
    listArtifacts.mockResolvedValue([SEG_ROW]);
    render(<NucleiPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /Run on whole slide/ }));
    // bbox null is the whole slide; seg_hash is how the worker knows where the tissue is.
    await waitFor(() => expect(startNuclei)
      .toHaveBeenCalledWith('item-1', { bbox: null, seg_hash: 's1' }));
  });

  it('offers no Stop for a build that is not running', async () => {
    listArtifacts.mockResolvedValue([SEG_ROW, READY_ROW]);
    render(<NucleiPanel />);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument();
  });

  it('stops a running build', async () => {
    listArtifacts.mockResolvedValue([
      SEG_ROW, { ...READY_ROW, status: 'running', stage: 'nuclei', progress: 0.2, job_id: 'j9' },
    ]);
    render(<NucleiPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(cancelNuclei).toHaveBeenCalledWith('item-1', 'n1');
  });

  it('says it is stopping while the worker finishes its tile', async () => {
    listArtifacts.mockResolvedValue([
      SEG_ROW,
      { ...READY_ROW, status: 'running', stage: 'stopping', progress: 0.2, job_id: 'j9' },
    ]);
    render(<NucleiPanel />);

    expect(await screen.findByText('Stopping — finishing the current tile')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('offers to resume a stopped build, and says what it already holds', async () => {
    listArtifacts.mockResolvedValue([SEG_ROW, {
      ...READY_ROW, status: 'cancelled', stage: 'stopped', progress: 0.4,
      result: { n_nuclei: 4120, remaining: 37 },
    }]);
    render(<NucleiPanel />);

    expect(await screen.findByText('Stopped — 4,120 nuclei, 37 tiles left')).toBeInTheDocument();
    // The same call as starting it: coverage is what makes resuming free.
    await userEvent.click(await screen.findByRole('button', { name: /Resume whole slide/ }));
    await waitFor(() => expect(startNuclei)
      .toHaveBeenCalledWith('item-1', { bbox: null, seg_hash: 's1' }));
  });

  it('tells the layer a build is running, so the mask can catch up on its own', async () => {
    listArtifacts.mockResolvedValue([
      SEG_ROW, { ...READY_ROW, status: 'running', progress: 0.2, job_id: 'j9' },
    ]);
    render(<NucleiPanel />);

    await waitFor(() => expect(useStore.getState().artifactRuns).toEqual({ n1: true }));
  });

  it("shows a full cache as the worker's own refusal", async () => {
    listArtifacts.mockResolvedValue([SEG_ROW]);
    startNuclei.mockRejectedValue(new Error('only 0.5 GB free on the nuclei cache'));
    render(<NucleiPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /Run on whole slide/ }));
    expect(await screen.findByText(/0.5 GB free/)).toBeInTheDocument();
  });
});
