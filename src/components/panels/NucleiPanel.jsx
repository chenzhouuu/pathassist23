// src/components/panels/NucleiPanel.jsx — nuclei as a stored artifact (Inc 5, ticket 05).
//
// Shaped like the Tissue panel, because it drives the same kind of thing: a service's own
// job/artifact control plane, over a region you draw. It does not mount the mask — ArtifactLayers
// does, for as long as the slide is open — but it tunes it, because these controls have to outlive
// a tab switch and the layer does. Ticket 07 makes the build whole-slide, stoppable and resumable.
//
// Every number here is read back from the artifact's meta, not kept from the call that made it.
// That is the point: reload the page and the same counts come back, because they came off disk.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts } from '../../api/preprocessApi.js';
import { getNucleiMeta, startNuclei } from '../../api/nucleiApi.js';
import {
  classRows, colorsOf, describeStage, findNucleiRow, formatArea, formatCount, formatPercent,
  isRunning, layerLevels, progressPercent, summaryLine, totalNuclei, withNucleiDefaults,
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

  // The layer's own settings live in the store, not here: the mask keeps rendering while this
  // panel is closed, and the right panel unmounts a panel on every tab switch.
  const storedLayer = useStore((s) => s.nucleiLayerParams);
  const setNucleiLayerParams = useStore((s) => s.setNucleiLayerParams);
  const visibleArtifacts = useStore((s) => s.visibleArtifacts);

  const row = findNucleiRow(rows);
  const artHash = row?.art_hash || null;
  const layer = withNucleiDefaults(storedLayer);
  const drawn = layerLevels(meta) > 0;
  const shownOnSlide = !!artHash && visibleArtifacts[artHash]?.kind === 'nuclei';

  const toggleHidden = (name) =>
    setNucleiLayerParams({ hidden: { ...layer.hidden, [name]: !layer.hidden[name] } });

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
  // The palette comes off the artifact, so a swatch here and the mask on the slide can never
  // disagree about what colour a class is.
  const palette = colorsOf(meta);

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
              {/* A checkbox hides a class from the *picture*. Its count stays on screen either
                  way — hiding a class from the map must not hide it from the maths. */}
              {classes.map((c) => (
                <label key={c.name} className="mk-check">
                  <input
                    type="checkbox" checked={!layer.hidden[c.name]} disabled={!drawn}
                    onChange={() => toggleHidden(c.name)}
                  />
                  <span className="mk-swatch" style={{ background: palette[c.name] || '#888' }} />
                  {c.name}
                  <span className="mk-count">
                    {formatCount(c.count)} · {formatPercent(c.fraction)}
                  </span>
                </label>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── the mask ─────────────────────────────────────────────────────── */}
      {drawn && (
        <div className="mk-section">
          <div className="mk-row">
            <span className="mk-label">Mask</span>
            <span className="mk-dim">
              {shownOnSlide ? 'on the slide' : 'switch it on from the Workspace'}
            </span>
          </div>
          <Slider
            label="Opacity" min={0.05} max={1} value={layer.opacity}
            onChange={(v) => setNucleiLayerParams({ opacity: v })}
          />
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

function Slider({ label, value, min, max, onChange }) {
  return (
    <div className="mk-slider">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={0.01} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em>{Number(value).toFixed(2)}</em>
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
