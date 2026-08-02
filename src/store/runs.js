// src/store/runs.js — the runs the Runs list shows (Inc 6 · 03).
//
// One store with one mutator. `applyJobEvent(run)` is the only way a row changes, so the feed can
// be replaced without touching anything downstream: today the poller diffs `GET /pathassist/runs`
// and calls it once per changed row; when the WebSocket ticket lands (plan D8, deferred because
// switching the deployment from `girder.wsgi` to `girder.asgi` deserves its own risk window)
// Girder's `g:event.job_status` calls the same function with the same shape.
//
// `syncRuns(page)` is built on top rather than beside it: it applies each row through
// `applyJobEvent` and then drops the ids the page no longer carries. The drop is the one thing an
// event feed cannot do for itself — a run that aged off the finished page never emits anything.
import { create } from 'zustand';
import { isUnfinished } from '../components/panels/analysis/runsUtils.js';

/** Fields whose change is worth a re-render. Everything else on a row is fixed at creation. */
const VOLATILE = ['status', 'updated', 'reason'];

function changed(before, after) {
  if (!before) return true;
  if (VOLATILE.some(k => before[k] !== after[k])) return true;
  const a = before.progress || {}, b = after.progress || {};
  return a.current !== b.current || a.total !== b.total || a.message !== b.message;
}

export const useRunsStore = create((set, get) => ({
  /** id → run row. */
  byId: {},
  /** Whether a page has ever arrived — the difference between "no runs" and "not asked yet". */
  loaded: false,
  /** ids whose Stop has been sent but whose status has not caught up yet. */
  stopping: {},

  /**
   * Upsert one run. The single write path.
   *
   * Returns the row unchanged when nothing volatile moved, so a poll over a quiet queue does not
   * churn every subscriber twice a second.
   */
  applyJobEvent: (run) => {
    if (!run?.id) return;
    const before = get().byId[run.id];
    if (!changed(before, run)) return;
    set(s => {
      const byId = { ...s.byId, [run.id]: { ...before, ...run } };
      // The local Stop intent covers the gap between the click and the server's CANCELING, and
      // ends the moment the run settles — the server is the authority from there. Without this a
      // stopped run reads "Stopping…" for as long as it stays on the page, which is exactly the
      // lie the intent exists to prevent at the other end (found running Inc 6 · 06 on DEMO).
      if (!s.stopping[run.id] || isUnfinished(run)) return { byId };
      const stopping = { ...s.stopping };
      delete stopping[run.id];
      return { byId, stopping };
    });
  },

  /** A whole page from the poller: apply every row, then forget the ones it no longer lists. */
  syncRuns: (page) => {
    const rows = page || [];
    rows.forEach(get().applyJobEvent);
    const keep = new Set(rows.map(r => r.id));
    set(s => {
      const byId = {};
      Object.entries(s.byId).forEach(([id, run]) => { if (keep.has(id)) byId[id] = run; });
      // `stopping` is a local intent, not server state: it expires with the row it belongs to.
      const stopping = {};
      Object.keys(s.stopping).forEach(id => { if (keep.has(id)) stopping[id] = true; });
      return { byId, stopping, loaded: true };
    });
  },

  /**
   * Remember that Stop was sent for this run.
   *
   * The button must not keep offering Stop while the request is in flight, and the server's
   * CANCELING (824) only appears on the next poll — up to 2.5 s later, which is long enough to
   * click twice.
   */
  markStopping: (id) => set(s => ({ stopping: { ...s.stopping, [id]: true } })),

  /** Newest first — the order the list renders in before it is grouped. */
  runs: () => Object.values(get().byId)
    .sort((a, b) => (b.created || '').localeCompare(a.created || '')),
}));
