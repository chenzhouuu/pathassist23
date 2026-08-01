// src/components/panels/WorkspacePanel.jsx — the per-slide artifact workspace (Inc 5, Inc 6 · 04).
//
// One place that lists every artifact a slide has, says what each one is in a line, switches its
// overlay on and off, and deletes it. Inc 5 delivered the list, the eye and delete.
//
// Inc 6 · 04 gives a row an inside. Opening one shows the numbers that artifact stores and the
// controls its layer is drawn with — the blocks that used to be the body of `NucleiPanel`, now
// next to the eye that was already here. The parameters themselves did not move: they live in the
// store, because the mask keeps drawing while this panel is closed and the right panel unmounts a
// panel on every tab switch. This is where they are edited, not where they live.
//
// The list is the artifact table itself (D1) — there is no separate workspace record — unioned
// with the runs in flight for this slide (plan §5). Rows come from the gateway's /artifacts
// endpoint; the runs come from the store the Analysis poller already fills, so opening the
// Workspace adds no second poller.
//
// The panel is ordinary .jsx like every other panel; only the components it is assembled from are
// vendored TypeScript. That boundary is the point: OHIF's files stay a copy, and the app code that
// binds them to this repo's data stays ours.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { deleteArtifact, getArtifactUsage, listArtifacts } from '../../api/preprocessApi.js';
import { getNucleiMeta } from '../../api/nucleiApi.js';
import { TooltipProvider } from '../ui/tooltip.tsx';
import { PanelSection } from '../workspace/vendor/ohif/PanelSection.tsx';
import { DataRow } from '../workspace/vendor/ohif/DataRow.tsx';
import ArtifactConfig from '../workspace/ArtifactConfig.jsx';
import ArtifactSegments from '../workspace/ArtifactSegments.jsx';
import { detailFor, hasDetail, layerBinding } from '../workspace/artifactDetail.js';
import { joinRuns } from '../workspace/runJoin.js';
import { useRunsFeed } from './analysis/useRunsFeed.js';
import { useRunsStore } from '../../store/runs.js';
import { slideKeyOf } from './analysis/runsUtils.js';
import {
  describeArtifact, describeDependant, formatBytes, isInFlight, sortArtifacts,
} from './workspaceUtils.js';

const POLL_MS = 2500;

//: Which kinds can fetch their stored meta. One entry per kind that has moved its controls across;
//: tissue and biomarker join it in 06, beside their entries in `artifactDetail`.
const META_LOADERS = { nuclei: getNucleiMeta };

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
  const [openKey, setOpenKey] = useState(null);   // the art_hash whose detail is showing
  const [meta, setMeta] = useState({});           // art_hash → the artifact's stored meta
  const pollRef = useRef(null);

  // The same query key the Analysis panel uses, so this is the one poller either way.
  useRunsFeed();
  const runsById = useRunsStore((s) => s.byId);

  // The detail's numbers come off disk, not off the call that made them. Fetched for the open row
  // only, and re-fetched on every refresh — while a build runs its own counts are still moving,
  // and a cached first reading would freeze at whatever the first tile found.
  const loadMeta = useCallback(async (key, kind) => {
    const load = META_LOADERS[kind];
    if (!key || !load || !itemId) return;
    try {
      const m = await load(itemId, key);
      setMeta((prev) => ({ ...prev, [key]: m }));
    } catch {
      // `null` records that we asked. A build that has stored polygons but not yet written its
      // meta says "nothing stored yet" rather than spinning forever.
      setMeta((prev) => ({ ...prev, [key]: prev[key] ?? null }));
    }
  }, [itemId]);

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); setLoaded(false); return; }
    try {
      const next = await listArtifacts(itemId);
      setRows(next);
      setError(null);
      const open = next.find((r) => r.art_hash === openKey);
      if (open) await loadMeta(open.art_hash, open.kind);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoaded(true);
    }
  }, [itemId, openKey, loadMeta]);

  useEffect(() => { refresh(); }, [refresh]);

  // Artifacts ∪ the runs in flight for this slide, unioned on `art_hash` — the hash is computed
  // before the job is dispatched, so a ghost row becomes a real row under the same React key and
  // nothing flickers (plan §5).
  const described = useMemo(() => {
    const views = sortArtifacts(rows).map((row) => describeArtifact(row));
    return joinRuns(views, Object.values(runsById), slideKeyOf(activeItem));
  }, [rows, runsById, activeItem]);

  // A run starting or finishing is exactly when this list changes, and for a kind on the D9 shape
  // it is the *only* signal: nuclei has no artifact row until its bytes exist, so the ghost row
  // becoming a real one is a job leaving the unfinished set and nothing else would have asked.
  const liveRuns = described.filter((v) => v.run).length;
  useEffect(() => { refresh(); }, [liveRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll only while something is actually building — a slide whose artifacts are all finished is
  // a static list, and the endpoint reconciles against the workers on every call. The runs feed
  // has its own poller, so this one covers the kinds whose progress still lives on the row.
  const building = rows.some(isInFlight);
  useEffect(() => {
    if (!building) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return undefined;
    }
    pollRef.current = setInterval(() => { refresh(); }, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  }, [building, refresh]);

  // A slide's meta is that slide's. Nothing carries over, and neither does what was open.
  useEffect(() => { setMeta({}); setOpenKey(null); }, [itemId]);

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

  // Opening a row is what fetches its meta. A second click closes it — there is one detail open at
  // a time, because two open rows would put two opacity sliders on screen with no way to tell
  // which layer each one drives.
  const onSelect = useCallback((view) => {
    if (!hasDetail(view.kind) || view.ghost) return;
    setOpenKey((prev) => {
      const next = prev === view.key ? null : view.key;
      if (next) loadMeta(next, view.kind);
      return next;
    });
  }, [loadMeta]);

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
                <React.Fragment key={view.key || i}>
                  <DataRow
                    number={i + 1}
                    title={view.title}
                    details={{ primary: view.primary, secondary: view.secondary }}
                    isVisible={!!visibleArtifacts[view.key]}
                    isSelected={openKey === view.key}
                    // Only a kind whose controls have moved across is clickable. A row that opens
                    // onto nothing is worse than a row that does not open.
                    onSelect={hasDetail(view.kind) && !view.ghost ? () => onSelect(view) : undefined}
                    // Withholding the callback is what leaves a row without an eye — a `features`
                    // artifact has nothing to put on the slide, and neither has a ghost row, whose
                    // bytes do not exist yet.
                    onToggleVisibility={
                      view.canSwitch ? () => toggleArtifactVisible(view.key, view.kind) : undefined
                    }
                    // A ghost has nothing on disk to delete, so it gets no menu either.
                    disableEditing={!!view.ghost}
                    onDelete={view.ghost ? undefined : () => onDelete(view)}
                    className={[
                      view.failed ? 'opacity-70' : '',
                      view.ghost ? 'opacity-80' : '',
                      deleting === view.key ? 'opacity-40 pointer-events-none' : '',
                    ].filter(Boolean).join(' ') || undefined}
                  />
                  {openKey === view.key && (
                    <ArtifactDetail
                      view={view}
                      meta={meta[view.key]}
                      loaded={meta[view.key] !== undefined}
                    />
                  )}
                </React.Fragment>
              ))}
            </div>
          </PanelSection.Content>
        </PanelSection>
      </div>
    </TooltipProvider>
  );
}

/**
 * The inside of an opened row: the numbers the artifact stores, then its classes, then the
 * controls its layer is drawn with.
 *
 * It reads and writes the store slice `artifactDetail` names for this kind. That indirection is
 * what lets 06 add tissue and biomarker as two more table entries instead of two more branches
 * here — the panel never learns which slice it is editing.
 */
function ArtifactDetail({ view, meta, loaded }) {
  const binding = layerBinding(view.kind);
  // The hook order is fixed because `binding` is a function of `view.kind`, and a row cannot
  // change kind — this component unmounts when a different row is opened.
  const layer = useStore((s) => s[binding.layerKey]);
  const setLayer = useStore((s) => s[binding.setterKey]);
  const detail = detailFor(view.kind, meta, layer);

  if (!loaded) {
    return (
      <div className="px-2.5 py-3 text-xs" style={{ color: 'var(--muted-hex)' }}>Loading…</div>
    );
  }
  if (!meta) {
    return (
      <div className="px-2.5 py-3 text-xs" style={{ color: 'var(--muted-hex)' }}>
        Nothing stored for this artifact yet.
      </div>
    );
  }

  const resolved = binding.withDefaults(layer);

  return (
    <div data-cy="artifact-detail">
      {detail.stats.length > 0 && (
        <div className="bg-muted space-y-1 px-2.5 py-2">
          {detail.stats.map((s) => (
            <div key={s.key} className="flex items-baseline justify-between text-xs">
              <span style={{ color: 'var(--muted-hex)' }}>{s.label}</span>
              <span style={{ color: 'var(--text)' }}>{s.value}</span>
            </div>
          ))}
        </div>
      )}

      <ArtifactSegments
        segments={detail.segments}
        // The eye is only meaningful once there is a picture to remove a class from.
        onToggle={detail.config.drawn
          ? (key) => setLayer(binding.toggleSegment(resolved, key))
          : undefined}
      />

      <ArtifactConfig
        config={detail.config}
        onMode={(render) => setLayer({ render })}
        onOpacity={(opacity) => setLayer({ opacity })}
      />
    </div>
  );
}
