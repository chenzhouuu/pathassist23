// src/components/panels/NucleiPanel.jsx — starting a nuclei build (Inc 5, 05-07; Inc 6 · 04).
//
// Shaped like the Tissue panel, because it drives the same kind of thing: a service's own
// job/artifact control plane, over a region or over the whole slide.
//
// **What this panel no longer holds** (Inc 6 · 04): the stored counts and the mask's controls.
// They belong to the artifact, so they now open inside the artifact's own row in the Workspace,
// next to the eye that switches it on. Nothing about them changed on the way — the numbers still
// come off the artifact's meta and the layer parameters still live in the store — only where they
// are edited. The panel that is left starts builds and stops them, and it goes too when the
// Analysis catalog takes that over (05).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts } from '../../api/preprocessApi.js';
import { cancelNuclei, startNuclei } from '../../api/nucleiApi.js';
import {
  canStop, describeStage, findNucleiRow, findReadySegmentation, isRunning, isStopping,
  progressPercent, startLabel,
} from './nucleiUtils.js';
import { formatRoi, useRegionSelect } from './useRegionSelect.js';

const POLL_MS = 2500;

export default function NucleiPanel() {
  const activeItem = useStore((s) => s.activeItem);
  const { roi: copilotRoi, awaiting: awaitingRoi, start: drawRoi, cancel: cancelRoi,
          clear: clearRoi, show: showRoi } = useRegionSelect();
  const itemId = activeItem?._id || null;

  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const noteArtifactRuns = useStore((s) => s.noteArtifactRuns);

  const row = findNucleiRow(rows);
  const segRow = findReadySegmentation(rows);
  const artHash = row?.art_hash || null;

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); return; }
    const next = await listArtifacts(itemId);
    setRows(next);
    // The mask redraws itself while a build runs, and only a poller knows one is running.
    noteArtifactRuns(next);
  }, [itemId]);

  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);

  // Poll only while something is actually building.
  useEffect(() => {
    if (!isRunning(row)) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return undefined;
    }
    pollRef.current = setInterval(() => { refresh().catch(() => {}); }, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  }, [row?.status, refresh]);

  const run = async (whole) => {
    if (!itemId || (!whole && !copilotRoi)) return;
    setBusy(true); setError(null);
    try {
      await startNuclei(itemId, {
        bbox: whole ? null : copilotRoi,
        seg_hash: whole ? segRow?.art_hash : null,
      });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Stopping is cooperative: the worker finishes the core it is on, so this returns while the job
  // is still running. Refreshing straight away is what turns the button into "Stopping…".
  const stop = async () => {
    if (!itemId || !artHash) return;
    setBusy(true); setError(null);
    try { await cancelNuclei(itemId, artHash); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!itemId) return <div className="mk-empty">Open a slide to segment its nuclei.</div>;

  return (
    <div className="mk-panel">
      {/* ── build ────────────────────────────────────────────────────────── */}
      <div className="mk-section">
        <div className="mk-row">
          <span className="mk-label">Nuclei</span>
          <span className={`mk-state ${row?.status || 'none'}`}>{describeStage(row)}</span>
        </div>
        {isRunning(row) && (
          <div className="mk-bar"><div style={{ width: `${progressPercent(row)}%` }} /></div>
        )}

        <div className="mk-roi">
          {awaitingRoi && (
            <button type="button" className="mk-roi-draw wide awaiting" onClick={cancelRoi}>
              Drag a box on the slide — click to cancel
            </button>
          )}
          {!awaitingRoi && copilotRoi && (
            <>
              <button
                type="button" className="mk-roi-chip" onClick={showRoi}
                title="Bring this region back into view"
              >
                <RectIcon />{formatRoi(copilotRoi)}
              </button>
              <button type="button" className="mk-roi-x" onClick={clearRoi}
                      title="Clear the region">✕</button>
              <button type="button" className="mk-roi-draw" onClick={drawRoi}>Redraw</button>
            </>
          )}
          {!awaitingRoi && !copilotRoi && (
            <button type="button" className="mk-roi-draw wide" onClick={drawRoi}>
              Draw a region
            </button>
          )}
        </div>

        <div className="mk-actions">
          <button
            type="button" className="mk-btn"
            disabled={busy || isRunning(row) || !copilotRoi}
            title={copilotRoi ? '' : 'Draw a region first — the button above frames one'}
            onClick={() => run(false)}
          >
            {busy ? 'Starting…' : startLabel(row, false)}
          </button>
          <button
            type="button" className="mk-btn"
            disabled={busy || isRunning(row) || !segRow}
            title={segRow ? '' : 'Segment the slide first — the run needs to know where the '
                              + 'tissue is, and every core of a slide that is mostly glass is '
                              + 'hours of GPU spent finding nothing'}
            onClick={() => run(true)}
          >
            {startLabel(row, true)}
          </button>
          {isRunning(row) && (
            <button
              type="button" className="mk-btn mk-btn-stop"
              disabled={busy || !canStop(row)}
              title={
                'Stops after the tile it is on. What is already computed is kept, and starting '
                + 'again resumes from there.'
              }
              onClick={stop}
            >
              {isStopping(row) ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
        {isRunning(row) && (
          <div className="mk-note mk-dim">
            This build holds the nuclei worker until it finishes — other nuclei jobs queue behind
            it. Stopping keeps everything already computed.
          </div>
        )}
        {!segRow && (
          <div className="mk-note mk-dim">
            A whole-slide run needs a tissue segmentation; a drawn region does not.
          </div>
        )}
      </div>

      {/* The stored counts, the class list and the mask's controls used to sit here. They belong
          to the artifact, so they open inside its row in the Workspace now (Inc 6 · 04) — with a
          swatch and an eye per class instead of a checkbox, and the same numbers off the same
          meta. This pointer stays until the tab does. */}
      {artHash && (
        <div className="mk-note mk-dim">
          What this build stored — counts by class, coverage, the mask’s opacity and colouring —
          opens on its row in the Workspace.
        </div>
      )}

      <div className="mk-foot">
        Predicted nucleus outlines and PanNuke classes from H&amp;E. The polygons are what is
        stored; the mask is drawn from them, so the shape on screen and the count above are the
        same object. Research use only.
      </div>

      {error && <div className="mk-error">{error}</div>}
    </div>
  );
}

function RectIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="1" strokeDasharray="4 3" />
    </svg>
  );
}
