// src/components/panels/MarkersPanel.jsx — the virtual-mIF / phenotype map (Inc 3b).
//
// Deliberately independent of the copilot conversation: this is an imaging modality you switch on,
// not something an agent has to be asked for. It drives the biomarker service's own job/artifact
// control plane and mounts the resulting tile pyramid on the viewer.
//
// Three mutually exclusive modes (D8) — H&E, Markers, Phenotype — because a marker composite and a
// phenotype map are both dense, saturated pictures and stacking them makes neither readable.
//
// Everything scientific is honest by construction: the marker vocabulary, presets, palette and
// near-equivalent labels all come from the service (GET /biomarker/catalog), and every number
// shown is a **predicted marker-positivity probability**, slide-relative, research use only.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts, startSegment } from '../../api/preprocessApi.js';
import { getBiomarkerMeta, getCatalog, startBiomarker } from '../../api/biomarkerApi.js';
import {
  removeMarkerLayers, setBackdrop, setBaseOpacity, syncMarkerLayer,
} from '../viewer/markerLayers.js';
import {
  DAPI_WEIGHT, DEFAULT_DISPLAY, FALLBACK_PRESET, MODES, MODE_LABEL,
  coverageSummary, describeStage, findBiomarkerRow, findReadySegmentation, isRunning,
  layerSignature, markerLabel, phenotypeLegend, presetChannels, presetNames, separableMarkers,
  tileParams,
} from './markerUtils.js';

const POLL_MS = 2500;
const LAYER_FOR = { markers: 'markers', pheno: 'pheno' };

export default function MarkersPanel() {
  const activeItem = useStore((s) => s.activeItem);
  const viewer = useStore((s) => s.viewer);
  const copilotRoi = useStore((s) => s.copilotRoi);
  const itemId = activeItem?._id || null;

  const [catalog, setCatalog] = useState(null);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState('he');
  const [preset, setPreset] = useState(FALLBACK_PRESET);
  const [channels, setChannels] = useState([]);
  const [display, setDisplay] = useState({ ...DEFAULT_DISPLAY });
  const [dapiOn, setDapiOn] = useState(true);
  const [dapiW, setDapiW] = useState(DAPI_WEIGHT);
  const [hidden, setHidden] = useState({});          // lineage → hidden?
  const [heFade, setHeFade] = useState(0);           // H&E opacity under a data layer

  const mountedSig = useRef(null);
  const pollRef = useRef(null);

  const bioRow = findBiomarkerRow(rows);
  const segRow = findReadySegmentation(rows);
  const artHash = bioRow?.status === 'ready' || bioRow?.progress > 0 ? bioRow?.art_hash : null;

  // ── data ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    getCatalog()
      .then((c) => { if (live) { setCatalog(c); setChannels(presetChannels(c, FALLBACK_PRESET)); } })
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
  const shownLineages = useMemo(
    () => phenotypeLegend(meta).map((l) => l.name).filter((n) => !hidden[n]),
    [meta, hidden],
  );
  const allShown = phenotypeLegend(meta).every((l) => !hidden[l.name]);

  const params = useMemo(() => tileParams(mode, {
    channels,
    display,
    dapi: dapiOn ? (catalog?.dapi_color || '808080') : null,
    dapiWeight: dapiW,
    // omit `show` when nothing is filtered — a shorter URL is a better cache key
    show: allShown ? null : shownLineages,
  }), [mode, channels, display, dapiOn, dapiW, catalog, allShown, shownLineages]);

  const signature = layerSignature(mode, artHash, params);

  useEffect(() => {
    if (!viewer) return;
    mountedSig.current = syncMarkerLayer(viewer, {
      signature, mounted: mountedSig.current,
      itemId, artHash, layer: LAYER_FOR[mode] || null, meta, params,
    });
    // "Remove the H&E background" is the base layer's opacity, not a separate black rectangle.
    setBaseOpacity(viewer, mode === 'he' ? 1 : heFade);
    setBackdrop(viewer, mode === 'he' ? '' : '#000');
  }, [viewer, signature, itemId, artHash, mode, meta, params, heFade]);

  // Leaving the panel (or the slide) must not leave a map stranded on the viewer.
  useEffect(() => () => {
    if (!viewer) return;
    removeMarkerLayers(viewer);
    setBaseOpacity(viewer, 1);
    setBackdrop(viewer, '');
  }, [viewer]);

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
      {/* ── mode ─────────────────────────────────────────────────────────── */}
      <div className="mk-modes">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={`mk-mode ${mode === m ? 'active' : ''}`}
            disabled={m !== 'he' && !artHash}
            title={m !== 'he' && !artHash ? 'Build the map first' : ''}
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
                onChange={() => setHidden((h) => ({ ...h, [l.name]: !h[l.name] }))}
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

      {(mode !== 'he') && (
        <div className="mk-foot">
          Predicted marker-positivity probability from H&amp;E — not a stain, not a measurement.
          Positivity is relative to this slide. Research use only.
        </div>
      )}

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
