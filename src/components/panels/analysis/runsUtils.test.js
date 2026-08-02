// What a run row says (Inc 6 · 03).
//
// The rows below are shapes `GET /pathassist/runs` really returns — captured from this deployment
// on 2026-08-01, including the one that made grouping non-trivial: a docker CLI and a native run
// on the same slide name two different items, because the DEMO slide is a `copyOfItem` and the
// CLI resolves back through the shared image file to the original.
import { describe, expect, it } from 'vitest';
import {
  STATUS, activeCount, aheadOf, chainGroups, chainStatus, groupRuns, isCancelable, isDropped,
  isStopping, progressFraction, progressText, queueNote, slideKeyOf, statusLabel,
  THIS_SLIDE, OTHER_SLIDES,
} from './runsUtils.js';

const FILE = '6a3d59c8d59c30f37fd99be0';       // the DEMO slide's largeImage.fileId
const COPY = '6a6e1ca82ae96ce927e33818';       // the item the user opens
const ORIGIN = '6a3d59c8d59c30f37fd99bdf';     // the item that owns the file

const run = (over = {}) => ({
  id: 'a', status: STATUS.RUNNING, created: '2026-08-01T19:48:34.110000+00:00',
  lane: 'pathassist', slideKey: FILE, itemId: COPY, slideName: 'TCGA-WT-AB44.svs',
  title: 'Nuclei segmentation', readable: true, mine: true, progress: null, started: true, ...over,
});

describe('the progress line', () => {
  it('says the counts the job carries, which the driver already composed', () => {
    const r = run({ progress: { current: 142, total: 338, message: '142 / 338 · nuclei' } });
    expect(progressText(r)).toBe('142 / 338 · nuclei');
    expect(progressFraction(r)).toBeCloseTo(142 / 338);
  });

  it('never recomputes a message that exists, so the row and the job cannot disagree', () => {
    // A service that rounded its fraction at the source and its counts a moment later. The row
    // repeats one of them rather than inventing a third number.
    const r = run({ progress: { current: 5, total: 10, message: '5 / 10 · tiles' } });
    expect(progressText(r)).toBe('5 / 10 · tiles');
  });

  it('falls back to a percentage when the job reported a total and no words for it', () => {
    expect(progressText(run({ progress: { current: 42, total: 100 } }))).toBe('42%');
  });

  it('has nothing to say about a docker CLI, which reports no progress at all', () => {
    expect(progressText(run({ progress: null }))).toBeNull();
    expect(progressFraction(run({ progress: null }))).toBeNull();
  });

  it('draws no bar for an indeterminate total rather than a full one', () => {
    expect(progressFraction(run({ progress: { current: 3, total: 0 } }))).toBeNull();
  });
});

describe('what is ahead of a waiting run', () => {
  const running = run({ id: 'r', status: STATUS.RUNNING, created: '2026-08-01T10:00:00Z' });
  const waiting1 = run({ id: 'w1', status: STATUS.QUEUED, created: '2026-08-01T10:01:00Z' });
  const waiting2 = run({ id: 'w2', status: STATUS.QUEUED, created: '2026-08-01T10:02:00Z' });

  it('counts the run holding the worker, because that is the wait', () => {
    expect(aheadOf(waiting1, [running, waiting1, waiting2])).toBe(1);
    expect(queueNote(waiting1, [running, waiting1, waiting2])).toBe('Waiting · 1 ahead');
  });

  it('counts the queue in front of it too', () => {
    expect(queueNote(waiting2, [running, waiting1, waiting2])).toBe('Waiting · 2 ahead');
  });

  it('says so plainly when nothing is in the way', () => {
    expect(queueNote(waiting1, [waiting1])).toBe('Next in queue');
  });

  it('does not count a docker CLI on the other worker', () => {
    const cli = run({ id: 'c', lane: 'girder_worker', status: STATUS.RUNNING,
      created: '2026-08-01T09:00:00Z' });
    expect(aheadOf(waiting1, [cli, waiting1])).toBe(0);
  });

  it('counts a stopping run, which has not let go of the GPU yet', () => {
    const canceling = run({ id: 's', status: STATUS.CANCELING, created: '2026-08-01T09:00:00Z' });
    expect(aheadOf(waiting1, [canceling, waiting1])).toBe(1);
  });

  it('does not count runs that already finished', () => {
    const done = run({ id: 'd', status: STATUS.SUCCESS, created: '2026-08-01T09:00:00Z' });
    const failed = run({ id: 'f', status: STATUS.ERROR, created: '2026-08-01T09:00:00Z' });
    expect(aheadOf(waiting1, [done, failed, waiting1])).toBe(0);
  });

  it('says nothing on a row that is not waiting', () => {
    expect(queueNote(running, [running, waiting1])).toBeNull();
  });
});

describe('whether Stop is offered', () => {
  // girder_plugin_worker/web_client/JobStatus.js:41 — everything not settled and not already
  // stopping. Both families in this list are celery-handled, so its handler test is always true.
  it('offers it while there is something to stop', () => {
    [STATUS.INACTIVE, STATUS.QUEUED, STATUS.RUNNING, STATUS.PUSHING_OUTPUT]
      .forEach(status => expect(isCancelable(run({ status }))).toBe(true));
  });

  it('withdraws it once the run is settled, or already stopping', () => {
    [STATUS.SUCCESS, STATUS.ERROR, STATUS.CANCELED, STATUS.CANCELING]
      .forEach(status => expect(isCancelable(run({ status }))).toBe(false));
  });

  it('reads Stopping… while the worker finishes what it is on', () => {
    expect(isStopping(run({ status: STATUS.CANCELING }))).toBe(true);
    expect(statusLabel(run({ status: STATUS.CANCELING }))).toBe('Stopping…');
  });

  it('calls a stopped run stopped rather than failed', () => {
    expect(statusLabel(run({ status: STATUS.CANCELED }))).toBe('Stopped');
  });
});

describe('cancelling a run that never started', () => {
  // Measured 2026-08-01: `PUT /job/{id}/cancel` on a *queued* run puts it at 824 and leaves it
  // there, because celery holds the revoked message in the worker's prefetch buffer and only
  // discovers the revocation when it tries to execute it — after the run ahead finishes. Calling
  // that "Stopping…" for twenty minutes is the wrong word for a run with nothing to stop.
  const dropped = run({ id: 'd', status: STATUS.CANCELING, started: false,
    created: '2026-08-01T10:01:00Z' });
  const running = run({ id: 'r', status: STATUS.RUNNING, created: '2026-08-01T10:00:00Z' });

  it('is cancelled, not stopping', () => {
    expect(isDropped(dropped)).toBe(true);
    expect(isStopping(dropped)).toBe(false);
    expect(statusLabel(dropped)).toBe('Cancelled');
  });

  it('says why it is still on the list', () => {
    expect(queueNote(dropped, [running, dropped]))
      .toBe('Cancelled · the worker drops it after the run ahead');
  });

  it('says nothing extra once there is nothing ahead of it', () => {
    expect(queueNote(dropped, [dropped])).toBe('Cancelled');
  });

  it('is not something another run is waiting behind', () => {
    const waiting = run({ id: 'w', status: STATUS.QUEUED, created: '2026-08-01T10:02:00Z' });
    expect(queueNote(waiting, [dropped, waiting])).toBe('Next in queue');
  });

  it('is not counted as active, because the worker will spend no time on it', () => {
    expect(activeCount([dropped, running])).toBe(1);
  });

  it('is distinguished from a run that had started when it was cancelled', () => {
    const midRun = run({ status: STATUS.CANCELING, started: true });
    expect(statusLabel(midRun)).toBe('Stopping…');
  });
});

describe('which runs are on this slide', () => {
  it('keys on the image file, so a copied item and its original are one slide', () => {
    expect(slideKeyOf({ _id: COPY, largeImage: { fileId: FILE } })).toBe(FILE);
    expect(slideKeyOf({ _id: ORIGIN, largeImage: { fileId: FILE } })).toBe(FILE);
  });

  it('falls back to the item for something with no tile source', () => {
    expect(slideKeyOf({ _id: COPY })).toBe(COPY);
    expect(slideKeyOf(null)).toBeNull();
  });

  it('groups a native run and a docker CLI on the same slide together', () => {
    // The measured case: two item ids, one file, one slide.
    const native = run({ id: 'n', itemId: COPY, slideKey: FILE });
    const cli = run({ id: 'c', itemId: ORIGIN, slideKey: FILE, lane: 'girder_worker' });
    const groups = groupRuns([native, cli], { _id: COPY, largeImage: { fileId: FILE } });
    expect(groups).toHaveLength(1);
    expect(groups[0][0]).toBe(THIS_SLIDE);
    expect(groups[0][1].map(r => r.id).sort()).toEqual(['c', 'n']);
  });

  it('puts other slides second and keeps them, because they explain the wait', () => {
    const here = run({ id: 'h', slideKey: FILE });
    const there = run({ id: 't', slideKey: 'other-file', slideName: 'TCGA-ZZ-9999.svs' });
    const groups = groupRuns([here, there], { _id: COPY, largeImage: { fileId: FILE } });
    expect(groups.map(([k, rs]) => [k, rs.map(r => r.id)]))
      .toEqual([[THIS_SLIDE, ['h']], [OTHER_SLIDES, ['t']]]);
  });

  it('drops an empty group rather than showing an empty heading', () => {
    const there = run({ id: 't', slideKey: 'other-file' });
    expect(groupRuns([there], { _id: COPY, largeImage: { fileId: FILE } }))
      .toEqual([[OTHER_SLIDES, [there]]]);
  });

  it('calls everything OTHER SLIDES when no slide is open', () => {
    const groups = groupRuns([run({ id: 'a' })], null);
    expect(groups[0][0]).toBe(OTHER_SLIDES);
  });

  it('orders each group newest first', () => {
    const old = run({ id: 'o', created: '2026-08-01T09:00:00Z' });
    const recent = run({ id: 'r', created: '2026-08-01T11:00:00Z' });
    const [[, rows]] = groupRuns([old, recent], { _id: COPY, largeImage: { fileId: FILE } });
    expect(rows.map(r => r.id)).toEqual(['r', 'o']);
  });
});

describe('the header count', () => {
  it('counts everything still holding a queue slot, stopping runs included', () => {
    expect(activeCount([
      run({ id: '1', status: STATUS.RUNNING }),
      run({ id: '2', status: STATUS.QUEUED }),
      run({ id: '3', status: STATUS.CANCELING }),
      run({ id: '4', status: STATUS.SUCCESS }),
      run({ id: '5', status: STATUS.ERROR }),
    ])).toBe(3);
  });
});

// ── Chains (Inc 6 · 07) ───────────────────────────────────────────────────────

describe('chainGroups', () => {
  const step = (n, over = {}) => ({
    id: `j${n}`, status: STATUS.SUCCESS, created: `2026-08-02T0${n}:00:00Z`, lane: 'pathassist',
    chain: { id: 'c1', step: n, total: 3, label: 'Feature index', kinds: [] }, ...over,
  });

  it('draws a run with no chain on its own', () => {
    const loose = { id: 'x', status: STATUS.RUNNING };
    expect(chainGroups([loose])).toEqual([{ run: loose }]);
  });

  it('gathers the steps of one submission and orders them by step, not by age', () => {
    // The feed is newest-first; inside a chain the only order that means anything is the run order.
    const groups = chainGroups([step(3), step(1), step(2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map(r => r.chain.step)).toEqual([1, 2, 3]);
  });

  it('keeps two submissions apart even when they run the same kinds', () => {
    const other = { ...step(1), id: 'k1', chain: { ...step(1).chain, id: 'c2' } };
    expect(chainGroups([step(1), other]).map(g => g.chain.id)).toEqual(['c1', 'c2']);
  });

  it('holds the group where its first step appeared, so the list stays newest-first', () => {
    const loose = { id: 'x', status: STATUS.RUNNING };
    expect(chainGroups([loose, step(1)]).map(g => g.chain?.id || 'loose'))
      .toEqual(['loose', 'c1']);
  });
});

describe('chainStatus', () => {
  const at = (n, status, total = 3) => ({
    id: `j${n}`, status, chain: { id: 'c1', step: n, total, label: 'Feature index' },
  });
  const group = (runs, total = 3) => ({ chain: { id: 'c1', total, label: 'Feature index' }, runs });

  it('says where a running chain has got to', () => {
    expect(chainStatus(group([at(1, STATUS.SUCCESS), at(2, STATUS.RUNNING)])).label)
      .toBe('Step 2 of 3');
  });

  it('counts the steps that were asked for, not the rows that exist', () => {
    // A step that has not been published has no job at all — the server only mints one when the
    // message goes out. So a chain on step 1 has one row and still says "of 3".
    expect(chainStatus(group([at(1, STATUS.RUNNING)])).label).toBe('Step 1 of 3');
  });

  it('names the step a chain failed at', () => {
    const s = chainStatus(group([at(1, STATUS.SUCCESS), at(2, STATUS.ERROR)]));
    expect(s.label).toBe('Failed at step 2 of 3');
    expect(s.busy).toBe(false);
  });

  it('names the step a chain was stopped at', () => {
    expect(chainStatus(group([at(1, STATUS.CANCELED)])).label).toBe('Stopped at step 1 of 3');
  });

  it('stops counting once every step is done', () => {
    const done = [at(1, STATUS.SUCCESS), at(2, STATUS.SUCCESS), at(3, STATUS.SUCCESS)];
    expect(chainStatus(group(done)).label).toBe('3 steps · done');
  });
});
