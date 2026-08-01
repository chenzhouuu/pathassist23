// src/components/panels/PreprocessPanel.jsx
// Preprocess — build a slide's searchable feature index as a 3-stage Trident DAG (Inc 2b-3):
//   ① tissue segmentation → ② tiling → ③ feature extraction.
// The user picks a build target (encoder, which binds the tile patch_size — Fork B), then runs each
// stage independently (each is a separate worker job / durable artifact row) or "Run all" to chain
// them. Reuse is real: one segmentation feeds many tilings; one patch grid feeds many encoders.
// Pure matching / status / chain logic lives in preprocessUtils.js; this file is the React shell.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/index.js';
import {
  listArtifacts, startSegment, startPatch, startFeatures,
} from '../../api/preprocessApi.js';
import {
  ENCODERS, SEGMENTERS, MAGS, OVERLAPS, DEFAULT_FORM,
  encoderLabel, isTextCapable, recommendedPatchSize, recommendedMag,
  bindEncoder, stageLabel, progressPercent, hydrateFormFromRows,
  pickSegParams, pickTileParams, matchDag, describeStage, anyInFlight, nextChainStep,
} from './preprocessUtils.js';

const POLL_MS = 2500;

function StagePill({ state }) {
  const label = state === 'ready' ? 'Ready'
    : state === 'running' ? 'Building'
      : state === 'failed' ? 'Failed'
        : state === 'none' ? 'None' : state;
  return <span className="pp-pill" data-state={state}>{label}</span>;
}

export default function PreprocessPanel() {
  const activeItem = useStore((s) => s.activeItem);
  const itemId = activeItem?._id || null;

  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);          // 'seg' | 'patch' | 'feat' | null
  const [chain, setChain] = useState(false);       // Run-all auto-advance active
  const [error, setError] = useState(null);
  const [advSeg, setAdvSeg] = useState(false);
  const [advTile, setAdvTile] = useState(false);
  const pollRef = useRef(null);
  const chainSig = useRef(null);

  const { seg, patch, feat } = matchDag(rows, form);
  const segS = describeStage(seg, 'segmentation');
  const patchS = describeStage(patch, 'patching');
  const featS = describeStage(feat, 'features');
  const locked = chain || busy != null;

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); return []; }
    const next = await listArtifacts(itemId);
    setRows(next);
    return next;
  }, [itemId]);

  // Load this slide's artifacts on open / slide switch, then hydrate the form from the deepest
  // ready chain so an existing build shows as Ready (not an empty default) — matchDag is
  // form-first, so without this a non-default build would look unbuilt after reopening.
  useEffect(() => {
    if (!itemId) { setRows([]); setForm({ ...DEFAULT_FORM }); return undefined; }
    let cancelled = false;
    setLoading(true); setError(null); setChain(false); chainSig.current = null;
    refresh()
      .then((next) => { if (!cancelled) setForm(hydrateFormFromRows(next) || { ...DEFAULT_FORM }); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load artifacts'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [itemId, refresh]);

  // Poll while any build is in flight OR a Run-all chain is active; stop once everything settles.
  useEffect(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (!itemId || (!anyInFlight(rows) && !chain)) return undefined;
    pollRef.current = setTimeout(() => { refresh().catch(() => {}); }, POLL_MS);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [rows, itemId, chain, refresh]);

  // Run-all: a pure decision (nextChainStep) drives one trigger at a time; the poll effect feeds
  // fresh rows back in until the chain reaches the feature index (or a stage fails).
  useEffect(() => {
    if (!chain || !itemId) return;
    const step = nextChainStep(rows, form);
    if (step.do === 'wait') return;
    if (step.do === 'done') { setChain(false); return; }
    if (step.do === 'stop') {
      setChain(false); setError(`${step.failed} failed — see the stage below.`); return;
    }
    const sig = `${step.do}:${step.seg_hash || ''}:${step.patch_hash || ''}`;
    if (chainSig.current === sig) return;          // already fired this step; await fresh rows
    chainSig.current = sig;
    (async () => {
      try {
        if (step.do === 'segment') await startSegment(itemId, pickSegParams(form));
        else if (step.do === 'patch') {
          await startPatch(itemId, { seg_hash: step.seg_hash, ...pickTileParams(form) });
        } else if (step.do === 'features') {
          await startFeatures(itemId, { patch_hash: step.patch_hash, encoder: form.encoder });
        }
        await refresh();
      } catch (e) { setChain(false); setError(e.message || 'Run all failed'); }
    })();
  }, [chain, rows, form, itemId, refresh]);

  const runSegment = useCallback(async () => {
    if (!itemId) return;
    setBusy('seg'); setError(null);
    try { await startSegment(itemId, pickSegParams(form)); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }, [itemId, form, refresh]);

  const runPatch = useCallback(async () => {
    if (!itemId || seg?.status !== 'ready') return;
    setBusy('patch'); setError(null);
    try { await startPatch(itemId, { seg_hash: seg.art_hash, ...pickTileParams(form) }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }, [itemId, seg, form, refresh]);

  const runFeatures = useCallback(async () => {
    if (!itemId || patch?.status !== 'ready') return;
    setBusy('feat'); setError(null);
    try {
      await startFeatures(itemId, { patch_hash: patch.art_hash, encoder: form.encoder });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }, [itemId, patch, form, refresh]);

  const runAll = useCallback(() => { setError(null); chainSig.current = null; setChain(true); }, []);

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setBool = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));
  const onEncoder = (e) => setForm((f) => bindEncoder(f, e.target.value));
  const onOverride = (e) => setForm((f) => (e.target.checked
    ? { ...f, patch_override: true }
    : { ...f, patch_override: false, patch_size: recommendedPatchSize(f.encoder), mag: recommendedMag(f.encoder) }
  ));

  const segReady = seg?.status === 'ready';
  const patchReady = patch?.status === 'ready';
  const featReady = feat?.status === 'ready';

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0, overflow: 'hidden', color: 'var(--fg)' }}>
      <style>{PP_CSS}</style>

      <div className="pp-header">
        <span className="pp-mark">▦</span>
        <span className="pp-title">Preprocess</span>
        <span className="pp-spacer" />
        <button className="pp-btn" onClick={() => refresh().catch(() => {})}
          disabled={!itemId || loading} title="Refresh stage status">Refresh</button>
      </div>

      <div className="pp-body">
        {!itemId ? (
          <div className="pp-empty"><p>Open a slide to build its feature index.</p></div>
        ) : (
          <>
            <p className="pp-lede">
              Build a whole-slide feature index in three stages so Copilot can <b>search this
              slide</b> by description. Each stage is cached and reused.
            </p>

            {/* build target — the encoder binds the tiling resolution (Fork B) */}
            <div className="pp-target">
              <label className="pp-field">
                <span className="pp-label">Build target · image encoder</span>
                <select className="pp-select" value={form.encoder} onChange={onEncoder}
                  disabled={locked}>
                  {ENCODERS.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}{e.text ? ' · 🔍 text search' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className={`pp-hint ${isTextCapable(form.encoder) ? 'is-ok' : 'is-img'}`}>
                {isTextCapable(form.encoder)
                  ? 'Text-capable — enables Copilot find_regions search.'
                  : 'Image-only — no text search. Choose CONCH v1 for that.'}
              </div>
              <div className="pp-hint">
                Tiles at <b>{form.patch_size}px</b> / <b>{form.mag}×</b>
                {form.patch_override ? ' (manual)' : ' (encoder default)'}.
              </div>
            </div>

            {/* ① Segmentation */}
            <div className={`pp-card pp-card--${segS.state}`}>
              <div className="pp-card-top">
                <span className="pp-step">1</span>
                <span className="pp-card-title">Tissue segmentation</span>
                <StagePill state={segS.state} />
              </div>
              <div className="pp-card-detail">
                {segReady || seg?.status === 'failed' ? segS.detail : segS.title}
              </div>
              {seg && seg.status === 'running' && (
                <div className="pp-bar"><i style={{ width: `${progressPercent(seg)}%` }} /></div>
              )}

              <button type="button" className="pp-adv-toggle" onClick={() => setAdvSeg((v) => !v)}>
                {advSeg ? '▾' : '▸'} Options
              </button>
              {advSeg && (
                <div className="pp-adv">
                  <label className="pp-field">
                    <span className="pp-label">Segmenter</span>
                    <select className="pp-select" value={form.segmenter}
                      onChange={setField('segmenter')} disabled={locked}>
                      {SEGMENTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </label>
                  <label className="pp-field">
                    <span className="pp-label">Confidence threshold · {Number(form.seg_conf_thresh).toFixed(2)}</span>
                    <input type="range" min="0.1" max="0.9" step="0.05" value={form.seg_conf_thresh}
                      onChange={setField('seg_conf_thresh')} disabled={locked} className="pp-range" />
                    <span className="pp-note">Lower keeps more tissue (Trident default 0.50).</span>
                  </label>
                  <label className="pp-check">
                    <input type="checkbox" checked={form.remove_holes}
                      onChange={setBool('remove_holes')} disabled={locked} />
                    <span>Remove holes</span>
                  </label>
                  <label className="pp-check">
                    <input type="checkbox" checked={form.remove_artifacts}
                      onChange={setBool('remove_artifacts')} disabled={locked} />
                    <span>Remove artifacts (blur / stain)</span>
                  </label>
                  <label className="pp-check">
                    <input type="checkbox" checked={form.remove_penmarks}
                      onChange={setBool('remove_penmarks')} disabled={locked} />
                    <span>Remove pen marks</span>
                  </label>
                </div>
              )}

              <div className="pp-run-row">
                <button className="pp-run" onClick={runSegment}
                  disabled={locked || (seg && seg.status !== 'ready' && seg.status !== 'failed')}>
                  {busy === 'seg' ? <><span className="pp-spin" />Starting…</>
                    : segReady ? 'Re-segment' : 'Run segmentation'}
                </button>
                {/* The outline is switched on from the Workspace now (Inc 5 · 03b) — one eye
                    per artifact, in one place, rather than a View/Hide pair per panel. */}
              </div>
            </div>

            {/* ② Tiling */}
            <div className={`pp-card pp-card--${patchS.state} ${segReady ? '' : 'pp-card--gated'}`}>
              <div className="pp-card-top">
                <span className="pp-step">2</span>
                <span className="pp-card-title">Tiling</span>
                <StagePill state={patchS.state} />
              </div>
              <div className="pp-card-detail">
                {!segReady ? 'Waiting on segmentation.'
                  : (patchReady || patch?.status === 'failed' ? patchS.detail : patchS.title)}
              </div>
              {patch && patch.status === 'running' && (
                <div className="pp-bar"><i style={{ width: `${progressPercent(patch)}%` }} /></div>
              )}

              <button type="button" className="pp-adv-toggle" onClick={() => setAdvTile((v) => !v)}>
                {advTile ? '▾' : '▸'} Options
              </button>
              {advTile && (
                <div className="pp-adv">
                  <div className="pp-row">
                    <label className="pp-field">
                      <span className="pp-label">Magnification</span>
                      <select className="pp-select" value={form.mag} onChange={setField('mag')}
                        disabled={locked || !form.patch_override}>
                        {MAGS.map((m) => <option key={m} value={m}>{m}×</option>)}
                      </select>
                    </label>
                    <label className="pp-field">
                      <span className="pp-label">Patch size</span>
                      <input className="pp-select" value={`${form.patch_size} px`} disabled readOnly />
                    </label>
                  </div>
                  <label className="pp-check">
                    <input type="checkbox" checked={form.patch_override}
                      onChange={onOverride} disabled={locked} />
                    <span>Override encoder resolution (advanced)</span>
                  </label>
                  <label className="pp-field">
                    <span className="pp-label">Overlap</span>
                    <select className="pp-select" value={form.overlap} onChange={setField('overlap')}
                      disabled={locked}>
                      {OVERLAPS.map((o) => <option key={o} value={o}>{o} px</option>)}
                    </select>
                  </label>
                </div>
              )}

              <button className="pp-run" onClick={runPatch}
                disabled={locked || !segReady || (patch && patch.status === 'running')}>
                {busy === 'patch' ? <><span className="pp-spin" />Starting…</>
                  : patchReady ? 'Re-tile' : 'Run tiling'}
              </button>
            </div>

            {/* ③ Feature extraction */}
            <div className={`pp-card pp-card--${featS.state} ${patchReady ? '' : 'pp-card--gated'}`}>
              <div className="pp-card-top">
                <span className="pp-step">3</span>
                <span className="pp-card-title">Feature extraction</span>
                <StagePill state={featS.state} />
              </div>
              <div className="pp-card-detail">
                {!patchReady ? 'Waiting on tiling.'
                  : (featReady || feat?.status === 'failed' ? featS.detail
                    : `Encode with ${encoderLabel(form.encoder)}`)}
              </div>
              {feat && feat.status === 'running' && (
                <div className="pp-bar"><i style={{ width: `${progressPercent(feat)}%` }} /></div>
              )}
              {featReady && (
                <div className="pp-ready-note">
                  {isTextCapable(feat.encoder ?? form.encoder)
                    ? <>🔍 These features power <b>Copilot region search</b> on this slide.</>
                    : <>Image-only index — pick <b>CONCH v1</b> to enable Copilot text search.</>}
                </div>
              )}

              <button className="pp-run" onClick={runFeatures}
                disabled={locked || !patchReady || (feat && feat.status === 'running')}>
                {busy === 'feat' ? <><span className="pp-spin" />Starting…</>
                  : featReady ? 'Re-encode' : 'Run feature extraction'}
              </button>
            </div>

            {/* one-click: chain all three */}
            <button className="pp-runall" onClick={runAll} disabled={locked}>
              {chain ? <><span className="pp-spin" />Running all…</> : '▸ Run all'}
            </button>
            {featReady && !chain && (
              <div className="pp-already">✓ Feature index ready for this target.</div>
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
.pp-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border-hex);flex-shrink:0}
.pp-mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;
  background:linear-gradient(160deg,#a78bfa,#7c3aed);color:#fff;font-size:12px;font-weight:700;
  box-shadow:0 0 0 1px rgba(167,139,250,.25),0 2px 8px rgba(124,58,237,.35)}
.pp-title{font-weight:600;font-size:13px;letter-spacing:.2px}
.pp-spacer{margin-left:auto}
.pp-btn{font-size:11px;color:var(--muted-hex);background:transparent;border:1px solid var(--border-hex);
  border-radius:7px;padding:4px 9px;cursor:pointer;transition:background .15s,color .15s}
.pp-btn:hover:not(:disabled){background:rgba(148,163,184,.10);color:var(--fg)}
.pp-btn:disabled{opacity:.4;cursor:default}
.pp-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;
  display:flex;flex-direction:column;gap:11px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
.pp-empty{color:var(--muted-hex);font-size:12.5px;margin-top:6px}
.pp-lede{margin:0;font-size:12px;line-height:1.55;color:var(--muted-hex)}
.pp-lede b{color:#c4b5fd;font-weight:600}

.pp-target{border:1px solid var(--border-hex);border-radius:10px;padding:10px 11px;
  background:var(--surface,#171a26);display:flex;flex-direction:column;gap:6px}
.pp-field{display:flex;flex-direction:column;gap:4px}
.pp-label{font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted-hex)}
.pp-select{background:var(--bg2,#0d0e14);color:var(--fg);border:1px solid var(--border-hex);
  border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none;cursor:pointer;
  transition:border-color .15s,box-shadow .15s}
.pp-select:focus{border-color:rgba(139,92,246,.6);box-shadow:0 0 0 2px rgba(139,92,246,.15)}
.pp-select:disabled{opacity:.55;cursor:default}
.pp-hint{font-size:10.5px;line-height:1.45}
.pp-hint.is-ok{color:#6ee7b7}
.pp-hint.is-img{color:var(--muted-hex)}
.pp-hint b{color:#c4b5fd}

.pp-card{border:1px solid var(--border-hex);border-radius:10px;padding:10px 11px;
  background:var(--surface,#171a26);display:flex;flex-direction:column;gap:8px;position:relative}
.pp-card--ready{border-color:rgba(52,211,153,.35)}
.pp-card--failed{border-color:rgba(248,113,113,.35)}
.pp-card--running{border-color:rgba(139,92,246,.4)}
.pp-card--gated{opacity:.62}
.pp-card-top{display:flex;align-items:center;gap:8px}
.pp-step{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;
  font-size:10.5px;font-weight:700;color:#c4b5fd;background:rgba(139,92,246,.16);
  border:1px solid rgba(139,92,246,.3)}
.pp-card-title{font-size:12.5px;font-weight:600;color:var(--fg);flex:1;min-width:0}
.pp-card-detail{font-size:11.5px;color:var(--muted-hex);line-height:1.5;word-break:break-word}
.pp-pill{font-size:9px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;
  border-radius:6px;padding:2px 7px;color:#0b0c12;background:#64748b}
.pp-pill[data-state="ready"]{background:#34d399}
.pp-pill[data-state="running"]{background:#a78bfa}
.pp-pill[data-state="failed"]{background:#f87171}
.pp-pill[data-state="none"]{background:#475569;color:#cbd5e1}
.pp-bar{height:5px;border-radius:3px;background:rgba(148,163,184,.18);overflow:hidden}
.pp-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#a78bfa,#7c3aed);
  transition:width .4s ease}
.pp-ready-note{font-size:11px;line-height:1.5;color:#a7f3d0}
.pp-ready-note b{color:#6ee7b7}

.pp-adv-toggle{align-self:flex-start;font-size:11px;color:var(--muted-hex);background:none;border:none;
  padding:0;cursor:pointer;transition:color .15s}
.pp-adv-toggle:hover{color:#c4b5fd}
.pp-adv{display:flex;flex-direction:column;gap:9px;padding-left:10px;
  border-left:2px solid rgba(139,92,246,.25);margin-left:1px}
.pp-row{display:flex;gap:9px}
.pp-row .pp-field{flex:1}
.pp-range{accent-color:#8b5cf6;cursor:pointer}
.pp-note{font-size:10px;color:var(--muted-hex);line-height:1.4}
.pp-check{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--fg);cursor:pointer}
.pp-check input{accent-color:#8b5cf6;cursor:pointer}

.pp-run{width:100%;padding:8px;border:1px solid rgba(139,92,246,.4);border-radius:8px;
  font-size:12px;font-weight:600;color:#c4b5fd;background:rgba(139,92,246,.10);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  transition:background .15s,transform .12s,opacity .15s}
.pp-run:hover:not(:disabled){background:rgba(139,92,246,.20);transform:translateY(-1px)}
.pp-run:disabled{opacity:.45;cursor:default}
.pp-run-row{display:flex;gap:7px}
.pp-run-row .pp-run{flex:1}
.pp-run--ghost{flex:0 0 auto;min-width:72px;border-color:rgba(52,211,153,.4);color:#6ee7b7;
  background:rgba(52,211,153,.08)}
.pp-run--ghost:hover:not(:disabled){background:rgba(52,211,153,.18)}
.pp-runall{width:100%;padding:10px;border:none;border-radius:9px;font-size:12.5px;font-weight:600;
  color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:linear-gradient(160deg,#8b5cf6,#7c3aed);transition:transform .12s,box-shadow .15s,opacity .15s}
.pp-runall:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.pp-runall:disabled{opacity:.55;cursor:default}
.pp-already{font-size:11px;color:#6ee7b7;text-align:center}
.pp-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.35);
  border-top-color:#fff;animation:pp-spin .7s linear infinite}
.pp-error{font-size:11.5px;color:#f87171;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:7px 10px}
.pp-body::-webkit-scrollbar{width:10px}
.pp-body::-webkit-scrollbar-track{background:transparent}
.pp-body::-webkit-scrollbar-thumb{background:rgba(148,163,184,.4);border-radius:8px;
  border:2px solid transparent;background-clip:padding-box}
@keyframes pp-spin{to{transform:rotate(360deg)}}
`;
