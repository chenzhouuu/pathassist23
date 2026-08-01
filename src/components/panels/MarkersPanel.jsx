// src/components/panels/MarkersPanel.jsx — the virtual-mIF / phenotype map (Inc 3b).
//
// Deliberately independent of the copilot conversation: this is an imaging modality you switch on,
// not something an agent has to be asked for. It drives the biomarker service's own job/artifact
// control plane and holds the parameters its tile pyramid is drawn with.
//
// It does not mount the pyramid — ArtifactLayers does, from the Workspace's eye (Inc 5 · 03b). This
// panel unmounts on every tab switch, so a layer it owned could not survive the click that turned
// it on. The parameters live in the store for the same reason: the picture outlives the controls.
//
// Two mutually exclusive modes (D8) — Markers, Phenotype — because a marker composite and a
// phenotype map are both dense, saturated pictures and stacking them makes neither readable. The
// third used to be 'H&E', which only ever meant "no data layer"; the eye says that now.
//
// Everything scientific is honest by construction: the marker vocabulary, presets, palette and
// near-equivalent labels all come from the service (GET /biomarker/catalog), and every number
// shown is a **predicted marker-positivity probability**, slide-relative, research use only.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts, startSegment } from '../../api/preprocessApi.js';
import { getBiomarkerMeta, getCatalog, startBiomarker } from '../../api/biomarkerApi.js';
import {
  MODES, MODE_LABEL,
  coverageSummary, describeStage, findBiomarkerRow, findReadySegmentation, isRunning,
  markerLabel, phenotypeLegend, presetChannels, presetNames, separableMarkers, withMarkerDefaults,
} from './markerUtils.js';

const POLL_MS = 2500;

export default function MarkersPanel() {
  const activeItem = useStore((s) => s.activeItem);
  const copilotRoi = useStore((s) => s.copilotRoi);
  const itemId = activeItem?._id || null;

  const [catalog, setCatalog] = useState(null);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The render parameters live in the store (Inc 5 · 03b): the layer outlives this panel, so its
  // settings have to as well. `set` patches, `withMarkerDefaults` fills — one home for the defaults.
  const markerLayerParams = useStore((s) => s.markerLayerParams);
  const setMarkerLayerParams = useStore((s) => s.setMarkerLayerParams);
  const { mode, preset, display, dapiOn, dapiW, hidden, heFade } =
    withMarkerDefaults(markerLayerParams);
  // Null means "whatever this preset says", so the layer draws correctly before anyone has picked
  // channels. Resolved the same way here and in ArtifactLayers, from the same catalog.
  const channels = markerLayerParams.channels || presetChannels(catalog, preset);
  const setMode = (v) => setMarkerLayerParams({ mode: v });
  const setDisplay = (fn) => setMarkerLayerParams({ display: fn(display) });
  const setDapiOn = (v) => setMarkerLayerParams({ dapiOn: v });
  const setDapiW = (v) => setMarkerLayerParams({ dapiW: v });
  const setHeFade = (v) => setMarkerLayerParams({ heFade: v });
  const toggleLineage = (name) => setMarkerLayerParams({ hidden: { ...hidden, [name]: !hidden[name] } });
  const setChannels = (fn) => setMarkerLayerParams({
    channels: typeof fn === 'function' ? fn(channels) : fn,
  });

  const pollRef = useRef(null);

  const bioRow = findBiomarkerRow(rows);
  const segRow = findReadySegmentation(rows);
  const artHash = bioRow?.status === 'ready' || bioRow?.progress > 0 ? bioRow?.art_hash : null;

  // Whether the Workspace has this artifact on the slide. Read-only here — the panel reports the
  // state, it does not own it, and the controls stay live either way so a picture can be set up
  // before it is switched on.
  const shownFromWorkspace = useStore((s) => !!s.visibleArtifacts[artHash]);

  // ── data ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    getCatalog()
      .then((c) => { if (live) setCatalog(c); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); setMeta(null); return []; }
    const next = await listArtifacts(itemId);
    setRows(next);
    const row = findBiomarkerRow(next);
    if (row?.art_hash) {
      try { setMeta(await getBiomarkerMeta(itemId, row.art_hash)); } catch { /* not built yet */ }
    } else {
      setMeta(null);
    }
    return next;
  }, [itemId]);

  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);

  // Poll only while something is actually building.
  useEffect(() => {
    if (!isRunning(bioRow)) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return undefined;
    }
    pollRef.current = setInterval(() => { refresh().catch(() => {}); }, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  }, [bioRow?.status, refresh]);

  // ── the picture ───────────────────────────────────────────────────────────────
  // Mounting the pyramid is not this panel's job any more (Inc 5 · 03b). The Workspace's eye says
  // whether the layer is on screen and ArtifactLayers draws it, from the parameters above.

  // ── actions ───────────────────────────────────────────────────────────────────
  const run = async (whole) => {
    if (!itemId || !segRow) return;
    setBusy(true); setError(null);
    try {
      await startBiomarker(itemId, {
        seg_hash: segRow.art_hash,
        bbox: whole ? null : copilotRoi,
      });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const runSegmentation = async () => {
    setBusy(true); setError(null);
    try { await startSegment(itemId); await refresh(); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const applyPreset = (name) => {
    setPreset(name);
    setChannels(presetChannels(catalog, name));
  };
  const toggleChannel = (marker) => setChannels((cs) => cs.map(
    (c) => (c.marker === marker ? { ...c, enabled: c.enabled === false } : c),
  ));
  const recolour = (marker, color) => setChannels((cs) => cs.map(
    (c) => (c.marker === marker ? { ...c, color } : c),
  ));
  const addChannel = (marker) => setChannels((cs) => (
    cs.some((c) => c.marker === marker) ? cs
      : [...cs, { marker, color: '#ffffff', enabled: true }]));

  if (!itemId) return <div className="mk-empty">Open a slide to build its marker map.</div>;

  const legend = phenotypeLegend(meta);
  const separable = separableMarkers(meta);
  const cov = coverageSummary(meta);

  return (
    <div className="mk-panel">
      {/* ── which picture ────────────────────────────────────────────────── */}
      <div className="mk-row">
        <span className="mk-label">Appearance</span>
        <span className="mk-dim">
          {shownFromWorkspace ? 'On the slide' : 'Switch it on in Workspace'}
        </span>
      </div>
      <div className="mk-modes">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={`mk-mode ${mode === m ? 'active' : ''}`}
            disabled={!artHash}
            title={artHash ? '' : 'Build the map first'}
            onClick={() => setMode(m)}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {/* ── build ────────────────────────────────────────────────────────── */}
      <div className="mk-section">
        <div className="mk-row">
          <span className="mk-label">Map</span>
          <span className={`mk-state ${bioRow?.status || 'none'}`}>{describeStage(bioRow)}</span>
        </div>
        {isRunning(bioRow) && (
          <div className="mk-bar"><div style={{ width: `${(bioRow.progress || 0) * 100}%` }} /></div>
        )}
        {!segRow && (
          <div className="mk-note">
            This slide has no tissue segmentation yet — the map needs one to know where the tissue
            is and to sample slide-wide thresholds.
            <button type="button" className="mk-btn" disabled={busy} onClick={runSegmentation}>
              Run tissue segmentation
            </button>
          </div>
        )}
        {segRow && (
          <div className="mk-actions">
            <button
              type="button" className="mk-btn"
              disabled={busy || isRunning(bioRow) || !copilotRoi}
              title={copilotRoi ? '' : 'Draw a region on the slide first'}
              onClick={() => run(false)}
            >
              Analyse region
            </button>
            <button
              type="button" className="mk-btn"
              disabled={busy || isRunning(bioRow)}
              onClick={() => run(true)}
            >
              Analyse whole slide
            </button>
          </div>
        )}
        {cov && (
          <div className="mk-note mk-dim">
            Covered {cov.tiles} tile{cov.tiles === 1 ? '' : 's'} · {cov.mm2} mm²
            {meta?.summary?.n_cells ? ` · ${meta.summary.n_cells.toLocaleString()} cells` : ''}
          </div>
        )}
      </div>

      {/* ── markers mode ─────────────────────────────────────────────────── */}
      {mode === 'markers' && artHash && (
        <div className="mk-section">
          <div className="mk-row">
            <span className="mk-label">Panel</span>
            <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {presetNames(catalog).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <label className="mk-check">
            <input type="checkbox" checked={dapiOn} onChange={() => setDapiOn((v) => !v)} />
            <span className="mk-swatch" style={{ background: '#808080' }} />
            DAPI (nuclear reference)
          </label>
          {dapiOn && (
            <Slider label="DAPI weight" value={dapiW} min={0} max={1} onChange={setDapiW} />
          )}

          {channels.map((c) => (
            <label key={c.marker} className="mk-check">
              <input
                type="checkbox" checked={c.enabled !== false}
                onChange={() => toggleChannel(c.marker)}
              />
              <input
                type="color" value={c.color} className="mk-color"
                onChange={(e) => recolour(c.marker, e.target.value)}
              />
              <span className={separable.length && !separable.includes(c.marker) ? 'mk-dim' : ''}>
                {markerLabel(catalog, c.marker)}
              </span>
            </label>
          ))}

          <details className="mk-more">
            <summary>Add another marker</summary>
            <div className="mk-chips">
              {(catalog?.markers || [])
                .filter((m) => !channels.some((c) => c.marker === m))
                .map((m) => (
                  <button key={m} type="button" className="mk-chip" onClick={() => addChannel(m)}>
                    {m}
                  </button>
                ))}
            </div>
          </details>

          <Slider label="Low" value={display.lo} min={0} max={1}
                  onChange={(v) => setDisplay((d) => ({ ...d, lo: v }))} />
          <Slider label="High" value={display.hi} min={0} max={1}
                  onChange={(v) => setDisplay((d) => ({ ...d, hi: v }))} />
          <Slider label="Gamma" value={display.gamma} min={0.2} max={2}
                  onChange={(v) => setDisplay((d) => ({ ...d, gamma: v }))} />
          <Slider label="H&E under" value={heFade} min={0} max={1} onChange={setHeFade} />
        </div>
      )}

      {/* ── phenotype mode ───────────────────────────────────────────────── */}
      {mode === 'pheno' && artHash && (
        <div className="mk-section">
          {legend.length === 0 && <div className="mk-note">No phenotyped cells in the map yet.</div>}
          {legend.map((l) => (
            <label key={l.name} className="mk-check">
              <input
                type="checkbox" checked={!hidden[l.name]}
                onChange={() => toggleLineage(l.name)}
              />
              <span
                className="mk-swatch"
                style={{ background: catalog?.phenotype_colors?.[l.name] || '#888' }}
              />
              {l.name}
              <span className="mk-count">{l.count.toLocaleString()}</span>
            </label>
          ))}
          <Slider label="H&E under" value={heFade} min={0} max={1} onChange={setHeFade} />
        </div>
      )}

      <div className="mk-foot">
        Predicted marker-positivity probability from H&amp;E — not a stain, not a measurement.
        Positivity is relative to this slide. Research use only.
      </div>

      {error && <div className="mk-error">{error}</div>}
    </div>
  );
}

function Slider({ label, value, min, max, onChange }) {
  return (
    <div className="mk-slider">
      <span className="mk-label">{label}</span>
      <input
        type="range" min={min} max={max} step={0.01} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="mk-val">{Number(value).toFixed(2)}</span>
    </div>
  );
}
