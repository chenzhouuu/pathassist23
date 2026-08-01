// src/components/panels/analysis/runsUtils.js — what a run row says (Inc 6 · 03).
//
// Pure derivations over the rows `GET /pathassist/runs` returns. Everything with a decision in it
// lives here so the interesting cases — a queued run behind two others, a stopping run that still
// holds the GPU, a job whose progress has counts versus one that only has a percentage — are
// testable without a browser.
//
// The status vocabulary is harvested, not chosen. `girder_jobs/web_client/JobStatus.js` defines
// 0–5 and `girder_plugin_worker/web_client/JobStatus.js` adds 820–824; both are wire values the
// server already writes, so re-deriving them here would only be a second opinion about a number.

// ── The status enum, as the server writes it ──────────────────────────────────
export const STATUS = {
  INACTIVE: 0, QUEUED: 1, RUNNING: 2, SUCCESS: 3, ERROR: 4, CANCELED: 5,
  // girder_plugin_worker/status.py::CustomJobStatus
  FETCHING_INPUT: 820, CONVERTING_INPUT: 821, CONVERTING_OUTPUT: 822,
  PUSHING_OUTPUT: 823, CANCELING: 824,
};

// Text and colour from upstream's own table, with one substitution: CANCELING reads `Stopping…`
// rather than `Canceling`, because that is the word this app already used for the same cooperative
// wait — the nuclei panel said it until 05 retired it, and the tissue panel still does.
const LABEL = {
  [STATUS.INACTIVE]: ['Inactive', 'var(--muted-hex)'],
  [STATUS.QUEUED]: ['Waiting', '#f5a623'],
  [STATUS.RUNNING]: ['Running', '#4da6ff'],
  [STATUS.SUCCESS]: ['Done', '#4caf82'],
  [STATUS.ERROR]: ['Failed', '#e94560'],
  [STATUS.CANCELED]: ['Stopped', 'var(--muted-hex)'],
  [STATUS.FETCHING_INPUT]: ['Fetching input', '#4da6ff'],
  [STATUS.CONVERTING_INPUT]: ['Converting input', '#4da6ff'],
  [STATUS.CONVERTING_OUTPUT]: ['Converting output', '#4da6ff'],
  [STATUS.PUSHING_OUTPUT]: ['Pushing output', '#4da6ff'],
  [STATUS.CANCELING]: ['Stopping…', '#f5a623'],
};

/** Statuses in which a run still occupies its queue. A stopping run has not let go of the GPU. */
export const UNFINISHED = [
  STATUS.INACTIVE, STATUS.QUEUED, STATUS.RUNNING, STATUS.FETCHING_INPUT,
  STATUS.CONVERTING_INPUT, STATUS.CONVERTING_OUTPUT, STATUS.PUSHING_OUTPUT, STATUS.CANCELING,
];

export const statusColor = (run) => (LABEL[run?.status] || ['Unknown', 'var(--muted-hex)'])[1];

export const isUnfinished = (run) => UNFINISHED.includes(run?.status);
export const isWaiting = (run) => run?.status === STATUS.QUEUED || run?.status === STATUS.INACTIVE;

/**
 * CANCELING means two different things, and `started` is what separates them.
 *
 * A run that had begun is genuinely stopping: the driver has forwarded the request and the service
 * is finishing the tile it is on. A run still on the queue has no runner to ask — celery holds the
 * revoked message and drops it unread when it finally reaches it, which at `--concurrency=1` is
 * after the run ahead of it finishes. Both are status 824; only one of them is stopping.
 */
export const isStopping = (run) => run?.status === STATUS.CANCELING && run?.started !== false;
export const isDropped = (run) => run?.status === STATUS.CANCELING && run?.started === false;

export function statusLabel(run) {
  if (isDropped(run)) return 'Cancelled';
  return (LABEL[run?.status] || ['Unknown', 'var(--muted-hex)'])[0];
}

/** The sentence a cancelled-but-not-yet-discarded row carries instead of a progress line. */
export function droppedNote(run, runs) {
  if (!isDropped(run)) return null;
  return aheadOf(run, runs) === 0
    ? 'Cancelled'
    : 'Cancelled · the worker drops it after the run ahead';
}

/**
 * Whether Stop is offered — girder_plugin_worker/web_client/JobStatus.js:41, verbatim in shape:
 * anything not already settled or already stopping. Both families here are celery-handled, so the
 * handler test upstream makes is the constant `true` on this list.
 */
export function isCancelable(run) {
  return ![STATUS.CANCELED, STATUS.CANCELING, STATUS.SUCCESS, STATUS.ERROR].includes(run?.status);
}

// ── The progress line ─────────────────────────────────────────────────────────

/**
 * What the row says about how far along a run is.
 *
 * The counts come from the job's own progress message, which the driver composes from the numbers
 * the service reported (`status.progress_message` → `142 / 338 · nuclei`). A percentage is the
 * fallback for a run that reported a total and nothing to call it — never a recomputation of a
 * message that already exists, so the row and the job never disagree on screen.
 */
export function progressText(run) {
  const p = run?.progress;
  if (!p) return null;
  if (p.message) return p.message;
  if (p.total > 0 && p.current != null) return `${Math.round((100 * p.current) / p.total)}%`;
  return null;
}

/** 0..1 for the bar, or null when the job reports no total to divide by. */
export function progressFraction(run) {
  const p = run?.progress;
  if (!p || !(p.total > 0) || p.current == null) return null;
  return Math.max(0, Math.min(1, p.current / p.total));
}

// ── The queue ─────────────────────────────────────────────────────────────────

/**
 * Whether this run will actually cost the worker time.
 *
 * Everything unfinished does, with one exception: a run cancelled before it started is still on
 * the queue but celery discards it in milliseconds when it reaches it. Counting it as something
 * to wait for would overstate every position behind it.
 */
export const holdsTheQueue = (run) => isUnfinished(run) && !isDropped(run);

/**
 * How many runs this one is behind, counting the one that is running.
 *
 * Only within the same lane: a nuclei run waiting at `--concurrency=1` is not waiting behind a
 * HistomicsTK container on the DSA worker. With one worker per lane this is the number that
 * explains the wait, which is why the row states it rather than saying "queued".
 */
export function aheadOf(run, runs) {
  if (!isWaiting(run) && !isDropped(run)) return 0;
  return runs.filter(r => r.id !== run.id
    && r.lane === run.lane
    && holdsTheQueue(r)
    && (r.created || '') < (run.created || '')).length;
}

/** The waiting row's own sentence. `next` is a real state at concurrency=1 and reads better. */
export function queueNote(run, runs) {
  if (isDropped(run)) return droppedNote(run, runs);
  if (!isWaiting(run)) return null;
  const ahead = aheadOf(run, runs);
  if (ahead === 0) return 'Next in queue';
  return ahead === 1 ? 'Waiting · 1 ahead' : `Waiting · ${ahead} ahead`;
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/**
 * The key two runs must share to be "the same slide".
 *
 * The image file, not the item. The DEMO slide is a `copyOfItem` whose `largeImage.fileId` points
 * at the original's file, so a native run (submitted against the copy) and a docker CLI (resolved
 * back through the file to the original) name two different items and one slide. The server keys
 * rows the same way; this is the active item read through the same rule.
 */
export const slideKeyOf = (item) => item?.largeImage?.fileId || item?._id || null;

export const THIS_SLIDE = 'THIS SLIDE';
export const OTHER_SLIDES = 'OTHER SLIDES';

/**
 * `[[heading, runs], …]`, current slide first, empty groups dropped.
 *
 * Global by design (Inc 6 · D3): the runs on other slides are not noise, they are the answer to
 * "what is ahead of me". Sorting is by `created` descending inside each group, which is also the
 * order the queue will drain in reverse.
 */
export function groupRuns(runs, activeItem) {
  const key = slideKeyOf(activeItem);
  const byCreated = (a, b) => (b.created || '').localeCompare(a.created || '');
  const here = [], elsewhere = [];
  (runs || []).forEach(r => ((key && r.slideKey === key) ? here : elsewhere).push(r));
  return [[THIS_SLIDE, here.sort(byCreated)], [OTHER_SLIDES, elsewhere.sort(byCreated)]]
    .filter(([, rs]) => rs.length > 0);
}

/** How many runs the workers are still going to spend time on — the header's count. */
export const activeCount = (runs) => (runs || []).filter(holdsTheQueue).length;
