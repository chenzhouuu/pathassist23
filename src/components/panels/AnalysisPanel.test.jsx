// The one algorithm catalog (Inc 6 · 02). What is worth asserting is the consolidation itself:
// that every tool is one list under one search box, that a form is built from its declaration,
// and that submitting returns to the list — the `running` view this ticket deletes was a modal
// state a page reload lost.
//
// It used to be two sources: these tests also pinned the docker CLI half, which read a Slicer XML
// into the same shape and posted to `/slicer_cli_web/.../run`. That went on 2026-08-03 — see
// docs/docker-cli-technical-report.md — and with it the assertions about a mixed list.
import React from 'react';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/index.js', () => ({
  listRuns: vi.fn(),
  cancelJob: vi.fn(),
}));
vi.mock('../../api/preprocessApi.js', () => ({
  listArtifacts: vi.fn(),
  startSegment: vi.fn(),
}));
vi.mock('../../api/nucleiApi.js', () => ({ startNuclei: vi.fn() }));
vi.mock('../../api/tissueApi.js', () => ({ startTissue: vi.fn(), getTissueCatalog: vi.fn() }));
vi.mock('../../api/biomarkerApi.js', () => ({ startBiomarker: vi.fn() }));
vi.mock('../../api/taskApi.js', () => ({ startPredict: vi.fn(), listTasks: vi.fn() }));

import AnalysisPanel from './AnalysisPanel.jsx';
import { listRuns } from '../../api/index.js';
import { listArtifacts, startSegment } from '../../api/preprocessApi.js';
import { startNuclei } from '../../api/nucleiApi.js';
import { useStore } from '../../store/index.js';

const SLIDE = {
  _id: '6a6e1ca82ae96ce927e33818', name: 'TCGA-WT-AB44.svs', folderId: 'f1',
  largeImage: { fileId: '6a3d59c8d59c30f37fd99be0', sourceName: 'openslide' },
};
const ROI = { x: 7000, y: 7000, width: 4096, height: 4096 };

const render = () => rtlRender(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AnalysisPanel />
  </QueryClientProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    activeItem: SLIDE, drawingMode: null, roiSelectResult: null,
    copilotRoi: null, shownRoi: null, viewer: null,
  });
  listRuns.mockResolvedValue([]);
  listArtifacts.mockResolvedValue([]);
});

describe('one list', () => {
  it('shows every native tool under its own group heading', async () => {
    render();
    // By title, not by text: the group name is both a heading and an option in the Source select.
    expect(await screen.findByTitle('PathAssist')).toBeTruthy();
    ['Tissue segmentation', 'Nuclei segmentation', 'Tissue map', 'Marker map', 'Downstream task']
      .forEach(t => expect(screen.getByText(t)).toBeTruthy());
  });

  it('counts them', async () => {
    render();
    expect(await screen.findByText('7 / 7 algorithms')).toBeTruthy();
  });

  it('searches with the one box', async () => {
    render();
    await screen.findByText('Nuclei segmentation');
    await userEvent.type(screen.getByPlaceholderText('Filter algorithms...'), 'nuclei');
    expect(screen.getByText('Nuclei segmentation')).toBeTruthy();
    expect(screen.queryByText('Marker map')).toBeNull();
  });

  it('filters to the one source', async () => {
    render();
    await screen.findByText('Nuclei segmentation');
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'PathAssist');
    expect(screen.getByText('Nuclei segmentation')).toBeTruthy();
  });
});

describe('a form is built from the declaration', () => {
  it('renders the declared fields', async () => {
    render();
    await userEvent.click(await screen.findByText('Tissue segmentation'));
    expect(await screen.findByText('Segmenter')).toBeTruthy();
    expect(screen.getByText('Confidence threshold')).toBeTruthy();
    expect(screen.getByText('Remove pen marks')).toBeTruthy();
  });

  it('submits the declared values to the tool\'s own endpoint and returns to the list', async () => {
    render();
    await userEvent.click(await screen.findByText('Tissue segmentation'));
    await screen.findByText('Segmenter');
    await userEvent.click(screen.getByRole('button', { name: /run job/i }));

    await waitFor(() => expect(startSegment.mock.calls.some(
      ([id, body, mode]) => id === SLIDE._id && mode === undefined
        && body.segmenter === 'hest' && body.seg_conf_thresh === 0.5,
    )).toBe(true));
    // Back on the list — no `running` view to be stranded in.
    expect(await screen.findByPlaceholderText('Filter algorithms...')).toBeTruthy();
    expect(screen.getByText(/Tissue segmentation submitted/)).toBeTruthy();
  });

  it('refuses a region run with no region drawn, and says which', async () => {
    render();
    await userEvent.click(await screen.findByText('Nuclei segmentation'));
    await screen.findByText('Run over');
    expect(screen.getByText(/draw a region/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /run job/i }).disabled).toBe(true);
    expect(startNuclei).not.toHaveBeenCalled();
  });

  it('sends the shared region once one is drawn', async () => {
    useStore.setState({ copilotRoi: ROI });
    render();
    await userEvent.click(await screen.findByText('Nuclei segmentation'));
    await screen.findByText('Run over');
    await userEvent.click(screen.getByRole('button', { name: /run job/i }));
    await waitFor(() => expect(startNuclei.mock.calls.some(
      ([id, body, mode]) => id === SLIDE._id && mode === undefined
        && body.bbox === ROI && body.seg_hash === null,
    )).toBe(true));
  });

  it('plans the missing upstream instead of refusing over it (Inc 6 · 08)', async () => {
    // It used to say "this slide has no segmentation yet — run it first" and disable Run. True,
    // and a piece of work the machine could do, so the server plans it and the form states the
    // cost instead.
    startNuclei.mockResolvedValue({
      status: 'planned',
      steps: [{ kind: 'segmentation', title: 'Tissue segmentation', art_hash: 's' },
              { kind: 'nuclei', title: 'Nuclei segmentation', art_hash: 'n' }],
    });
    render();
    await userEvent.click(await screen.findByText('Nuclei segmentation'));
    await screen.findByText('Run over');
    await userEvent.click(screen.getByRole('radio', { name: 'Whole slide' }));

    const plan = await screen.findByTestId('submission-plan');
    expect(plan.textContent).toMatch(/2 steps · 2 queue slots/);
    expect(plan.textContent).toMatch(/1\. Tissue segmentation/);
    expect(screen.getByTestId('run-all').disabled).toBe(false);
  });

  it('offers running only the first step, and neither button is the default', async () => {
    startNuclei.mockResolvedValue({
      status: 'planned',
      steps: [{ kind: 'segmentation', title: 'Tissue segmentation', art_hash: 's' },
              { kind: 'nuclei', title: 'Nuclei segmentation', art_hash: 'n' }],
    });
    render();
    await userEvent.click(await screen.findByText('Nuclei segmentation'));
    await screen.findByText('Run over');
    await userEvent.click(screen.getByRole('radio', { name: 'Whole slide' }));
    await screen.findByTestId('submission-plan');

    expect(screen.getByTestId('run-all').textContent).toMatch(/run everything/i);
    await userEvent.click(screen.getByTestId('run-next'));
    await waitFor(() => expect(startNuclei.mock.calls.some(c => c[2] === 'next')).toBe(true));
  });

  it('says so when there is nothing left to run', async () => {
    startNuclei.mockResolvedValue({ status: 'ready', steps: [], reused: true });
    render();
    await userEvent.click(await screen.findByText('Nuclei segmentation'));
    await screen.findByText('Run over');
    await userEvent.click(screen.getByRole('radio', { name: 'Whole slide' }));
    expect((await screen.findByTestId('submission-plan')).textContent)
      .toMatch(/already built/i);
  });

  it('offers the slide\'s ready segmentations to a whole-slide run', async () => {
    listArtifacts.mockResolvedValue([
      { kind: 'segmentation', art_hash: 'abcdef0123', status: 'ready', n_items: 434,
        created_at: '2026-08-01T10:00:00Z' },
      { kind: 'segmentation', art_hash: 'still-going', status: 'running' },
    ]);
    render();
    await userEvent.click(await screen.findByText('Nuclei segmentation'));
    await screen.findByText('Run over');
    await userEvent.click(screen.getByRole('radio', { name: 'Whole slide' }));

    const select = await screen.findByRole('combobox');
    // Only the ready one is offered — a half-built segmentation cannot bound a run.
    const options = within(select).getAllByRole('option').map(o => o.textContent);
    expect(options.some(o => o.includes('abcdef01'))).toBe(true);
    expect(options.some(o => o.includes('still-going'))).toBe(false);

    await userEvent.selectOptions(select, 'abcdef0123');
    await userEvent.click(screen.getByTestId('run-all'));
    await waitFor(() => expect(startNuclei.mock.calls.some(
      ([id, body, mode]) => id === SLIDE._id && mode === undefined
        && body.bbox === null && body.seg_hash === 'abcdef0123',
    )).toBe(true));
  });
});

describe('a submission with nothing left to run', () => {
  it('says it was already built rather than claiming it queued something', async () => {
    // Content addressing makes the second identical build a no-op, and the server answers
    // `status: 'ready', steps: []`. "Submitted" would send someone to an empty Runs list.
    startSegment.mockResolvedValue({ kind: 'segmentation', art_hash: 's1',
      status: 'ready', steps: [], reused: true });
    render();
    await userEvent.click(await screen.findByText('Tissue segmentation'));
    await screen.findByText('Segmenter');
    await userEvent.click(screen.getByRole('button', { name: /run job/i }));
    expect(await screen.findByText(/already built, nothing to run/)).toBeTruthy();
  });

  it('says submitted when steps were actually queued', async () => {
    startSegment.mockResolvedValue({ kind: 'segmentation', art_hash: 's1', status: 'queued',
      steps: [{ kind: 'segmentation', art_hash: 's1' }] });
    render();
    await userEvent.click(await screen.findByText('Tissue segmentation'));
    await screen.findByText('Segmenter');
    await userEvent.click(screen.getByRole('button', { name: /run job/i }));
    expect(await screen.findByText(/Tissue segmentation submitted/)).toBeTruthy();
  });
});
