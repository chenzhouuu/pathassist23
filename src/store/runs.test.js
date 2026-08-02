// The one write path for a run row (Inc 6 · 03).
//
// `applyJobEvent` exists so the feed can change without the UI changing (plan D8). These tests
// drive it the way the poller does today and the way `g:event.job_status` will tomorrow — the same
// function, one row at a time.
import { beforeEach, describe, expect, it } from 'vitest';
import { useRunsStore } from './runs.js';
import { STATUS } from '../components/panels/analysis/runsUtils.js';

const RUN = {
  id: 'j1', status: 2, created: '2026-08-01T19:48:34Z', updated: '2026-08-01T19:48:35Z',
  lane: 'pathassist', title: 'Nuclei segmentation', slideKey: 'file-1',
  progress: { current: 1, total: 12, message: '1 / 12 · nuclei' },
};

const reset = () => useRunsStore.setState({ byId: {}, loaded: false, stopping: {} });

beforeEach(reset);

describe('applyJobEvent', () => {
  it('adds a run the store has not seen', () => {
    useRunsStore.getState().applyJobEvent(RUN);
    expect(useRunsStore.getState().byId.j1.title).toBe('Nuclei segmentation');
  });

  it('advances progress in place', () => {
    const { applyJobEvent } = useRunsStore.getState();
    applyJobEvent(RUN);
    applyJobEvent({ ...RUN, progress: { current: 8, total: 12, message: '8 / 12 · nuclei' } });
    expect(useRunsStore.getState().byId.j1.progress.current).toBe(8);
  });

  it('does not churn subscribers when nothing moved', () => {
    // A 2.5 s poll over a queue where nothing is happening must not re-render the panel twice a
    // second, so an identical row is a no-op down to object identity.
    const { applyJobEvent } = useRunsStore.getState();
    applyJobEvent(RUN);
    const before = useRunsStore.getState().byId;
    applyJobEvent({ ...RUN });
    expect(useRunsStore.getState().byId).toBe(before);
  });

  it('notices a status change even when everything else is identical', () => {
    const { applyJobEvent } = useRunsStore.getState();
    applyJobEvent(RUN);
    applyJobEvent({ ...RUN, status: 5 });
    expect(useRunsStore.getState().byId.j1.status).toBe(5);
  });

  it('notices a failure reason arriving on an otherwise unchanged row', () => {
    const { applyJobEvent } = useRunsStore.getState();
    applyJobEvent({ ...RUN, status: 4 });
    applyJobEvent({ ...RUN, status: 4, reason: 'RuntimeError: nuclei failed' });
    expect(useRunsStore.getState().byId.j1.reason).toBe('RuntimeError: nuclei failed');
  });

  it('ignores something that is not a row', () => {
    useRunsStore.getState().applyJobEvent(undefined);
    useRunsStore.getState().applyJobEvent({ status: 2 });
    expect(useRunsStore.getState().byId).toEqual({});
  });
});

describe('syncRuns', () => {
  it('forgets a run the page no longer lists — the one thing an event feed cannot do', () => {
    const { syncRuns } = useRunsStore.getState();
    syncRuns([RUN, { ...RUN, id: 'j2' }]);
    syncRuns([RUN]);
    expect(Object.keys(useRunsStore.getState().byId)).toEqual(['j1']);
  });

  it('separates "no runs" from "not asked yet"', () => {
    expect(useRunsStore.getState().loaded).toBe(false);
    useRunsStore.getState().syncRuns([]);
    expect(useRunsStore.getState().loaded).toBe(true);
  });

  it('applies every row through applyJobEvent', () => {
    useRunsStore.getState().syncRuns([RUN, { ...RUN, id: 'j2', title: 'Tissue map' }]);
    expect(useRunsStore.getState().byId.j2.title).toBe('Tissue map');
  });
});

describe('a Stop that has been sent but not yet acknowledged', () => {
  it('is remembered locally, because CANCELING only arrives on the next poll', () => {
    useRunsStore.getState().markStopping('j1');
    expect(useRunsStore.getState().stopping.j1).toBe(true);
  });

  it('expires with the row it belongs to', () => {
    const { syncRuns, markStopping } = useRunsStore.getState();
    syncRuns([RUN]);
    markStopping('j1');
    syncRuns([]);
    expect(useRunsStore.getState().stopping).toEqual({});
  });
});

describe('the order rows come back in', () => {
  it('is newest first', () => {
    const { syncRuns } = useRunsStore.getState();
    syncRuns([
      { ...RUN, id: 'old', created: '2026-08-01T09:00:00Z' },
      { ...RUN, id: 'new', created: '2026-08-01T11:00:00Z' },
    ]);
    expect(useRunsStore.getState().runs().map(r => r.id)).toEqual(['new', 'old']);
  });
});

describe('the local Stop intent', () => {
  it('ends when the run settles, rather than outliving it', () => {
    // Found running 06 on DEMO: a marker map that had genuinely stopped went on reading
    // "Stopping…" because the intent only expired with the row. The server is the authority once
    // the run is terminal.
    const s = useRunsStore.getState();
    s.applyJobEvent({ id: 'j1', status: STATUS.RUNNING, updated: '1' });
    s.markStopping('j1');
    expect(useRunsStore.getState().stopping.j1).toBe(true);

    s.applyJobEvent({ id: 'j1', status: STATUS.CANCELING, updated: '2', started: true });
    expect(useRunsStore.getState().stopping.j1).toBe(true);   // still stopping — it holds the GPU

    s.applyJobEvent({ id: 'j1', status: STATUS.CANCELED, updated: '3' });
    expect(useRunsStore.getState().stopping.j1).toBeUndefined();
  });

  it("leaves other runs' intents alone", () => {
    const s = useRunsStore.getState();
    s.applyJobEvent({ id: 'a', status: STATUS.RUNNING, updated: '1' });
    s.applyJobEvent({ id: 'b', status: STATUS.RUNNING, updated: '1' });
    s.markStopping('a');
    s.markStopping('b');
    s.applyJobEvent({ id: 'a', status: STATUS.SUCCESS, updated: '2' });
    expect(useRunsStore.getState().stopping).toEqual({ b: true });
  });
});
