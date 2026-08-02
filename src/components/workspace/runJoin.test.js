// The Workspace list is artifacts ∪ runs (Inc 6 · 04, plan §5).
//
// The join key is `art_hash`, computed before the job is dispatched, which is the whole reason a
// ghost row can become a real row without flicker. These tests are about the two gaps that closes:
// a run whose artifact row has not been written yet, and a building row whose own progress is
// coarser than the job's.
import { describe, expect, it } from 'vitest';
import { describeGhost, joinRuns, runsForSlide } from './runJoin.js';
import { STATUS } from '../panels/analysis/runsUtils.js';

const FILE = '6a3d59c8d59c30f37fd99be0';

const run = (over = {}) => ({
  id: 'j1', status: STATUS.RUNNING, created: '2026-08-01T19:48:34Z', lane: 'pathassist',
  slideKey: FILE, itemId: 'item-1', kind: 'nuclei', artHash: 'new1',
  title: 'Nuclei segmentation', started: true,
  progress: { current: 142, total: 338, message: '142 / 338 · nuclei' }, ...over,
});

const view = (over = {}) => ({
  key: 'seg1', kind: 'segmentation', title: 'Segmentation',
  primary: ['hest'], secondary: ['3 h ago'], canSwitch: true, canDraw: true, failed: false, ...over,
});

describe('which runs belong to this slide', () => {
  it('keys on the image file, the way the Runs list does', () => {
    const mine = runsForSlide([run(), run({ id: 'j2', slideKey: 'other' })], FILE);
    expect(mine.map(r => r.id)).toEqual(['j1']);
  });

  it('ignores a run with no artifact to join on', () => {
    expect(runsForSlide([run({ artHash: null })], FILE)).toEqual([]);
  });

  it('claims nothing when no slide is open', () => {
    expect(runsForSlide([run()], null)).toEqual([]);
  });
});

describe('a run whose artifact row does not exist yet', () => {
  it('gets a row of its own', () => {
    // The gateway writes the row and then dispatches. Between those two the job exists and the
    // Workspace used to say the slide was empty.
    const joined = joinRuns([], [run()], FILE);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ key: 'new1', kind: 'nuclei', title: 'Nuclei', ghost: true });
  });

  it('goes on the front, because it is the newest thing on the slide by construction', () => {
    const joined = joinRuns([view()], [run()], FILE);
    expect(joined.map(v => v.key)).toEqual(['new1', 'seg1']);
  });

  it('carries the job’s progress and says it has not started storing anything', () => {
    const [ghost] = joinRuns([], [run()], FILE);
    expect(ghost.primary).toEqual(['Starting…']);
    expect(ghost.secondary).toEqual(['142 / 338 · nuclei']);
  });

  it('has no eye and no menu — there are no bytes to draw or to delete', () => {
    const [ghost] = joinRuns([], [run()], FILE);
    expect(ghost.canSwitch).toBe(false);
    expect(ghost.canDraw).toBe(false);
  });

  it('is not created for a run that already finished', () => {
    // Its artifact row is the authority once the bytes exist; a second row would be a duplicate.
    expect(joinRuns([], [run({ status: STATUS.SUCCESS })], FILE)).toEqual([]);
    expect(joinRuns([], [run({ status: STATUS.ERROR })], FILE)).toEqual([]);
  });

  it('names the kind rather than repeating the job title', () => {
    expect(describeGhost(run()).title).toBe('Nuclei');
    // A docker CLI has no kind; its own title is all there is.
    expect(describeGhost(run({ kind: null, title: 'Compute Background Intensity' })).title)
      .toBe('Compute Background Intensity');
  });
});

describe('a building row borrows the job’s progress', () => {
  it('replaces the coarse state line with the counts the driver wrote', () => {
    const joined = joinRuns([view({ key: 'new1', secondary: ['Tiling 42%'] })], [run()], FILE);
    expect(joined[0].secondary).toEqual(['142 / 338 · nuclei']);
    expect(joined[0].run).toBeTruthy();
  });

  it('leaves a finished row exactly as the artifact table described it', () => {
    const v = view({ key: 'new1' });
    const joined = joinRuns([v], [run({ status: STATUS.SUCCESS })], FILE);
    expect(joined[0]).toBe(v);
  });

  it('leaves a row with no run alone', () => {
    const v = view();
    expect(joinRuns([v], [run()], FILE)[1]).toBe(v);
  });

  it('keeps the row’s own state line when the job reports no progress', () => {
    const joined = joinRuns([view({ key: 'new1' })], [run({ progress: null })], FILE);
    expect(joined[0].secondary).toEqual(['3 h ago']);
  });

  it('shows the newest run when the same artifact has been rebuilt', () => {
    const older = run({ id: 'old', created: '2026-08-01T10:00:00Z',
      progress: { current: 1, total: 338, message: '1 / 338 · nuclei' } });
    const newer = run({ id: 'new', created: '2026-08-01T19:00:00Z' });
    const joined = joinRuns([view({ key: 'new1' })], [older, newer], FILE);
    expect(joined[0].run.id).toBe('new');
  });
});

describe('when nothing is running', () => {
  it('the list is exactly the artifact table', () => {
    const views = [view(), view({ key: 'feat1' })];
    expect(joinRuns(views, [], FILE)).toEqual(views);
  });
});

describe('when two runs share one address (Inc 7)', () => {
  // A classification names the cells of an existing nuclei artifact, so it is dispatched under
  // that artifact's hash. Two of them in flight at once is one address with two unfinished runs —
  // and a row list is keyed by address, so this has to collapse to one row or React is handed a
  // duplicate key and starts duplicating and dropping children.
  const classify = (over = {}) => run({
    kind: 'classify', artHash: 'nuc1', title: 'Cell classification', ...over,
  });

  it('makes one ghost row, not one per run', () => {
    const ghosts = joinRuns([], [classify({ id: 'a' }), classify({ id: 'b' })], FILE);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].key).toBe('nuc1');
  });

  it('makes no ghost at all once the artifact it names has a row', () => {
    const joined = joinRuns(
      [view({ key: 'nuc1', kind: 'nuclei', title: 'Nuclei' })],
      [classify({ id: 'a' }), classify({ id: 'b' })],
      FILE,
    );
    expect(joined).toHaveLength(1);
    expect(joined[0].ghost).toBeUndefined();
  });

  it('names the run rather than showing the route it took', () => {
    expect(joinRuns([], [classify()], FILE)[0].title).toBe('Cell classification');
  });
});
