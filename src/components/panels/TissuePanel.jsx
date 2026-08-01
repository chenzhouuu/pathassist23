// src/components/panels/TissuePanel.jsx — the dense tissue-class map (Inc 4, Route B).
//
// Deliberately independent of the copilot conversation, like the Markers panel: this is an imaging
// modality you switch on. It drives the tissue service's own job/artifact control plane and holds
// the parameters its class/probability pyramid is drawn with.
//
// It does not mount the pyramid — ArtifactLayers does, from the Workspace's eye (Inc 5 · 03a). This
// panel unmounts on every tab switch, so a layer it owned could not survive the click that turned
// it on. What stayed here is what a panel is for: the controls.
//
// Unlike Inc 3b's three mutually exclusive modes, this layer **stacks** (D4). Tissue is areal and
// sits under the marker and phenotype layers, so "cytotoxic T cells inside the tumour region" is a
// picture you can actually look at.
//
// The class list, palette, provenance and licence all come from the service (GET /tissue/catalog
// and the artifact's own meta), so the UI never claims a class the deployed backend does not
// predict, and a recolour can never drift from what the map was rasterised with.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts, startSegment } from '../../api/preprocessApi.js';
import {
  cancelTissue, getTissueCatalog, getTissueMeta, getTissueStats, startTissue,
} from '../../api/tissueApi.js';
import {
  RENDERS, RENDER_LABEL,
  backendNames, canStop, compositionCsv, compositionRows, coverageSummary,
  describeStage, findReadySegmentation, findTissueRow, formatPercent, isRunning, isStopped,
  isStopping, startLabel, tsrOf, withTissueDefaults,
} from './tissueUtils.js';
import { formatRoi, useRegionSelect } from './useRegionSelect.js';

const POLL_MS = 2500;

export default function TissuePanel() {
  const activeItem = useStore((s) => s.activeItem);
  // The region is shared app state, but this panel can now ask for one itself instead of
  // depending on the user having drawn a box in the Copilot tab first.
  const { roi: copilotRoi, awaiting: awaitingRoi, start: drawRoi, cancel: cancelRoi,
          clear: clearRoi, show: showRoi } = useRegionSelect();
  const itemId = activeItem?._id || null;

  const [catalog, setCatalog] = useState(null);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [backend, setBackend] = useState(null);
  const [roiStats, setRoiStats] = useState(null);

  // The render parameters live in the store (Inc 5 · 03a): the layer outlives this panel, so its
  // settings have to as well. `set` patches, `withTissueDefaults` fills — one home for the defaults.
  const tissueLayerParams = useStore((s) => s.tissueLayerParams);
  const setTissueLayerParams = useStore((s) => s.setTissueLayerParams);
  const { render, opacity, conf, confFloor, hidden, heFade } = withTissueDefaults(tissueLayerParams);
  const setRender = (v) => setTissueLayerParams({ render: v });
  const setOpacity = (v) => setTissueLayerParams({ opacity: v });
  const setConf = (v) => setTissueLayerParams({ conf: v });
  const setConfFloor = (v) => setTissueLayerParams({ confFloor: v });
  const setHeFade = (v) => setTissueLayerParams({ heFade: v });
  const toggleHidden = (name) => setTissueLayerParams({ hidden: { ...hidden, [name]: !hidden[name] } });

  const pollRef = useRef(null);

  const row = findTissueRow(rows);
  const segRow = findReadySegmentation(rows);
  // The artifact's identity, which exists from the moment a build is enqueued. Deliberately not
  // gated on status: a just-queued build reports progress 0, and gating here left Stop with
  // nothing to address and unmounted a map that was already on screen. What the overlay needs is
  // `meta`, which only exists once there is something to draw — that is the guard, below.
  const artHash = row?.art_hash || null;

  // Whether the Workspace has this artifact on the slide. Read-only here — the panel reports the
  // state, it does not own it, and the appearance controls stay live either way so a map can be
  // set up before it is switched on.
  const shownFromWorkspace = useStore((s) => !!s.visibleArtifacts[artHash]);

  // ── data ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    getTissueCatalog()
      .then((c) => { if (live) { setCatalog(c); setBackend(c?.default_backend || null); } })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); setMeta(null); return []; }
    const next = await listArtifacts(itemId);
    setRows(next);
    const r = findTissueRow(next);
    if (r?.art_hash) {
      try { setMeta(await getTissueMeta(itemId, r.art_hash)); } catch { /* not built yet */ }
    } else {
      setMeta(null);
    }
    return next;
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

  // ── the picture ───────────────────────────────────────────────────────────────
  // Mounting the pyramid is not this panel's job any more (Inc 5 · 03a). The Workspace's eye says
  // whether the map is on screen and ArtifactLayers draws it, because this panel unmounts the
  // moment you switch tabs and used to take the map down with it. What is left here is the
  // parameters, which are written to the store so the layer keeps honouring them while the panel
  // is closed.

  // ── actions ───────────────────────────────────────────────────────────────────
  const run = async (whole) => {
    if (!itemId || !segRow) return;
    setBusy(true); setError(null);
    try {
      await startTissue(itemId, {
        seg_hash: segRow.art_hash, bbox: whole ? null : copilotRoi, backend,
      });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Stopping is cooperative: the worker finishes the core tile it is on, so this returns while the
  // job is still running. Refreshing straight away is what turns the button into "Stopping…".
  const stop = async () => {
    if (!itemId || !artHash) return;
    setBusy(true); setError(null);
    try { await cancelTissue(itemId, artHash); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const runSegmentation = async () => {
    setBusy(true); setError(null);
    try { await startSegment(itemId); await refresh(); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const measureRoi = async () => {
    if (!artHash || !copilotRoi) return;
    setError(null);
    try { setRoiStats(await getTissueStats(itemId, artHash, copilotRoi)); }
    catch (e) { setError(e.message); }
  };

  const exportCsv = () => {
    const blob = new Blob([compositionCsv(meta, catalog, backend)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tissue-composition-${itemId}-${artHash || 'none'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!itemId) return <div className="mk-empty">Open a slide to build its tissue map.</div>;

  const cov = coverageSummary(meta);
  const comp = compositionRows(meta, catalog, backend);
  const tsr = tsrOf(meta);
  const roiFrac = roiStats?.fraction || null;

  return (
    <div className="mk-panel">
      {/* ── build ────────────────────────────────────────────────────────── */}
      <div className="mk-section">
        <div className="mk-row">
          <span className="mk-label">Map</span>
          <span className={`mk-state ${row?.status || 'none'}`}>{describeStage(row)}</span>
        </div>
        {isRunning(row) && (
          <div className="mk-bar"><div style={{ width: `${(row.progress || 0) * 100}%` }} /></div>
        )}

        {backendNames(catalog).length > 1 && (
          <div className="mk-row">
            <span className="mk-label">Backend</span>
            <select value={backend || ''} onChange={(e) => setBackend(e.target.value)}>
              {backendNames(catalog).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}

        {!segRow && (
          <div className="mk-note">
            This slide has no tissue segmentation yet — the map needs one to know where the tissue
            is, and to leave everything outside it blank.
            <button type="button" className="mk-btn" disabled={busy} onClick={runSegmentation}>
              Run tissue segmentation
            </button>
          </div>
        )}
        {segRow && (
          <div className="mk-roi">
            {/* While waiting for the drag the prompt is the whole row, whether or not a region
                already exists — the instruction is what matters at that moment. */}
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
        )}
        {segRow && (
          <div className="mk-actions">
            <button
              type="button" className="mk-btn"
              disabled={busy || isRunning(row) || !copilotRoi}
              title={copilotRoi ? '' : 'Draw a region first — the button above frames one'}
              onClick={() => run(false)}
            >
              {startLabel(row, false)}
            </button>
            <button
              type="button" className="mk-btn"
              disabled={busy || isRunning(row)}
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
        )}
        {isRunning(row) && (
          <div className="mk-note mk-dim">
            This build holds the tissue worker until it finishes — other tissue jobs queue behind
            it. Stopping keeps everything already computed.
          </div>
        )}
        {cov && (
          <div className="mk-note mk-dim">
            Covered {cov.tiles} tile{cov.tiles === 1 ? '' : 's'}
            {cov.mm2 != null ? ` · ${cov.mm2} mm²` : ''}
          </div>
        )}
      </div>

      {/* ── how it is drawn ──────────────────────────────────────────────── */}
      {artHash && (
        <div className="mk-section">
          <div className="mk-row">
            <span className="mk-label">Appearance</span>
            <span className="mk-dim">
              {shownFromWorkspace ? 'On the slide' : 'Switch it on in Workspace'}
            </span>
          </div>

          <div className="mk-modes">
            {RENDERS.map((r) => (
              <button
                key={r}
                type="button"
                className={`mk-mode ${render === r ? 'active' : ''}`}
                onClick={() => setRender(r)}
              >
                {RENDER_LABEL[r]}
              </button>
            ))}
          </div>

          <Slider label="Opacity" value={opacity} min={0} max={1} onChange={setOpacity} />
          {render === 'classes' && (
            <>
              <label className="mk-check">
                <input type="checkbox" checked={conf} onChange={() => setConf(!conf)} />
                Alpha follows confidence
              </label>
              {conf && (
                <Slider label="Faintest" value={confFloor} min={0} max={1}
                        onChange={setConfFloor} />
              )}
            </>
          )}
          <Slider label="H&amp;E under" value={heFade} min={0} max={1} onChange={setHeFade} />
        </div>
      )}

      {/* ── composition ──────────────────────────────────────────────────── */}
      {artHash && (
        <div className="mk-section">
          <div className="mk-row">
            <span className="mk-label">Composition</span>
            {tsr != null && <span className="mk-dim">TSR {tsr.toFixed(3)}</span>}
          </div>
          {comp.map((c) => (
            <label key={c.name} className="mk-check">
              <input
                type="checkbox"
                checked={!hidden[c.name]}
                onChange={() => toggleHidden(c.name)}
              />
              <span className="mk-swatch" style={{ background: c.color }} />
              {c.name}
              <span className="mk-count">
                {formatPercent(c.fraction)}
                {c.soft != null && c.fraction != null && Math.abs(c.soft - c.fraction) >= 0.005
                  ? ` (soft ${formatPercent(c.soft)})` : ''}
                {roiFrac ? ` · region ${formatPercent(roiFrac[c.name])}` : ''}
              </span>
            </label>
          ))}
          <div className="mk-actions">
            <button
              type="button" className="mk-btn" disabled={!copilotRoi} onClick={measureRoi}
              title={copilotRoi ? '' : 'Draw a region first — the button above frames one'}
            >
              Measure region
            </button>
            <button type="button" className="mk-btn" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>
      )}

      {error && <div className="mk-error">{error}</div>}

      <div className="mk-foot">
        Predicted tissue classes over the covered area. Research use only.
      </div>
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

function Slider({ label, value, min, max, onChange, disabled }) {
  return (
    <div className="mk-slider">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={0.01} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em>{Number(value).toFixed(2)}</em>
    </div>
  );
}
