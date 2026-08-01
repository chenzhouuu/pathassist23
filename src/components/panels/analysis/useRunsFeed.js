// src/components/panels/analysis/useRunsFeed.js — the one poller (Inc 6 · 03, shared in 04).
//
// Every row it fetches goes into the store through `applyJobEvent`, which is the seam the
// WebSocket ticket replaces (plan D8). Two panels now want the feed — Analysis draws the Runs
// section from it, the Workspace joins it onto its artifact rows — and it is still one poller:
// TanStack dedupes on the query key, so whichever panel is mounted drives the interval and both
// read the same store.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listRuns } from '../../../api/index.js';
import { useRunsStore } from '../../../store/runs.js';

//: Against a 2.5 s poll today; the same rows arrive over the WebSocket later (plan §4).
export const POLL_MS = 2500;

//: How much history the feed asks for. Every *unfinished* run comes back regardless — that is the
//: server's rule, and it is what makes "3 ahead" exact — so this only bounds the tail.
export const HISTORY = 15;

export const RUNS_QUERY_KEY = ['pathassist-runs'];

export function useRunsFeed() {
  const syncRuns = useRunsStore(s => s.syncRuns);

  const { data, error } = useQuery({
    queryKey: RUNS_QUERY_KEY,
    queryFn: () => listRuns(HISTORY),
    refetchInterval: POLL_MS,
    retry: 1,
  });

  useEffect(() => { if (data) syncRuns(data); }, [data, syncRuns]);

  return { error };
}
