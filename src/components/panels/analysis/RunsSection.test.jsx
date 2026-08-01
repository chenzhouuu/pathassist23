// The Runs section (Inc 6 · 03) — the answer to "what is running, and why is mine waiting".
//
// The rows here are the shapes `GET /pathassist/runs` returns on this deployment. What is worth
// asserting is what the section says that a job list does not: which slide a run belongs to, how
// many runs are ahead of a waiting one, and why a failed one failed — without sending the user
// anywhere else to find out.
import React from 'react';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/index.js', () => ({ listRuns: vi.fn(), cancelJob: vi.fn() }));

import RunsSection from './RunsSection.jsx';
import { cancelJob, listRuns } from '../../../api/index.js';
import { useRunsStore } from '../../../store/runs.js';
import { STATUS } from './runsUtils.js';

const FILE = '6a3d59c8d59c30f37fd99be0';
const SLIDE = { _id: '6a6e1ca82ae96ce927e33818', name: 'TCGA-WT-AB44.svs',
  largeImage: { fileId: FILE } };

const run = (over = {}) => ({
  id: 'j1', status: STATUS.RUNNING, created: '2026-08-01T19:48:34Z',
  updated: '2026-08-01T19:48:35Z', lane: 'pathassist', slideKey: FILE,
  itemId: SLIDE._id, slideName: SLIDE.name, title: 'Nuclei segmentation',
  readable: true, mine: true, progress: null, ...over,
});

const render = (item = SLIDE) => rtlRender(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RunsSection activeItem={item} />
  </QueryClientProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  useRunsStore.setState({ byId: {}, loaded: false, stopping: {} });
  listRuns.mockResolvedValue([]);
});

describe('what the list shows', () => {
  it('groups by slide, current slide first', async () => {
    listRuns.mockResolvedValue([
      run({ id: 'here', title: 'Nuclei segmentation' }),
      run({ id: 'there', slideKey: 'other-file', slideName: 'TCGA-ZZ-9999.svs',
        title: 'Tissue map' }),
    ]);
    render();
    await screen.findByText('THIS SLIDE');
    const headings = screen.getAllByText(/THIS SLIDE|OTHER SLIDES/).map(n => n.textContent);
    expect(headings).toEqual(['THIS SLIDE', 'OTHER SLIDES']);
  });

  it('names the slide a run on another slide belongs to — an item id is not an answer', async () => {
    listRuns.mockResolvedValue([
      run({ id: 'there', slideKey: 'other-file', slideName: 'TCGA-ZZ-9999.svs' }),
    ]);
    render();
    expect(await screen.findByText('TCGA-ZZ-9999.svs')).toBeTruthy();
  });

  it('does not repeat the open slide’s own name on every row', async () => {
    listRuns.mockResolvedValue([run()]);
    render();
    await screen.findByText('Nuclei segmentation');
    expect(screen.queryByText('TCGA-WT-AB44.svs')).toBeNull();
  });

  it('counts what is still in flight', async () => {
    listRuns.mockResolvedValue([
      run({ id: '1', status: STATUS.RUNNING }),
      run({ id: '2', status: STATUS.QUEUED }),
      run({ id: '3', status: STATUS.SUCCESS }),
    ]);
    render();
    expect(await screen.findByText('2 active')).toBeTruthy();
  });

  it('separates an empty server from one it has not asked yet', async () => {
    render();
    expect(screen.queryByText(/Nothing has run/)).toBeNull();
    expect(await screen.findByText('Nothing has run on this server yet.')).toBeTruthy();
  });
});

describe('a waiting run says what it is waiting for', () => {
  it('states the number that explains the wait at concurrency=1', async () => {
    listRuns.mockResolvedValue([
      run({ id: 'r', status: STATUS.RUNNING, created: '2026-08-01T10:00:00Z' }),
      run({ id: 'w', status: STATUS.QUEUED, created: '2026-08-01T10:01:00Z',
        title: 'Marker map' }),
    ]);
    render();
    expect(await screen.findByText('Waiting · 1 ahead')).toBeTruthy();
  });

  it('does not count a docker CLI on the other worker as being in the way', async () => {
    listRuns.mockResolvedValue([
      run({ id: 'c', lane: 'girder_worker', status: STATUS.RUNNING,
        created: '2026-08-01T10:00:00Z', title: 'Compute Background Intensity' }),
      run({ id: 'w', status: STATUS.QUEUED, created: '2026-08-01T10:01:00Z' }),
    ]);
    render();
    expect(await screen.findByText('Next in queue')).toBeTruthy();
  });
});

describe('progress', () => {
  it('shows the counts the job carries', async () => {
    listRuns.mockResolvedValue([
      run({ progress: { current: 142, total: 338, message: '142 / 338 · nuclei' } }),
    ]);
    render();
    expect(await screen.findByText('142 / 338 · nuclei')).toBeTruthy();
  });

  it('falls back to a percentage when the job named no counts', async () => {
    listRuns.mockResolvedValue([run({ progress: { current: 42, total: 100 } })]);
    render();
    expect(await screen.findByText('42%')).toBeTruthy();
  });
});

describe('stopping a run', () => {
  it('offers Stop while there is something to stop, and sends the cancel', async () => {
    listRuns.mockResolvedValue([run()]);
    cancelJob.mockResolvedValue({});
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(cancelJob).toHaveBeenCalledWith('j1');
  });

  it('says Stopping… straight away, because CANCELING only arrives on the next poll', async () => {
    listRuns.mockResolvedValue([run()]);
    cancelJob.mockResolvedValue({});
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopping…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('keeps saying Stopping… while the worker finishes the tile it is on', async () => {
    listRuns.mockResolvedValue([run({ status: STATUS.CANCELING })]);
    render();
    expect(await screen.findByText('Stopping…')).toBeTruthy();
  });

  it('does not offer Stop on a run that is over', async () => {
    listRuns.mockResolvedValue([run({ status: STATUS.SUCCESS })]);
    render();
    await screen.findByText('Done');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('says so when the cancel itself is refused, rather than pretending it stopped', async () => {
    listRuns.mockResolvedValue([run()]);
    cancelJob.mockRejectedValue({ response: { data: { message: 'Write access denied.' } } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(/Write access denied\./)).toBeTruthy();
  });
});

describe('a failure', () => {
  it('shows its reason in the row, not a link to it', async () => {
    listRuns.mockResolvedValue([
      run({ status: STATUS.ERROR, reason: 'RuntimeError: nuclei failed: CUDA out of memory' }),
    ]);
    render();
    expect(await screen.findByText(/CUDA out of memory/)).toBeTruthy();
  });
});

describe('runs the caller cannot read', () => {
  it('are counted and named as somebody else’s, so the wait still adds up', async () => {
    listRuns.mockResolvedValue([
      { id: 'other', status: STATUS.RUNNING, created: '2026-08-01T10:00:00Z',
        lane: 'pathassist', readable: false, mine: false, title: 'Another user’s run' },
      run({ id: 'w', status: STATUS.QUEUED, created: '2026-08-01T10:01:00Z' }),
    ]);
    render();
    expect(await screen.findByText('Another user’s run')).toBeTruthy();
    expect(screen.getByText('Waiting · 1 ahead')).toBeTruthy();
  });
});

describe('the poller', () => {
  it('is one query for the whole section, whatever it renders', async () => {
    listRuns.mockResolvedValue([run({ id: 'a' }), run({ id: 'b', slideKey: 'other' })]);
    render();
    await screen.findByText('OTHER SLIDES');
    expect(listRuns).toHaveBeenCalledTimes(1);
  });

  it('feeds every row through the store, so a row survives its own re-render', async () => {
    listRuns.mockResolvedValue([run()]);
    render();
    await screen.findByText('Nuclei segmentation');
    expect(useRunsStore.getState().byId.j1.title).toBe('Nuclei segmentation');
  });

  it('drops a run the page stopped listing', async () => {
    listRuns.mockResolvedValue([run(), run({ id: 'j2', title: 'Tissue map' })]);
    const { rerender } = render();
    await screen.findByText('Tissue map');

    listRuns.mockResolvedValue([run()]);
    useRunsStore.getState().syncRuns([run()]);
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RunsSection activeItem={SLIDE} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText('Tissue map')).toBeNull());
  });

  it('says when it cannot read the list at all', async () => {
    listRuns.mockRejectedValue(new Error('Network Error'));
    render();
    // The section retries once before it says so — a single dropped poll is not an outage.
    expect(await screen.findByText(/Could not read the run list: Network Error/, {},
      { timeout: 5000 })).toBeTruthy();
  });
});

describe('grouping across the copyOfItem gap', () => {
  it('puts a docker CLI beside the native run on the same slide', async () => {
    // Measured: the CLI resolves back through the shared image file to the *original* item, so the
    // two rows carry different itemIds and the same slideKey. Grouping on the item would split
    // one slide in two.
    listRuns.mockResolvedValue([
      run({ id: 'native', itemId: SLIDE._id, slideKey: FILE }),
      run({ id: 'cli', itemId: '6a3d59c8d59c30f37fd99bdf', slideKey: FILE,
        lane: 'girder_worker', title: 'Compute Background Intensity' }),
    ]);
    const { container } = render();
    await screen.findByText('THIS SLIDE');
    expect(screen.queryByText('OTHER SLIDES')).toBeNull();
    expect(container.querySelectorAll('[data-cy="run-row"]')).toHaveLength(2);
  });
});
