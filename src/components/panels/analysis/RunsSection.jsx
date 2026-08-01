// src/components/panels/analysis/RunsSection.jsx — everything that is running, everywhere.
//
// The answer to the question that started Inc 6: two analyses submitted from two panels, and no
// place that said what either was doing. This is that place (ticket 03), and it is deliberately
// one list rather than one per tool — the runs on other slides are not noise, they are why yours
// is waiting.
//
// One poller for the whole app. Every row it fetches goes through `applyJobEvent`, so the
// WebSocket ticket (plan D8) replaces the feed and nothing below this line changes.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelJob, listRuns } from '../../../api/index.js';
import { useRunsStore } from '../../../store/runs.js';
import {
  STATUS, activeCount, groupRuns, isCancelable, isDropped, isStopping, progressFraction,
  progressText, queueNote, statusColor, statusLabel,
} from './runsUtils.js';

//: Against a 2.5 s poll today; the same rows arrive over the WebSocket later (plan §4).
export const POLL_MS = 2500;

//: How much history the section asks for. Every *unfinished* run comes back regardless — that is
//: the server's rule, and it is what makes "3 ahead" exact — so this only bounds the tail.
export const HISTORY = 15;

const Dot = ({ color, spin }) => (
  <span className="shrink-0 rounded-full" aria-hidden="true"
    style={{
      width: 6, height: 6, marginTop: 5, background: color,
      animation: spin ? 'pulse 1.4s ease-in-out infinite' : undefined,
    }} />
);

function RunRow({ run, runs, showSlide, onStop, stopping }) {
  const color = statusColor(run);
  const label = statusLabel(run);
  // A finished run's last progress reading is `done` at 100 % — a line that repeats the status
  // badge beside it. A stopped one keeps its, because how far it got is the whole question.
  const settled = run.status === STATUS.SUCCESS;
  const text = settled ? null : progressText(run);
  const fraction = settled ? null : progressFraction(run);
  const note = queueNote(run, runs);
  // `stopping` is the local intent — Stop was clicked and the server has not answered yet. A row
  // that is CANCELING because it never started is not stopping, it is already cancelled.
  const pending = (stopping && !isDropped(run)) || isStopping(run);

  return (
    <div className="flex items-start gap-2 px-1 py-1.5 rounded" data-cy="run-row"
      style={{ background: 'var(--highlight-hex)', border: '1px solid var(--border-hex)' }}>
      <Dot color={color} spin={!!fraction || label === 'Running'} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs truncate flex-1" style={{ color: 'var(--text)' }}
            title={run.title}>{run.title}</span>
          <span className="shrink-0" style={{ color, fontSize: 9 }}>
            {pending ? 'Stopping…' : label}
          </span>
        </div>

        {showSlide && run.slideName && (
          <div className="truncate" title={run.slideName}
            style={{ color: 'var(--muted-hex)', fontSize: 9 }}>{run.slideName}</div>
        )}

        {fraction != null && (
          <div className="mt-1 rounded overflow-hidden" style={{ height: 3, background: 'var(--bg)' }}>
            <div style={{ width: `${Math.round(fraction * 100)}%`, height: '100%', background: color }} />
          </div>
        )}

        {(text || note) && (
          <div className="mt-0.5" style={{ color: 'var(--muted-hex)', fontSize: 9 }}>
            {note || text}
          </div>
        )}

        {/* The reason, not a link to it — a failure the user has to go elsewhere to read is a
            failure they will not read. */}
        {run.reason && (
          <pre className="mt-1 p-1.5 rounded overflow-auto"
            data-cy="run-reason"
            style={{
              background: 'rgba(233,69,96,0.08)', border: '1px solid rgba(233,69,96,0.25)',
              color: '#e94560', fontSize: 9, maxHeight: 72, whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>{run.reason}</pre>
        )}
      </div>

      {isCancelable(run) && !pending && (
        <button onClick={() => onStop(run)} data-cy="run-stop"
          className="shrink-0 px-1.5 py-0.5 rounded transition-colors"
          title="Stops at the next clean boundary. What is already computed is kept."
          style={{ color: 'var(--muted-hex)', border: '1px solid var(--border-hex)', fontSize: 9 }}
          onMouseEnter={e => { e.currentTarget.style.color = '#e94560'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--muted-hex)'; }}>
          Stop
        </button>
      )}
    </div>
  );
}

export default function RunsSection({ activeItem }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const byId = useRunsStore(s => s.byId);
  const loaded = useRunsStore(s => s.loaded);
  const stopping = useRunsStore(s => s.stopping);
  const syncRuns = useRunsStore(s => s.syncRuns);
  const markStopping = useRunsStore(s => s.markStopping);

  const { data, error: fetchError } = useQuery({
    queryKey: ['pathassist-runs'],
    queryFn: () => listRuns(HISTORY),
    refetchInterval: POLL_MS,
    retry: 1,
  });

  // The poller's only job is to hand the page to the store. Every row goes in through the same
  // door an event would.
  useEffect(() => { if (data) syncRuns(data); }, [data, syncRuns]);

  const runs = useMemo(
    () => Object.values(byId).sort((a, b) => (b.created || '').localeCompare(a.created || '')),
    [byId],
  );
  const groups = useMemo(() => groupRuns(runs, activeItem), [runs, activeItem]);
  const active = activeCount(runs);

  const onStop = useCallback(async (run) => {
    markStopping(run.id);
    setError('');
    try {
      await cancelJob(run.id);
    } catch (e) {
      setError(`Could not stop ${run.title}: ${e?.response?.data?.message || e.message}`);
    }
    qc.invalidateQueries({ queryKey: ['pathassist-runs'] });
  }, [markStopping, qc]);

  return (
    <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--border-hex)' }} data-cy="runs">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--muted-hex)', fontSize: 10 }}>Runs</span>
        {active > 0 && (
          <span style={{ color: '#4da6ff', fontSize: 9 }}>
            {active} active
          </span>
        )}
      </div>

      {fetchError && (
        <div className="rounded p-2 mb-2 text-xs" data-cy="runs-error"
          style={{ background: 'rgba(233,69,96,0.1)', border: '1px solid rgba(233,69,96,0.3)', color: '#e94560', fontSize: 10 }}>
          Could not read the run list: {fetchError?.response?.data?.message || fetchError.message}
        </div>
      )}

      {error && (
        <div className="mb-2" style={{ color: '#e94560', fontSize: 10 }}>{error}</div>
      )}

      {loaded && groups.length === 0 && (
        <div className="text-center py-3" style={{ color: 'var(--muted-hex)', fontSize: 10 }}>
          Nothing has run on this server yet.
        </div>
      )}

      {groups.map(([heading, groupRows]) => (
        <div key={heading} className="mb-2">
          <div className="mb-1 px-1" style={{ color: 'var(--muted-hex)', fontSize: 9, letterSpacing: '0.06em' }}>
            {heading}
          </div>
          <div className="flex flex-col gap-1">
            {groupRows.map(run => (
              <RunRow key={run.id} run={run} runs={runs}
                showSlide={heading !== 'THIS SLIDE'}
                stopping={!!stopping[run.id]}
                onStop={onStop} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
