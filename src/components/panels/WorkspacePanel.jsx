// src/components/panels/WorkspacePanel.jsx — the per-slide artifact workspace (Inc 5).
//
// One place that lists every artifact a slide has, says what each one is in a line, switches its
// overlay on and off, and deletes it. Ticket 02 delivers the list; the eye arrives in 03 and delete
// in 04, both of which DataRow already has sockets for.
//
// The list is the artifact table itself (D1) — there is no separate workspace record. Rows come
// from the gateway's /artifacts endpoint, which reconciles any in-flight build against its worker
// before answering, so a queued row becomes ready here without the panel knowing which worker owns
// which kind.
//
// The panel is ordinary .jsx like every other panel; only the components it is assembled from are
// vendored TypeScript. That boundary is the point: OHIF's files stay a copy, and the app code that
// binds them to this repo's data stays ours.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { deleteArtifact, getArtifactUsage, listArtifacts } from '../../api/preprocessApi.js';
import { TooltipProvider } from '../ui/tooltip.tsx';
import { PanelSection } from '../workspace/vendor/ohif/PanelSection.tsx';
import { DataRow } from '../workspace/vendor/ohif/DataRow.tsx';
import {
  describeArtifact, describeDependant, formatBytes, isInFlight, sortArtifacts,
} from './workspaceUtils.js';

const POLL_MS = 2500;

export default function WorkspacePanel() {
  const activeItem = useStore((s) => s.activeItem);
  const visibleArtifacts = useStore((s) => s.visibleArtifacts);
  const toggleArtifactVisible = useStore((s) => s.toggleArtifactVisible);
  const itemId = activeItem?._id || null;

  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState(null);   // { title, dependants } — a refused delete
  const [deleting, setDeleting] = useState(null); // the hash currently being removed
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); setLoaded(false); return; }
    try {
      setRows(await listArtifacts(itemId));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoaded(true);
    }
  }, [itemId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll only while something is actually building — a slide whose artifacts are all finished is
  // a static list, and the endpoint reconciles against the workers on every call.
  const building = rows.some(isInFlight);
  useEffect(() => {
    if (!building) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return undefined;
    }
    pollRef.current = setInterval(() => { refresh(); }, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  }, [building, refresh]);

  const described = useMemo(() => sortArtifacts(rows).map((row) => describeArtifact(row)), [rows]);

  // Delete asks the gateway what this would free and what is holding it, before offering the
  // button. A refusal is shown in the panel rather than in the confirm, because it is not a
  // question — there is nothing for the user to agree to.
  const onDelete = useCallback(async (view) => {
    setBlocked(null);
    setError(null);
    setDeleting(view.key);
    try {
      const { bytes, dependants } = await getArtifactUsage(itemId, view.key);
      if (dependants.length) { setBlocked({ title: view.title, dependants }); return; }

      const what = view.primary[0] ? `${view.title} (${view.primary[0]})` : view.title;
      const frees = formatBytes(bytes);
      const ok = window.confirm(
        `Delete ${what}?\n\n`
        + (frees ? `This frees ${frees} on disk. ` : '')
        + 'It cannot be undone — rebuilding it means running the job again.',
      );
      if (!ok) return;

      const res = await deleteArtifact(itemId, view.key);
      // The list can go stale between the check and the click; the gateway is the authority.
      if (!res.deleted) { setBlocked({ title: view.title, dependants: res.dependants }); return; }
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(null);
    }
  }, [itemId, refresh]);

  if (!activeItem) {
    return (
      <div
        className="flex flex-col items-center justify-center h-48 text-xs gap-2"
        style={{ color: 'var(--muted-hex)' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
        No slide selected
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="p-2">
        <PanelSection>
          <PanelSection.Header>
            <span>Artifacts{described.length ? ` (${described.length})` : ''}</span>
          </PanelSection.Header>
          <PanelSection.Content>
            {error && (
              <div className="px-2.5 py-3 text-xs" style={{ color: 'var(--danger)' }}>
                {error}
              </div>
            )}
            {blocked && (
              <div className="px-2.5 py-3 text-xs" style={{ color: 'var(--muted-hex)' }}>
                <div style={{ color: 'var(--danger)' }}>
                  {blocked.title} was used to build {blocked.dependants.length === 1
                    ? 'another artifact' : `${blocked.dependants.length} other artifacts`}.
                </div>
                <ul className="mt-1 ml-4 list-disc">
                  {blocked.dependants.map((d) => (
                    <li key={d.art_hash}>{describeDependant(d)}</li>
                  ))}
                </ul>
                <div className="mt-1">Delete {blocked.dependants.length === 1 ? 'it' : 'those'} first.</div>
                <button type="button" className="mk-btn mt-2" onClick={() => setBlocked(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {!error && loaded && described.length === 0 && (
              <div className="px-2.5 py-6 text-center text-xs" style={{ color: 'var(--muted-hex)' }}>
                Nothing has been built for this slide yet.
              </div>
            )}
            <div className="flex flex-col gap-px">
              {described.map((view, i) => (
                <DataRow
                  key={view.key || i}
                  number={i + 1}
                  title={view.title}
                  details={{ primary: view.primary, secondary: view.secondary }}
                  isVisible={!!visibleArtifacts[view.key]}
                  // Withholding the callback is what leaves a row without an eye — a `features`
                  // artifact has nothing to put on the slide, and neither has a kind whose layer
                  // owner has not moved across yet (03b).
                  onToggleVisibility={
                    view.canSwitch ? () => toggleArtifactVisible(view.key, view.kind) : undefined
                  }
                  disableEditing={false}
                  onDelete={() => onDelete(view)}
                  className={[
                    view.failed ? 'opacity-70' : '',
                    deleting === view.key ? 'opacity-40 pointer-events-none' : '',
                  ].filter(Boolean).join(' ') || undefined}
                />
              ))}
            </div>
          </PanelSection.Content>
        </PanelSection>
      </div>
    </TooltipProvider>
  );
}
