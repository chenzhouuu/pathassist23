// src/components/panels/NucleiPanel.jsx — nuclei as a stored artifact (Inc 5, ticket 05).
//
// Shaped like the Tissue panel, because it drives the same kind of thing: a service's own
// job/artifact control plane, over a region you draw. What it does not do is mount a layer —
// there is no picture yet. Ticket 06 rasterises the rings this build stores and gives the row an
// eye in the Workspace; 07 makes it whole-slide, stoppable and resumable.
//
// Every number here is read back from the artifact's meta, not kept from the call that made it.
// That is the point of the ticket: reload the page and the same counts come back, because they
// came off disk.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts } from '../../api/preprocessApi.js';
import { getNucleiMeta, startNuclei } from '../../api/nucleiApi.js';
import {
  classRows, describeStage, findNucleiRow, formatArea, formatCount, formatPercent, isRunning,
  progressPercent, summaryLine, totalNuclei,
} from './nucleiUtils.js';
import { formatRoi, useRegionSelect } from './useRegionSelect.js';

const POLL_MS = 2500;

export default function NucleiPanel() {
  const activeItem = useStore((s) => s.activeItem);
  const { roi: copilotRoi, awaiting: awaitingRoi, start: drawRoi, cancel: cancelRoi,
          clear: clearRoi, show: showRoi } = useRegionSelect();
  const itemId = activeItem?._id || null;

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const row = findNucleiRow(rows);
  const artHash = row?.art_hash || null;

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); setMeta(null); return; }
    const next = await listArtifacts(itemId);
    setRows(next);
    const r = findNucleiRow(next);
    if (r?.art_hash) {
      try { setMeta(await getNucleiMeta(itemId, r.art_hash)); } catch { /* nothing stored yet */ }
    } else {
      setMeta(null);
    }
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

  const run = async () => {
    if (!itemId || !copilotRoi) return;
    setBusy(true); setError(null);
    try {
      await startNuclei(itemId, { bbox: copilotRoi });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!itemId) return <div className="mk-empty">Open a slide to segment its nuclei.</div>;

  const summary = meta?.summary || null;
  const classes = classRows(summary);
  const n = totalNuclei(summary);

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
            onClick={run}
          >
            {busy ? 'Starting…' : 'Run on region'}
          </button>
        </div>
        <div className="mk-note">
          Whole-slide runs are not built yet — they need the tissue mask to know where to look.
        </div>
      </div>

      {/* ── what is stored ───────────────────────────────────────────────── */}
      {artHash && (
        <div className="mk-section">
          <div className="mk-row">
            <span className="mk-label">Stored</span>
            <span className="mk-dim">{summaryLine(summary) || 'nothing yet'}</span>
          </div>
          {n > 0 && (
            <>
              <div className="mk-row">
                <span className="mk-label">Nuclei</span>
                <span className="mk-count">{formatCount(n)}</span>
              </div>
              {formatArea(summary) && (
                <div className="mk-row">
                  <span className="mk-label">Area</span>
                  <span className="mk-count">{formatArea(summary)}</span>
                </div>
              )}
              {classes.map((c) => (
                <div key={c.name} className="mk-row">
                  <span className="mk-label">{c.name}</span>
                  <span className="mk-count">
                    {formatCount(c.count)} · {formatPercent(c.fraction)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="mk-foot">
        Predicted nucleus outlines and PanNuke classes from H&amp;E. The polygons are what is
        stored; anything drawn from them is drawn from these numbers. Research use only.
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
