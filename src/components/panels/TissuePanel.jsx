// src/components/panels/TissuePanel.jsx — the dense tissue-class map (Inc 4, Route B).
//
// Deliberately independent of the copilot conversation, like the Markers panel: this is an imaging
// modality you switch on. It drives the tissue service's own job/artifact control plane and mounts
// the resulting class/probability pyramid on the viewer.
//
// Unlike Inc 3b's three mutually exclusive modes, this layer **stacks** (D4). Tissue is areal and
// sits under the marker and phenotype layers, so "cytotoxic T cells inside the tumour region" is a
// picture you can actually look at.
//
// The class list, palette, provenance and licence all come from the service (GET /tissue/catalog
// and the artifact's own meta), so the UI never claims a class the deployed backend does not
// predict, and a recolour can never drift from what the map was rasterised with.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts, startSegment } from '../../api/preprocessApi.js';
import {
  cancelTissue, getTissueCatalog, getTissueMeta, getTissueStats, startTissue, tileAjaxHeaders,
  tileUrl,
} from '../../api/tissueApi.js';
import {
  buildTileSource, removeLayer, setBasePreference, syncLayer,
} from '../viewer/overlayLayers.js';
import {
  DEFAULT_CONF_FLOOR, DEFAULT_HIDDEN, DEFAULT_OPACITY, LAYER_FOR_RENDER, RENDERS, RENDER_LABEL,
  backendNames, canStop, classesOf, colorsOf, compositionCsv, compositionRows, coverageSummary,
  describeStage, findReadySegmentation, findTissueRow, formatPercent, isRunning, isStopped,
  isStopping, layerLevels, layerSignature, levelOffsetFor, startLabel, tileParams, tsrOf,
} from './tissueUtils.js';
import { formatRoi, useRegionSelect } from './useRegionSelect.js';

const POLL_MS = 2500;

export default function TissuePanel() {
  const activeItem = useStore((s) => s.activeItem);
  const viewer = useStore((s) => s.viewer);
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

  const [on, setOn] = useState(true);
  const [render, setRender] = useState('classes');
  const [backend, setBackend] = useState(null);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [conf, setConf] = useState(true);
  const [confFloor, setConfFloor] = useState(DEFAULT_CONF_FLOOR);
  const [hidden, setHidden] = useState(() => Object.fromEntries(
    DEFAULT_HIDDEN.map((n) => [n, true]),
  ));
  const [heFade, setHeFade] = useState(1);       // tissue is translucent, so the H&E stays by default
  const [roiStats, setRoiStats] = useState(null);

  const mountedSig = useRef(null);
  const pollRef = useRef(null);

  const row = findTissueRow(rows);
  const segRow = findReadySegmentation(rows);
  // The artifact's identity, which exists from the moment a build is enqueued. Deliberately not
  // gated on status: a just-queued build reports progress 0, and gating here left Stop with
  // nothing to address and unmounted a map that was already on screen. What the overlay needs is
  // `meta`, which only exists once there is something to draw — that is the guard, below.
  const artHash = row?.art_hash || null;

  const classes = useMemo(() => classesOf(meta, catalog, backend), [meta, catalog, backend]);
  const colors = useMemo(() => colorsOf(meta, catalog, backend), [meta, catalog, backend]);
  const shown = useMemo(() => classes.filter((c) => !hidden[c]), [classes, hidden]);

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
  const layer = LAYER_FOR_RENDER[render];
  const params = useMemo(() => tileParams(render, {
    show: shown, opacity: 1, conf, confFloor, classes,
  }), [render, shown, conf, confFloor, classes]);

  const visible = on && !!artHash && !!meta;
  const signature = visible ? layerSignature(render, artHash, params) : 'none';

  useEffect(() => {
    if (!viewer) return;
    if (!visible) {
      removeLayer(viewer, 'tissue');
      mountedSig.current = 'none';
      setBasePreference(viewer, 'tissue', null);
      return;
    }
    const tileSource = buildTileSource({
      slideWidth: meta?.slide?.width,
      slideHeight: meta?.slide?.height,
      levelOffset: levelOffsetFor(meta, layer),
      levels: layerLevels(meta, layer),
      tileUrlFor: (level, x, y) => tileUrl(itemId, artHash, layer, level, x, y, params),
    });
    mountedSig.current = syncLayer(viewer, {
      key: 'tissue', signature, mounted: mountedSig.current, tileSource,
      // Layer opacity, not a tile parameter: dragging the slider must not refetch a single tile.
      opacity, ajaxHeaders: tileAjaxHeaders(),
    });
    setBasePreference(viewer, 'tissue', heFade >= 1 ? null : { opacity: heFade });
  }, [viewer, visible, signature, itemId, artHash, layer, meta, params, opacity, heFade]);

  // Leaving the panel (or the slide) must not leave a map stranded on the viewer.
  useEffect(() => () => {
    if (!viewer) return;
    removeLayer(viewer, 'tissue');
    setBasePreference(viewer, 'tissue', null);
  }, [viewer]);

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

      {/* ── the overlay ──────────────────────────────────────────────────── */}
      {artHash && (
        <div className="mk-section">
          <label className="mk-check">
            <input type="checkbox" checked={on} onChange={() => setOn((v) => !v)} />
            Show tissue overlay
          </label>

          <div className="mk-modes">
            {RENDERS.map((r) => (
              <button
                key={r}
                type="button"
                className={`mk-mode ${render === r ? 'active' : ''}`}
                disabled={!on}
                onClick={() => setRender(r)}
              >
                {RENDER_LABEL[r]}
              </button>
            ))}
          </div>

          <Slider label="Opacity" value={opacity} min={0} max={1} disabled={!on}
                  onChange={setOpacity} />
          {render === 'classes' && (
            <>
              <label className="mk-check">
                <input type="checkbox" checked={conf} disabled={!on}
                       onChange={() => setConf((v) => !v)} />
                Alpha follows confidence
              </label>
              {conf && (
                <Slider label="Faintest" value={confFloor} min={0} max={1} disabled={!on}
                        onChange={setConfFloor} />
              )}
            </>
          )}
          <Slider label="H&amp;E under" value={heFade} min={0} max={1} disabled={!on}
                  onChange={setHeFade} />
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
                disabled={!on}
                onChange={() => setHidden((h) => ({ ...h, [c.name]: !h[c.name] }))}
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
