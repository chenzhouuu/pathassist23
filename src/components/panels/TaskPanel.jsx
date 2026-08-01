// src/components/panels/TaskPanel.jsx
// Task — run a MIL downstream task on this slide's feature index (Inc 2c). Mirrors the CLAM demo's
// function set: pick a study, run it, read the call, then look at the evidence either Side By Side
// or as an Overlay. The task declares the preprocess build its weights were trained on; when the
// slide doesn't have it, the panel says exactly what is needed and offers to build it — never
// silently, because that is minutes of shared A6000.
// Pure matching / planning / colour logic lives in taskUtils.js; this file is the React shell.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { listArtifacts, startSegment, startPatch, startFeatures } from '../../api/preprocessApi.js';
import { listTasks, startPredict, getPredictionHeatmap } from '../../api/taskApi.js';
import { pickSegParams, pickTileParams, nextChainStep, fmtInt } from './preprocessUtils.js';
import {
  buildFormForSpec, describeSpec, describeFeatureState, pendingStages,
  findPrediction, describePrediction, DEFAULT_OPACITY,
} from './taskUtils.js';

const POLL_MS = 2500;

function Pill({ state, children }) {
  return <span className="tk-pill" data-state={state}>{children}</span>;
}

export default function TaskPanel() {
  const activeItem = useStore((s) => s.activeItem);
  const setTaskHeatmap = useStore((s) => s.setTaskHeatmap);
  const clearTaskHeatmap = useStore((s) => s.clearTaskHeatmap);
  const taskHeatmap = useStore((s) => s.taskHeatmap);
  const taskViewMode = useStore((s) => s.taskViewMode);
  const setTaskViewMode = useStore((s) => s.setTaskViewMode);
  const taskOpacity = useStore((s) => s.taskOpacity);
  const setTaskOpacity = useStore((s) => s.setTaskOpacity);
  const itemId = activeItem?._id || null;

  const [catalog, setCatalog] = useState({ tasks: [], available: true });
  const [taskId, setTaskId] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);      // 'build' | 'run' | null
  const [chain, setChain] = useState(false);   // a feature build is auto-advancing
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const chainSig = useRef(null);

  const task = catalog.tasks.find((t) => t.id === taskId) || catalog.tasks[0] || null;
  const spec = task?.feature_spec || null;
  const feat = describeFeatureState(rows, spec);
  const pred = describePrediction(findPrediction(rows, feat.feat?.art_hash, task?.id));
  const pending = pendingStages(rows, spec);
  const locked = chain || busy != null;
  const runnable = catalog.available && feat.state === 'ready';

  const refresh = useCallback(async () => {
    if (!itemId) { setRows([]); return []; }
    const next = await listArtifacts(itemId);
    setRows(next);
    return next;
  }, [itemId]);

  // The registry is fetched once per mount — it is a static server-side table, and it is served
  // even by a CPU worker so the task card renders with an honest "needs the GPU worker".
  useEffect(() => {
    let cancelled = false;
    listTasks()
      .then((c) => { if (!cancelled) { setCatalog(c); setTaskId(c.tasks[0]?.id || null); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!itemId) { setRows([]); return undefined; }
    let cancelled = false;
    setLoading(true); setError(null); setChain(false); chainSig.current = null;
    refresh()
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load artifacts'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [itemId, refresh]);

  // Poll while anything is in flight — a feature build chain or a queued prediction.
  useEffect(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    const live = chain || feat.state === 'building' || pred?.state === 'running';
    if (!itemId || !live) return undefined;
    pollRef.current = setTimeout(() => { refresh().catch(() => {}); }, POLL_MS);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [rows, itemId, chain, feat.state, pred?.state, refresh]);

  // Build the task's required index: nextChainStep decides one stage at a time, the poll feeds
  // fresh rows back in. Same auto-advance the Preprocess panel's Run-all uses.
  useEffect(() => {
    if (!chain || !itemId || !spec) return;
    const form = buildFormForSpec(spec, rows);
    const step = nextChainStep(rows, form);
    if (step.do === 'wait') return;
    if (step.do === 'done') { setChain(false); return; }
    if (step.do === 'stop') {
      setChain(false); setError(`${step.failed} failed — see the stage below.`); return;
    }
    const sig = `${step.do}:${step.seg_hash || ''}:${step.patch_hash || ''}`;
    if (chainSig.current === sig) return;
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
      } catch (e) { setChain(false); setError(e.message || 'Build failed'); }
    })();
  }, [chain, rows, spec, itemId, refresh]);

  const build = useCallback(() => {
    setError(null); chainSig.current = null; setChain(true);
  }, []);

  const run = useCallback(async () => {
    if (!itemId || !runnable || !task) return;
    setBusy('run'); setError(null); clearTaskHeatmap();
    try {
      await startPredict(itemId, { feat_hash: feat.feat.art_hash, task_id: task.id });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }, [itemId, runnable, task, feat.feat, refresh, clearTaskHeatmap]);

  // Fetch the per-patch arrays once, when a prediction first goes ready. Thousands of floats — the
  // artifact row's summary is what drives everything else.
  const predRow = findPrediction(rows, feat.feat?.art_hash, task?.id);
  const predHash = pred?.state === 'ready' ? predRow?.art_hash : null;
  useEffect(() => {
    if (!itemId || !predHash) return undefined;
    if (taskHeatmap?._hash === predHash) return undefined;
    let cancelled = false;
    getPredictionHeatmap(itemId, predHash)
      .then((doc) => { if (!cancelled) setTaskHeatmap({ ...doc, _hash: predHash }); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [itemId, predHash, taskHeatmap?._hash, setTaskHeatmap]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0, overflow: 'hidden', color: 'var(--fg)' }}>
      <style>{TK_CSS}</style>

      <div className="tk-header">
        <span className="tk-mark">◈</span>
        <span className="tk-title">Task</span>
        <span className="tk-spacer" />
        <button className="tk-btn" onClick={() => refresh().catch(() => {})}
          disabled={!itemId || loading} title="Refresh status">Refresh</button>
      </div>

      <div className="tk-body">
        {!itemId ? (
          <div className="tk-empty"><p>Open a slide to run a downstream task.</p></div>
        ) : !task ? (
          <div className="tk-empty"><p>No downstream tasks are registered.</p></div>
        ) : (
          <>
            <label className="tk-field">
              <span className="tk-label">Task</span>
              <select className="tk-select" value={task.id} disabled={locked}
                onChange={(e) => { setTaskId(e.target.value); clearTaskHeatmap(); }}>
                {catalog.tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>

            {/* model card */}
            <div className="tk-card">
              <div className="tk-card-top">
                <span className="tk-card-title">Model</span>
                <Pill state="model">{String(task.arch || '').toUpperCase()}</Pill>
              </div>
              <dl className="tk-spec">
                <div><dt>Version</dt><dd className="tk-mono">{task.model_ver}</dd></div>
                <div><dt>Classes</dt><dd>{(task.classes || []).join(' · ')}</dd></div>
                {task.cohort && <div><dt>Trained on</dt><dd>{task.cohort}</dd></div>}
              </dl>
              {task.metrics && (
                <dl className="tk-metrics">
                  <div><dt>AUC</dt><dd>{fmtMetric(task.metrics.test_auc)}</dd></div>
                  <div><dt>Acc</dt><dd>{fmtMetric(task.metrics.test_acc)}</dd></div>
                  <div><dt>F1</dt><dd>{fmtMetric(task.metrics.test_f1)}</dd></div>
                  <div><dt>n test</dt><dd>{fmtInt(task.metrics.n_test)}</dd></div>
                </dl>
              )}
              {task.caveat && <p className="tk-caveat">{task.caveat}</p>}
            </div>

            {/* feature requirement */}
            <div className={`tk-card tk-card--${catalog.available ? feat.state : 'blocked'}`}>
              <div className="tk-card-top">
                <span className="tk-card-title">Feature index</span>
                <Pill state={catalog.available ? feat.state : 'blocked'}>
                  {!catalog.available ? 'Blocked' : FEATURE_PILL[feat.state]}
                </Pill>
              </div>
              <div className="tk-detail">
                {!catalog.available
                  ? <>Requires <b>{describeSpec(spec)}</b>. This worker cannot run tasks.</>
                  : feat.state === 'ready'
                    ? <><b>{describeSpec(spec)}</b> — {feat.detail}</>
                    : feat.state === 'missing'
                      ? <>This task needs <b>{describeSpec(spec)}</b>. No matching index for this slide.</>
                      : feat.detail}
              </div>
              {feat.state === 'building' && (
                <div className="tk-bar"><i style={{ width: `${feat.progress}%` }} /></div>
              )}
              {catalog.available && (feat.state === 'missing' || feat.state === 'failed') && (
                <button className="tk-run" onClick={build} disabled={locked}>
                  {chain ? <><span className="tk-spin" />Building…</>
                    : `Build features · ${pending.length} stage${pending.length === 1 ? '' : 's'}`}
                </button>
              )}
              {catalog.available && (feat.state === 'missing' || feat.state === 'failed')
                && pending.length > 0 && !chain && (
                <div className="tk-note">Runs {pending.join(' → ')} on the GPU. Minutes, not seconds.</div>
              )}
            </div>

            {!catalog.available && (
              <div className="tk-blocked">
                Task inference needs the GPU worker. Bring the preprocess service up with the
                trident override to enable it.
              </div>
            )}

            <button className="tk-runall" onClick={run} disabled={!runnable || locked}>
              {busy === 'run' ? <><span className="tk-spin" />Starting…</>
                : pred?.state === 'running' ? <><span className="tk-spin" />Running…</>
                  : pred?.state === 'ready' ? 'Re-run task' : 'Run task'}
            </button>

            {/* result */}
            {pred && pred.state !== 'running' && (
              <div className={`tk-card tk-card--${pred.state === 'ready' ? 'ready' : 'failed'}`}>
                <div className="tk-card-top">
                  <span className="tk-card-title">Prediction</span>
                  <Pill state={pred.state}>{pred.state === 'ready' ? 'Complete' : 'Failed'}</Pill>
                </div>
                {pred.state === 'ready' ? (
                  <>
                    <div className="tk-verdict">
                      <span className="tk-who">{pred.label}</span>
                      <span className="tk-conf tk-mono">
                        {pred.confidence != null ? `${pred.confidence.toFixed(2)} confidence` : ''}
                      </span>
                    </div>
                    <div className="tk-probs">
                      {pred.probs.map((p) => (
                        <div key={p.name} className={`tk-prob ${p.win ? 'is-win' : ''}`}>
                          <span className="tk-pname">{p.name}</span>
                          <span className="tk-track">
                            <i style={{ width: `${Math.round(p.p * 100)}%`,
                              background: p.win ? 'rgb(180,40,47)' : 'rgb(58,76,160)' }} />
                          </span>
                          <span className="tk-pnum tk-mono">{p.p.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="tk-prov tk-mono">{pred.provenance}</p>
                  </>
                ) : <div className="tk-detail">{pred.detail}</div>}
              </div>
            )}

            {/* evidence map controls */}
            {pred?.state === 'ready' && taskHeatmap && (
              <div className="tk-card">
                <div className="tk-card-top"><span className="tk-card-title">Evidence map</span></div>
                <div className="tk-seg" role="group" aria-label="View mode">
                  <button type="button" aria-pressed={taskViewMode === 'split'}
                    onClick={() => setTaskViewMode('split')}>Side By Side</button>
                  <button type="button" aria-pressed={taskViewMode === 'overlay'}
                    onClick={() => setTaskViewMode('overlay')}>Overlay</button>
                </div>
                <div className={`tk-slider ${taskViewMode === 'overlay' ? '' : 'is-off'}`}>
                  <span className="tk-label">Opacity</span>
                  <input type="range" min="0" max="100" aria-label="Heatmap opacity"
                    value={Math.round((taskOpacity ?? DEFAULT_OPACITY) * 100)}
                    onChange={(e) => setTaskOpacity(e.target.value / 100)} />
                  <span className="tk-pnum tk-mono">{(taskOpacity ?? DEFAULT_OPACITY).toFixed(2)}</span>
                </div>
                <div className="tk-legend">
                  <span>supports {otherClass(task, pred)}</span>
                  <span className="tk-ramp" />
                  <span>supports {pred.label}</span>
                </div>
              </div>
            )}

            {error && <div className="tk-error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

const FEATURE_PILL = {
  ready: 'Ready', building: 'Building', failed: 'Failed', missing: 'Missing',
};

function fmtMetric(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3).replace(/^0/, '') : '—';
}

// The class the blue pole of the ramp argues for — the runner-up to the call being shown.
function otherClass(task, pred) {
  const classes = task?.classes || [];
  return classes.find((c) => c !== pred?.label) || 'the other class';
}

// Scoped styles (prefix `tk-`) — theme-var driven, matching the Preprocess panel's card grammar
// so the two tabs read as siblings.
const TK_CSS = `
.tk-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border-hex);flex-shrink:0}
.tk-mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;
  background:linear-gradient(160deg,#a78bfa,#7c3aed);color:#fff;font-size:12px;font-weight:700;
  box-shadow:0 0 0 1px rgba(167,139,250,.25),0 2px 8px rgba(124,58,237,.35)}
.tk-title{font-weight:600;font-size:13px;letter-spacing:.2px}
.tk-spacer{margin-left:auto}
.tk-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.tk-btn{font-size:11px;color:var(--muted-hex);background:transparent;border:1px solid var(--border-hex);
  border-radius:7px;padding:4px 9px;cursor:pointer;transition:background .15s,color .15s}
.tk-btn:hover:not(:disabled){background:rgba(148,163,184,.10);color:var(--fg)}
.tk-btn:disabled{opacity:.4;cursor:default}
.tk-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;
  display:flex;flex-direction:column;gap:11px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
.tk-empty{color:var(--muted-hex);font-size:12.5px;margin-top:6px}
.tk-field{display:flex;flex-direction:column;gap:4px}
.tk-label{font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted-hex)}
.tk-select{background:var(--bg2,#0d0e14);color:var(--fg);border:1px solid var(--border-hex);
  border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none;cursor:pointer}
.tk-select:focus{border-color:rgba(139,92,246,.6);box-shadow:0 0 0 2px rgba(139,92,246,.15)}
.tk-select:disabled{opacity:.55;cursor:default}

.tk-card{border:1px solid var(--border-hex);border-radius:10px;padding:10px 11px;
  background:var(--surface,#171a26);display:flex;flex-direction:column;gap:8px}
.tk-card--ready{border-color:rgba(52,211,153,.35)}
.tk-card--failed{border-color:rgba(248,113,113,.35)}
.tk-card--building{border-color:rgba(139,92,246,.4)}
.tk-card--missing{border-color:rgba(251,191,36,.32)}
.tk-card--blocked{border-color:rgba(248,113,113,.32)}
.tk-card-top{display:flex;align-items:center;gap:8px}
.tk-card-title{font-size:12.5px;font-weight:600;color:var(--fg);flex:1;min-width:0}
.tk-detail{font-size:11.5px;color:var(--muted-hex);line-height:1.5;word-break:break-word}
.tk-detail b{color:var(--fg);font-weight:600}
.tk-note{font-size:10.5px;color:var(--muted-hex);line-height:1.45}
.tk-pill{font-size:9px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;
  border-radius:6px;padding:2px 7px;color:#0b0c12;background:#64748b;white-space:nowrap}
.tk-pill[data-state="ready"]{background:#34d399}
.tk-pill[data-state="building"]{background:#a78bfa}
.tk-pill[data-state="failed"],.tk-pill[data-state="blocked"]{background:#f87171}
.tk-pill[data-state="missing"]{background:#fbbf24}
.tk-pill[data-state="model"]{background:rgba(139,92,246,.18);color:#c4b5fd;
  border:1px solid rgba(139,92,246,.32)}

.tk-spec{margin:0;display:flex;flex-direction:column;gap:5px}
.tk-spec>div{display:flex;gap:8px;font-size:11.5px;line-height:1.45}
.tk-spec dt{flex:0 0 72px;color:var(--muted-hex);margin:0}
.tk-spec dd{margin:0;flex:1;min-width:0;color:var(--fg);word-break:break-word}
.tk-metrics{margin:0;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
  background:var(--border-hex);border:1px solid var(--border-hex);border-radius:8px;overflow:hidden}
.tk-metrics>div{background:var(--surface,#171a26);padding:6px 4px;text-align:center}
.tk-metrics dt{font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-hex);margin:0}
.tk-metrics dd{margin:2px 0 0;font-size:13px;font-weight:600;color:var(--fg);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.tk-caveat{margin:0;font-size:11px;line-height:1.5;color:#fbbf24;
  background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.26);border-radius:8px;padding:7px 9px}
.tk-blocked{font-size:11.5px;line-height:1.5;color:#f87171;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:8px 10px}

.tk-bar{height:5px;border-radius:3px;background:rgba(148,163,184,.18);overflow:hidden}
.tk-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#a78bfa,#7c3aed);
  transition:width .4s ease}

.tk-run{width:100%;padding:8px;border:1px solid rgba(139,92,246,.4);border-radius:8px;
  font-size:12px;font-weight:600;color:#c4b5fd;background:rgba(139,92,246,.10);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  transition:background .15s,transform .12s,opacity .15s;font-family:inherit}
.tk-run:hover:not(:disabled){background:rgba(139,92,246,.20);transform:translateY(-1px)}
.tk-run:disabled{opacity:.45;cursor:default}
.tk-runall{width:100%;padding:10px;border:none;border-radius:9px;font-size:12.5px;font-weight:600;
  color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:linear-gradient(160deg,#8b5cf6,#7c3aed);font-family:inherit;
  transition:transform .12s,box-shadow .15s,opacity .15s}
.tk-runall:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.tk-runall:disabled{opacity:.45;cursor:not-allowed;transform:none}
.tk-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.35);
  border-top-color:#fff;animation:tk-spin .7s linear infinite}

.tk-verdict{display:flex;align-items:baseline;gap:9px}
.tk-who{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1;color:var(--fg)}
.tk-conf{font-size:12.5px;color:var(--muted-hex)}
.tk-probs{display:flex;flex-direction:column;gap:5px}
.tk-prob{display:grid;grid-template-columns:36px 1fr 40px;align-items:center;gap:8px;font-size:11px;
  color:var(--muted-hex)}
.tk-prob.is-win .tk-pname,.tk-prob.is-win .tk-pnum{color:var(--fg);font-weight:600}
.tk-track{height:6px;border-radius:3px;background:rgba(148,163,184,.22);overflow:hidden}
.tk-track i{display:block;height:100%;border-radius:3px;transition:width .5s ease}
.tk-pnum{text-align:right}
.tk-prov{margin:0;font-size:10px;line-height:1.5;color:var(--muted-hex);word-break:break-word}

.tk-seg{display:flex;border:1px solid var(--border-hex);border-radius:8px;overflow:hidden}
.tk-seg button{flex:1;font:inherit;font-size:11.5px;padding:6px 4px;cursor:pointer;
  background:transparent;color:var(--muted-hex);border:none;transition:background .15s,color .15s}
.tk-seg button+button{border-left:1px solid var(--border-hex)}
.tk-seg button:hover[aria-pressed="false"]{color:var(--fg)}
.tk-seg button[aria-pressed="true"]{background:#7c3aed;color:#fff;font-weight:600}
.tk-slider{display:flex;align-items:center;gap:9px}
.tk-slider input[type=range]{flex:1;accent-color:#8b5cf6;cursor:pointer;min-width:0}
.tk-slider.is-off{opacity:.4;pointer-events:none}
.tk-legend{display:flex;align-items:center;gap:8px;font-size:9.5px;color:var(--muted-hex)}
.tk-ramp{flex:1;height:8px;border-radius:2px;border:1px solid var(--border-hex);
  background:linear-gradient(90deg,rgb(58,76,160),rgb(247,247,247),rgb(180,40,47))}

.tk-error{font-size:11.5px;color:#f87171;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:7px 10px}
.tk-body::-webkit-scrollbar{width:10px}
.tk-body::-webkit-scrollbar-track{background:transparent}
.tk-body::-webkit-scrollbar-thumb{background:rgba(148,163,184,.4);border-radius:8px;
  border:2px solid transparent;background-clip:padding-box}
@keyframes tk-spin{to{transform:rotate(360deg)}}
`;
