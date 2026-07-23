// src/components/panels/PreprocessPanel.jsx
// Preprocess — the panel that builds a slide's Trident feature index (Inc 2b). The user picks an
// encoder + magnification, triggers a build, and watches stage progress; a ready index is what
// Copilot's find_regions searches. The heavy build runs in the preprocess worker's single-consumer
// GPU queue — this panel only enqueues (POST) and polls the durable slide_index rows (GET). Pure
// formatting/matching lives in preprocessUtils.js; this file is the React shell over that + the API.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { listSlideIndex, startPreprocess } from '../../api/preprocessApi.js';
import {
  ENCODERS, SEGMENTERS, MAGS, PATCH_SIZES, DEFAULT_PARAMS,
  encoderLabel, isTextCapable, stageLabel, progressPercent, fmtInt,
  normalizeParams, findMatchingIndex, isInFlight, anyInFlight, describeIndex,
} from './preprocessUtils.js';

const POLL_MS = 2500;

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function PreprocessPanel() {
  const { activeItem } = useStore();
  const itemId = activeItem?._id || null;

  const [form, setForm] = useState({ ...DEFAULT_PARAMS });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const pollRef = useRef(null);

  const params = normalizeParams(form);
  const matched = findMatchingIndex(rows, params);
  const status = describeIndex(matched);

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); return []; }
    const next = await listSlideIndex(itemId);
    setRows(next);
    return next;
  }, [itemId]);

  // Load this slide's indexes on open / slide switch.
  useEffect(() => {
    if (!itemId) { setRows([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    refresh()
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load indexes'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [itemId, refresh]);

  // Poll while any build is in flight; stop as soon as everything settles.
  useEffect(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (!itemId || !anyInFlight(rows)) return undefined;
    pollRef.current = setTimeout(() => { refresh().catch(() => {}); }, POLL_MS);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [rows, itemId, refresh]);

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onBuild = useCallback(async () => {
    if (!itemId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await startPreprocess(itemId, params);
      await refresh();   // pick up the new `queued` row → the poll effect takes over
    } catch (err) {
      setError(err.message || 'Could not start preprocessing');
    } finally {
      setSubmitting(false);
    }
  }, [itemId, submitting, params, refresh]);

  const readyMatch = matched?.status === 'ready';
  const inFlightMatch = isInFlight(matched);
  const textOk = isTextCapable(form.encoder);
  // Ready indexes for OTHER param sets (so the user sees what else this slide already has).
  const otherReady = rows.filter((r) => r !== matched && r.status === 'ready');

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0, overflow: 'hidden', color: 'var(--fg)' }}>
      <style>{PP_CSS}</style>

      <div className="pp-header">
        <span className="pp-mark">▦</span>
        <span className="pp-title">Preprocess</span>
        <span className="pp-spacer" />
        <button className="pp-btn" onClick={() => refresh().catch(() => {})}
          disabled={!itemId || loading} title="Refresh index status">Refresh</button>
      </div>

      <div className="pp-body">
        {!itemId ? (
          <div className="pp-empty"><p>Open a slide to build its feature index.</p></div>
        ) : (
          <>
            <p className="pp-lede">
              Extract a whole-slide feature index so Copilot can <b>search this slide</b> by
              description. Built once per parameter set and reused.
            </p>

            {/* status card for the current parameter set */}
            <div className={`pp-status pp-status--${status.state}`}>
              <div className="pp-status-top">
                <span className="pp-pill" data-state={status.state}>
                  {status.state === 'ready' ? 'Ready'
                    : status.state === 'running' ? 'Building'
                      : status.state === 'failed' ? 'Failed'
                        : status.state === 'none' ? 'None' : status.state}
                </span>
                <span className="pp-status-title">{status.title}</span>
                {readyMatch && matched.updated_at && (
                  <span className="pp-status-time">{relTime(matched.updated_at)}</span>
                )}
              </div>
              <div className="pp-status-detail">{status.detail}</div>
              {inFlightMatch && (
                <div className="pp-bar"><i style={{ width: `${progressPercent(matched)}%` }} /></div>
              )}
              {readyMatch && (
                <div className="pp-ready-note">
                  {isTextCapable(matched.encoder)
                    ? <>🔍 These features power <b>Copilot region search</b> on this slide.</>
                    : <>Image-only index — pick <b>CONCH v1</b> to enable Copilot text search.</>}
                </div>
              )}
            </div>

            {/* config form */}
            <div className="pp-form">
              <label className="pp-field">
                <span className="pp-label">Encoder</span>
                <select className="pp-select" value={form.encoder} onChange={setField('encoder')}
                  disabled={submitting}>
                  {ENCODERS.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}{e.text ? ' · 🔍 text search' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className={`pp-enc-hint ${textOk ? 'is-ok' : 'is-img'}`}>
                {textOk
                  ? 'Text-capable — enables Copilot find_regions search.'
                  : 'Image-only — no text search. Choose CONCH v1 or MUSK for that.'}
              </div>

              <label className="pp-field">
                <span className="pp-label">Magnification</span>
                <select className="pp-select" value={form.mag} onChange={setField('mag')}
                  disabled={submitting}>
                  {MAGS.map((m) => <option key={m} value={m}>{m}×</option>)}
                </select>
              </label>

              <button type="button" className="pp-adv-toggle"
                onClick={() => setAdvancedOpen((v) => !v)}>
                {advancedOpen ? '▾' : '▸'} Advanced
              </button>
              {advancedOpen && (
                <div className="pp-adv">
                  <label className="pp-field">
                    <span className="pp-label">Patch size</span>
                    <select className="pp-select" value={form.patch_size}
                      onChange={setField('patch_size')} disabled={submitting}>
                      {PATCH_SIZES.map((p) => <option key={p} value={p}>{p} px</option>)}
                    </select>
                  </label>
                  <label className="pp-field">
                    <span className="pp-label">Segmenter</span>
                    <select className="pp-select" value={form.segmenter}
                      onChange={setField('segmenter')} disabled={submitting}>
                      {SEGMENTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>

            {/* trigger */}
            {inFlightMatch ? (
              <button className="pp-build" disabled>
                <span className="pp-spin" />{stageLabel(matched.stage)}… {progressPercent(matched)}%
              </button>
            ) : (
              <button className="pp-build" onClick={onBuild}
                disabled={submitting || !itemId}>
                {submitting ? <><span className="pp-spin" />Starting…</>
                  : readyMatch ? 'Rebuild index'
                    : 'Build index'}
              </button>
            )}
            {readyMatch && !inFlightMatch && (
              <div className="pp-already">✓ Already preprocessed for these parameters.</div>
            )}

            {/* other ready indexes on this slide */}
            {otherReady.length > 0 && (
              <div className="pp-others">
                <div className="pp-others-h">Other indexes on this slide</div>
                {otherReady.map((r) => (
                  <div key={r.params_hash || `${r.encoder}-${r.mag}-${r.patch_size}`} className="pp-other">
                    <span className="pp-other-name">
                      {encoderLabel(r.encoder)} @ {r.mag}×
                      {isTextCapable(r.encoder) && <span className="pp-other-tag">🔍</span>}
                    </span>
                    <span className="pp-other-meta">{fmtInt(r.n_patches)} patches</span>
                  </div>
                ))}
              </div>
            )}

            {error && <div className="pp-error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// Scoped styles (prefix `pp-`) — self-contained, theme-var driven, matching the Copilot panel.
const PP_CSS = `
.pp-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.pp-mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;
  background:linear-gradient(160deg,#a78bfa,#7c3aed);color:#fff;font-size:12px;font-weight:700;
  box-shadow:0 0 0 1px rgba(167,139,250,.25),0 2px 8px rgba(124,58,237,.35)}
.pp-title{font-weight:600;font-size:13px;letter-spacing:.2px}
.pp-spacer{margin-left:auto}
.pp-btn{font-size:11px;color:var(--muted);background:transparent;border:1px solid var(--border);
  border-radius:7px;padding:4px 9px;cursor:pointer;transition:background .15s,color .15s}
.pp-btn:hover:not(:disabled){background:rgba(148,163,184,.10);color:var(--fg)}
.pp-btn:disabled{opacity:.4;cursor:default}
.pp-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;
  display:flex;flex-direction:column;gap:12px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
.pp-empty{color:var(--muted);font-size:12.5px;margin-top:6px}
.pp-lede{margin:0;font-size:12px;line-height:1.55;color:var(--muted)}
.pp-lede b{color:#c4b5fd;font-weight:600}

.pp-status{border:1px solid var(--border);border-radius:10px;padding:10px 11px;
  background:var(--surface,#171a26);display:flex;flex-direction:column;gap:7px}
.pp-status--ready{border-color:rgba(52,211,153,.35)}
.pp-status--failed{border-color:rgba(248,113,113,.35)}
.pp-status--running{border-color:rgba(139,92,246,.4)}
.pp-status-top{display:flex;align-items:center;gap:8px}
.pp-pill{font-size:9px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;
  border-radius:6px;padding:2px 7px;color:#0b0c12;background:#64748b}
.pp-pill[data-state="ready"]{background:#34d399}
.pp-pill[data-state="running"]{background:#a78bfa}
.pp-pill[data-state="failed"]{background:#f87171}
.pp-pill[data-state="none"]{background:#475569;color:#cbd5e1}
.pp-status-title{font-size:12.5px;font-weight:600;color:var(--fg);flex:1;min-width:0}
.pp-status-time{font-size:10px;color:var(--muted)}
.pp-status-detail{font-size:11.5px;color:var(--muted);line-height:1.5;word-break:break-word}
.pp-bar{height:5px;border-radius:3px;background:rgba(148,163,184,.18);overflow:hidden}
.pp-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#a78bfa,#7c3aed);
  transition:width .4s ease}
.pp-ready-note{font-size:11px;line-height:1.5;color:#a7f3d0}
.pp-status--ready .pp-ready-note b{color:#6ee7b7}

.pp-form{display:flex;flex-direction:column;gap:9px}
.pp-field{display:flex;flex-direction:column;gap:4px}
.pp-label{font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}
.pp-select{background:var(--bg2,#0d0e14);color:var(--fg);border:1px solid var(--border);
  border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none;cursor:pointer;
  transition:border-color .15s,box-shadow .15s}
.pp-select:focus{border-color:rgba(139,92,246,.6);box-shadow:0 0 0 2px rgba(139,92,246,.15)}
.pp-select:disabled{opacity:.5;cursor:default}
.pp-enc-hint{font-size:10.5px;line-height:1.4;margin-top:-3px}
.pp-enc-hint.is-ok{color:#6ee7b7}
.pp-enc-hint.is-img{color:var(--muted)}
.pp-adv-toggle{align-self:flex-start;font-size:11px;color:var(--muted);background:none;border:none;
  padding:2px 0;cursor:pointer;transition:color .15s}
.pp-adv-toggle:hover{color:#c4b5fd}
.pp-adv{display:flex;flex-direction:column;gap:9px;padding-left:2px;
  border-left:2px solid rgba(139,92,246,.25);margin-left:1px;padding-left:10px}

.pp-build{width:100%;padding:10px;border:none;border-radius:9px;font-size:12.5px;font-weight:600;
  color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:linear-gradient(160deg,#8b5cf6,#7c3aed);transition:transform .12s,box-shadow .15s,opacity .15s}
.pp-build:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.pp-build:disabled{opacity:.6;cursor:default}
.pp-already{font-size:11px;color:#6ee7b7;text-align:center}
.pp-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.35);
  border-top-color:#fff;animation:pp-spin .7s linear infinite}

.pp-others{display:flex;flex-direction:column;gap:6px;margin-top:2px}
.pp-others-h{font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}
.pp-other{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:6px 9px;
  border:1px solid var(--border);border-radius:8px;background:var(--surface,#171a26)}
.pp-other-name{color:var(--fg);display:inline-flex;align-items:center;gap:5px}
.pp-other-tag{font-size:10px}
.pp-other-meta{margin-left:auto;color:var(--muted);font-size:10.5px}
.pp-error{font-size:11.5px;color:#f87171;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:7px 10px}
.pp-body::-webkit-scrollbar{width:10px}
.pp-body::-webkit-scrollbar-track{background:transparent}
.pp-body::-webkit-scrollbar-thumb{background:rgba(148,163,184,.4);border-radius:8px;
  border:2px solid transparent;background-clip:padding-box}
@keyframes pp-spin{to{transform:rotate(360deg)}}
`;
