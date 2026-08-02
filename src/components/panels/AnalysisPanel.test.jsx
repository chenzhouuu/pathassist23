// The one algorithm catalog (Inc 6 · 02). What is worth asserting is the consolidation itself:
// that the docker CLIs and the native tools are one list under one search box, that a native form
// is built from its declaration rather than from XML, and that submitting returns to the list —
// the `running` view this ticket deletes was a modal state a page reload lost.
import React from 'react';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/index.js', () => ({
  getDockerImages: vi.fn(),
  getCliXmlByPath: vi.fn(),
  runCliByPath: vi.fn(),
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
import { getCliXmlByPath, getDockerImages, listRuns, runCliByPath } from '../../api/index.js';
import { listArtifacts, startSegment } from '../../api/preprocessApi.js';
import { startNuclei } from '../../api/nucleiApi.js';
import { useStore } from '../../store/index.js';

const SLIDE = {
  _id: '6a6e1ca82ae96ce927e33818', name: 'TCGA-WT-AB44.svs', folderId: 'f1',
  largeImage: { fileId: '6a3d59c8d59c30f37fd99be0', sourceName: 'openslide' },
};
const ROI = { x: 7000, y: 7000, width: 4096, height: 4096 };

// One docker image with one CLI — enough to prove the two sources share the list and the filter.
const IMAGES = {
  'dsarchive/histomicstk:latest': {
    latest: {
      NucleiDetection: { xmlspec: '/slicer/1/xml', run: '/slicer/1/run', title: 'Nuclei Detection' },
    },
  },
};

const XML = `<?xml version="1.0"?><executable>
  <title>Nuclei Detection</title><description>Detect nuclei.</description>
  <parameters><label>IO</label>
    <image><name>inputImageFile</name><label>Input</label><channel>input</channel></image>
    <double><name>foreground_threshold</name><label>Foreground threshold</label><default>60</default></double>
  </parameters></executable>`;

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
  getDockerImages.mockResolvedValue(IMAGES);
  listRuns.mockResolvedValue([]);
  getCliXmlByPath.mockResolvedValue(XML);
  listArtifacts.mockResolvedValue([]);
});

describe('one list, two sources', () => {
  it('shows the native tools and the docker CLIs under their own group headings', async () => {
    render();
    await screen.findByText('Nuclei Detection');            // the CLI
    // By title, not by text: each group name is both a heading and an option in the Source select.
    expect(screen.getByTitle('PathAssist')).toBeTruthy();
    expect(screen.getByTitle('dsarchive/histomicstk:latest')).toBeTruthy();
    // All five native tools are there, not just the one being demonstrated.
    ['Tissue segmentation', 'Nuclei segmentation', 'Tissue map', 'Marker map', 'Downstream task']
      .forEach(t => expect(screen.getByText(t)).toBeTruthy());
  });

  it('counts both sources together', async () => {
    render();
    await screen.findByText('Nuclei Detection');
    expect(screen.getByText('7 / 7 algorithms')).toBeTruthy();
  });

  it('searches across both sources with the one box', async () => {
    render();
    await screen.findByText('Nuclei Detection');
    await userEvent.type(screen.getByPlaceholderText('Filter algorithms...'), 'nuclei');
    // "Nuclei segmentation" (native) and "Nuclei Detection" (CLI) both match.
    expect(screen.getByText('Nuclei segmentation')).toBeTruthy();
    expect(screen.getByText('Nuclei Detection')).toBeTruthy();
    expect(screen.queryByText('Marker map')).toBeNull();
  });

  it('filters to one source, native included', async () => {
    render();
    await screen.findByText('Nuclei Detection');
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'PathAssist');
    expect(screen.getByText('Nuclei segmentation')).toBeTruthy();
    expect(screen.queryByText('Nuclei Detection')).toBeNull();
  });

  it('still lists the native tools when no docker image is available at all', async () => {
    getDockerImages.mockResolvedValue({});
    render();
    expect(await screen.findByText('Nuclei segmentation')).toBeTruthy();
  });
});

describe('a native form is built from the declaration', () => {
  it('renders the declared fields, not an XML-derived one', async () => {
    render();
    await userEvent.click(await screen.findByText('Tissue segmentation'));
    expect(await screen.findByText('Segmenter')).toBeTruthy();
    expect(screen.getByText('Confidence threshold')).toBeTruthy();
    expect(screen.getByText('Remove pen marks')).toBeTruthy();
    expect(getCliXmlByPath).not.toHaveBeenCalled();
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

describe('the CLI path is what it was', () => {
  it('still fetches the XML, auto-fills the slide, and posts to the CLI run route', async () => {
    runCliByPath.mockResolvedValue({ _id: 'job-1' });
    render();
    await userEvent.click(await screen.findByText('Nuclei Detection'));
    await screen.findByText('Foreground threshold');

    await userEvent.click(screen.getByRole('button', { name: /run job/i }));
    await waitFor(() => expect(runCliByPath).toHaveBeenCalled());
    const [path, params] = runCliByPath.mock.calls[0];
    expect(path).toBe('/slicer/1/run');
    // The large_image FILE id, not the item id — slicer_cli_web's own selector resolves an item
    // that way, and sending the item id is what made every image-input CLI answer 400.
    expect(params.inputImageFile).toBe(SLIDE.largeImage.fileId);
    expect(params.foreground_threshold).toBe('60');       // default carried through
    expect(params.girderApiUrl).toBeTruthy();

    // And it too lands back on the list rather than a running view.
    expect(await screen.findByPlaceholderText('Filter algorithms...')).toBeTruthy();
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
