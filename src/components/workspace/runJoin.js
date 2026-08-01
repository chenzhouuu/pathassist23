// src/components/workspace/runJoin.js — the Workspace list is artifacts ∪ runs (Inc 6 · 04).
//
// Plan §5: a row list is `(ready artifacts from Postgres) ∪ (in-flight jobs for this slide from
// Girder)`, unioned on `art_hash`. The hash is computed at submit time, before the job is
// dispatched, so both sides key on the same string — which is what makes a ghost row become a real
// row without flicker: same React key, more fields.
//
// Two things this buys, and both are visible on a slide that is building:
//
//   1. **A run with no row yet gets one.** The gateway writes its artifact row and then dispatches;
//      between those two the job exists and nothing in the Workspace said so. A user who submitted
//      from Analysis and switched to Workspace saw an empty list.
//   2. **A building row borrows the job's progress.** The artifact row carries a coarse percentage
//      reconciled only when somebody has the list open; the Girder job carries `142 / 338 · nuclei`,
//      written by the driver every second. The job is the better witness, so it wins.
//
// Kept deliberately narrow: this joins and it describes, it does not fetch. The runs come from the
// store the Analysis poller already fills, so opening the Workspace adds no second poller.
import { isUnfinished, progressText } from '../panels/analysis/runsUtils.js';
import { kindLabel } from '../panels/workspaceUtils.js';

/** Runs on this slide, newest first. `slideKey` is the image file, not the item — see runsUtils. */
export function runsForSlide(runs, slideKey) {
  if (!slideKey) return [];
  return (runs || [])
    .filter(r => r.slideKey === slideKey && r.artHash)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

/**
 * Attach each run to its artifact row, and give the runs with no row one of their own.
 *
 * `views` are `describeArtifact` outputs — already sorted. Ghost rows go on the front, because a
 * row that exists only because a job is running is the newest thing on the slide by construction.
 */
export function joinRuns(views, runs, slideKey) {
  const mine = runsForSlide(runs, slideKey);
  const byHash = new Map();
  // Newest first, so `set` on a repeated hash keeps the newest — a rebuild of the same artifact
  // is the run the row should be showing.
  mine.forEach(r => { if (!byHash.has(r.artHash)) byHash.set(r.artHash, r); });

  const seen = new Set((views || []).map(v => v.key));
  const joined = (views || []).map((view) => {
    const run = byHash.get(view.key);
    if (!run || !isUnfinished(run)) return view;
    const line = progressText(run);
    return {
      ...view,
      run,
      // The job's own words, not a recomputation of them. `secondary` is the right-aligned state
      // slot; replacing it rather than appending keeps the row one line.
      secondary: line ? [line] : view.secondary,
    };
  });

  const ghosts = mine
    .filter(r => !seen.has(r.artHash) && isUnfinished(r))
    .map(describeGhost);

  return [...ghosts, ...joined];
}

/**
 * A run with no artifact row yet, as the four things DataRow needs.
 *
 * No eye and no delete: there is nothing on disk to draw or to remove. The row exists to say that
 * something is happening, which is the one thing the Workspace could not say before.
 */
export function describeGhost(run) {
  const line = progressText(run);
  return {
    key: run.artHash,
    kind: run.kind,
    title: run.kind ? kindLabel(run.kind) : (run.title || 'Analysis'),
    primary: ['Starting…'],
    secondary: line ? [line] : [],
    canSwitch: false,
    canDraw: false,
    failed: false,
    ghost: true,
    run,
  };
}
