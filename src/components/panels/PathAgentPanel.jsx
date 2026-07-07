// src/components/panels/PathAgentPanel.jsx
// PathAgent — autonomous WSI diagnosis agent panel (M4).
// Streams a route→triage→navigate→describe→diagnose→verify→final trace over the
// M3 gateway, co-navigates the OpenSeadragon viewer, and can persist visited ROIs.
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { preprocessCase, pollStatus, streamAgentQuery } from '../../api/wsiAgentApi.js';
import { focusRegion, addHeatmapOverlay, removeHeatmapOverlay } from './agentViewerSync.js';
import { createAnnotation } from '../../api/index.js';
import { makeRectangle, hexToRgba } from '../annotations/annotationUtils.js';

// ── helpers ───────────────────────────────────────────────────────────────────
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const num = (v) => Math.round(Number(v) || 0);
const confColor = (c) => (c >= 70 ? '#34d399' : c >= 40 ? '#f5a623' : '#f87171');
const riskColor = (r) => {
  const s = String(r || '').toLowerCase();
  if (s.includes('high') || Number(r) >= 3) return '#f87171';
  if (s.includes('med') || Number(r) === 2) return '#f5a623';
  if (s.includes('low') || Number(r) === 1) return '#34d399';
  return '#a78bfa';
};

const META_LABEL = {
  fontSize: 9, fontWeight: 700, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: 0.5,
};
const DOT_COLOR = {
  route: 'rgba(124,58,237,0.55)', triage: 'rgba(124,58,237,0.55)',
  navigate: '#a78bfa', describe: 'var(--muted)', diagnose: '#7c3aed',
  verify: '#34d399', error: '#f87171',
};

// ── small building blocks ───────────────────────────────────────────────────────
function Chip({ children, color = '#a78bfa' }) {
  return (
    <span style={{
      fontSize: 9, padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
      background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.28)', color,
    }}>{children}</span>
  );
}

function PhiBars({ scores }) {
  if (!scores) return null;
  const rows = [
    ['φL', scores.phiL], ['φK', scores.phiK], ['φC', scores.phiC], ['φΣ', scores.phiTotal],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
      {rows.map(([label, v]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, color: 'var(--muted)', width: 20, fontFamily: 'monospace' }}>{label}</span>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{
              width: `${Math.round(clamp01(v) * 100)}%`, height: '100%',
              background: label === 'φΣ' ? 'rgba(52,211,153,0.75)' : 'rgba(124,58,237,0.7)',
              transition: 'width 0.2s',
            }} />
          </div>
          <span style={{ fontSize: 9, color: 'var(--muted)', width: 26, textAlign: 'right' }}>{clamp01(v).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

function Citations({ items }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {items.map((c, i) => (
        <div key={i} style={{ fontSize: 9.5, color: 'var(--muted)', lineHeight: 1.4 }}>
          <span style={{ color: '#a78bfa' }}>▸</span> {c.text}
          {c.source && <span style={{ opacity: 0.7 }}> — {c.source}</span>}
        </div>
      ))}
    </div>
  );
}

// ── one trace event (compact timeline row) ──────────────────────────────────────
function TraceEvent({ evt, navIdx, onFocus }) {
  const [hover, setHover] = useState(false);
  if (evt.type === 'final') return null; // final rendered as its own card below

  let content = null;
  switch (evt.type) {
    case 'route':
      content = (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={META_LABEL}>route</span>
          {evt.task && <Chip>{evt.task}</Chip>}
          {(evt.tools || []).map((t, i) => <Chip key={i} color="var(--muted)">{t}</Chip>)}
        </div>
      );
      break;
    case 'triage':
      content = (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={META_LABEL}>triage</span>
          {evt.risk != null && <Chip color={riskColor(evt.risk)}>risk {evt.risk}</Chip>}
          {evt.depth != null && <Chip color="var(--muted)">depth {evt.depth}</Chip>}
          {evt.maxRegions != null && <Chip color="var(--muted)">≤{evt.maxRegions} regions</Chip>}
        </div>
      );
      break;
    case 'navigate': {
      const r = evt.region || {};
      content = (
        <div
          onClick={() => onFocus(r)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title="Focus this region in the viewer"
          style={{
            cursor: 'pointer', borderRadius: 6, padding: '4px 7px',
            background: hover ? 'rgba(124,58,237,0.16)' : 'rgba(124,58,237,0.06)',
            border: '1px solid rgba(124,58,237,0.22)', transition: 'background 0.12s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: evt.rationale ? 3 : 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa' }}>#{navIdx + 1}</span>
            <span style={{ fontSize: 9.5, color: 'var(--muted)', fontFamily: 'monospace' }}>
              x{num(r.x)} y{num(r.y)} · {num(r.width)}×{num(r.height)}
            </span>
            {evt.zoom != null && (
              <span style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 'auto' }}>{evt.zoom}×</span>
            )}
          </div>
          {evt.rationale && (
            <div style={{ fontSize: 10.5, color: 'var(--fg)', lineHeight: 1.4 }}>{evt.rationale}</div>
          )}
        </div>
      );
      break;
    }
    case 'describe':
      content = (
        <div>
          <span style={META_LABEL}>describe</span>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.45, marginTop: 2 }}>{evt.findings}</div>
        </div>
      );
      break;
    case 'diagnose':
      content = (
        <div>
          <span style={META_LABEL}>diagnose</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 3 }}>
            {(evt.candidates || []).map((c, i) => (
              <div key={i} style={{ fontSize: 10.5, lineHeight: 1.4 }}>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>{c.source}:</span>{' '}
                <span style={{ color: 'var(--fg)' }}>{c.answer}</span>
                {c.detail && <span style={{ color: 'var(--muted)' }}> — {c.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      );
      break;
    case 'verify':
      content = (
        <div>
          <span style={META_LABEL}>verify</span>
          <PhiBars scores={evt.scores} />
          <Citations items={evt.citations} />
        </div>
      );
      break;
    case 'error':
      content = (
        <div style={{ fontSize: 10.5, color: '#f87171', lineHeight: 1.4 }}>
          <span style={{ ...META_LABEL, color: '#f87171' }}>error</span>{' '}{evt.message}
        </div>
      );
      break;
    default:
      return null;
  }

  return (
    <div style={{ position: 'relative', paddingLeft: 14, paddingBottom: 8 }}>
      <span style={{
        position: 'absolute', left: -3.5, top: 4, width: 6, height: 6, borderRadius: '50%',
        background: DOT_COLOR[evt.type] || 'var(--border)', border: '1px solid var(--surface)',
      }} />
      {content}
    </div>
  );
}

// ── final answer card ───────────────────────────────────────────────────────────
function FinalCard({ final, scores }) {
  if (!final) return null;
  const c = num(final.confidence);
  const col = confColor(c);
  return (
    <div style={{
      marginTop: 6, borderRadius: 10, padding: '10px 11px',
      background: 'rgba(124,58,237,0.10)', border: '1px solid rgba(124,58,237,0.35)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Diagnosis
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          color: col, background: hexToRgba(col, 0.15), border: `1px solid ${hexToRgba(col, 0.4)}`,
        }}>{c}%</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg)', fontWeight: 600, wordBreak: 'break-word' }}>
        {final.answer}
      </div>
      {final.notes && (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: 5 }}>{final.notes}</div>
      )}
      {scores && <PhiBars scores={scores} />}
      <Citations items={final.citations} />
    </div>
  );
}

// ── navigation trail ────────────────────────────────────────────────────────────
function NavTrail({ trail, onFocus }) {
  if (!trail?.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...META_LABEL, marginBottom: 4 }}>Navigation trail · {trail.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {trail.map((r, i) => (
          <div
            key={i}
            onClick={() => onFocus(r)}
            title="Focus this region in the viewer"
            style={{
              cursor: 'pointer', borderRadius: 5, padding: '3px 7px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'baseline', gap: 6,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', flexShrink: 0 }}>#{i + 1}</span>
            <span style={{ fontSize: 10, color: 'var(--fg)', lineHeight: 1.35, wordBreak: 'break-word' }}>
              {r.rationale || <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>x{num(r.x)} y{num(r.y)}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', paddingLeft: 14, marginBottom: 8, gap: 4, alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 5, height: 5, borderRadius: '50%', background: 'var(--muted)',
          animation: 'pa-bounce 1.2s ease-in-out infinite', animationDelay: `${i * 0.2}s`,
        }} />
      ))}
      <span style={{ fontSize: 9.5, color: 'var(--muted)', marginLeft: 4 }}>reasoning…</span>
    </div>
  );
}

// ── header/footer control button ────────────────────────────────────────────────
function CtrlButton({ onClick, disabled, active, activeColor = '124,58,237', textColor = '#a78bfa', title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 9, padding: '3px 9px', borderRadius: 999,
        cursor: disabled ? 'default' : 'pointer',
        background: active ? `rgba(${activeColor},0.2)` : 'transparent',
        border: active ? `1px solid rgba(${activeColor},0.45)` : '1px solid var(--border)',
        color: active ? textColor : 'var(--muted)',
        opacity: disabled ? 0.4 : 1, transition: 'all 0.15s',
      }}
    >{children}</button>
  );
}

// ── main panel ────────────────────────────────────────────────────────────────
export default function PathAgentPanel() {
  const {
    activeItem, viewer,
    agentTrace, agentStatus, agentCacheKey, agentRunning, agentNavTrail,
    agentHeatmap, agentFinal, agentFollow, agentError,
    addAgentEvent, pushNavRegion, setAgentStatus, setAgentCacheKey, setAgentRunning,
    setAgentHeatmap, setAgentFinal, setAgentFollow, setAgentError, resetAgentRun,
  } = useStore();

  const [input, setInput] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved

  const abortRef = useRef(null);
  const pollRef = useRef(null);
  const heatmapRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  const ready = agentStatus?.ready?.features === true;
  const terminal = agentStatus?.status === 'ready' || agentStatus?.status === 'error';
  const canPrepare = !preparing && (!agentCacheKey || agentStatus?.status === 'error');

  // φ scores for the final card come from the last verify event.
  const finalPhi = useMemo(() => {
    if (!agentFinal) return null;
    for (let i = agentTrace.length - 1; i >= 0; i--) {
      if (agentTrace[i].type === 'verify') return agentTrace[i].scores;
    }
    return null;
  }, [agentFinal, agentTrace]);

  // Auto-scroll the trace to the bottom on new events.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [agentTrace.length, agentRunning, agentFinal]);

  // Poll preprocess status while a cacheKey is set and status is not terminal.
  useEffect(() => {
    if (!agentCacheKey || !activeItem?._id) return undefined;
    const st0 = useStore.getState().agentStatus;
    if (st0?.status === 'ready' || st0?.status === 'error') return undefined;

    const tick = async () => {
      try {
        const st = await pollStatus(activeItem._id, agentCacheKey);
        setAgentStatus(st);
        if (st.status === 'ready' || st.status === 'error') clearInterval(pollRef.current);
      } catch (err) {
        setAgentError(err?.message || 'status poll failed');
        clearInterval(pollRef.current);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 3000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentCacheKey, activeItem?._id]);

  // Unmount cleanup: abort stream, stop polling, drop heatmap overlay.
  useEffect(() => () => {
    abortRef.current?.abort();
    clearInterval(pollRef.current);
    if (heatmapRef.current) removeHeatmapOverlay(viewer, heatmapRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearHeatmapOverlay = useCallback(() => {
    if (heatmapRef.current) {
      removeHeatmapOverlay(viewer, heatmapRef.current);
      heatmapRef.current = null;
    }
  }, [viewer]);

  const handleFocus = useCallback((region) => {
    if (region) focusRegion(viewer, region);
  }, [viewer]);

  const handlePrepare = useCallback(async () => {
    if (!activeItem?._id || preparing) return;
    if (agentCacheKey && agentStatus?.status !== 'error') return; // guard duplicate Prepare
    setPreparing(true);
    setAgentError(null);
    try {
      const { cacheKey } = await preprocessCase(activeItem._id);
      setAgentStatus(null);
      setAgentCacheKey(cacheKey); // triggers the polling effect
    } catch (err) {
      setAgentError(err?.message || 'prepare failed');
    } finally {
      setPreparing(false);
    }
  }, [activeItem?._id, agentCacheKey, agentStatus?.status, preparing, setAgentCacheKey, setAgentStatus, setAgentError]);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if (!question || agentRunning || !ready) return;

    clearHeatmapOverlay();
    resetAgentRun();
    setAgentRunning(true);
    setInput('');
    abortRef.current = new AbortController();

    try {
      await streamAgentQuery({
        itemId: activeItem._id, cacheKey: agentCacheKey, question, task: 'Diagnosis',
        signal: abortRef.current.signal,
        onEvent: (evt) => {
          addAgentEvent(evt);
          if (evt.type === 'navigate' && evt.region) {
            pushNavRegion({ ...evt.region, rationale: evt.rationale });
            if (useStore.getState().agentFollow) focusRegion(viewer, evt.region);
          } else if (evt.type === 'final') {
            setAgentFinal(evt);
            if (evt.heatmapTaskId) setAgentHeatmap({ taskId: evt.heatmapTaskId, visible: false });
          } else if (evt.type === 'error') {
            setAgentError(evt.message);
          }
        },
      });
    } catch (err) {
      if (err?.name !== 'AbortError') setAgentError(err?.message || 'query failed');
    } finally {
      setAgentRunning(false);
    }
  }, [
    input, agentRunning, ready, activeItem?._id, agentCacheKey, viewer,
    clearHeatmapOverlay, resetAgentRun, setAgentRunning, addAgentEvent, pushNavRegion,
    setAgentFinal, setAgentHeatmap, setAgentError,
  ]);

  const handleStop = useCallback(() => { abortRef.current?.abort(); }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleToggleHeatmap = useCallback(async () => {
    if (!agentHeatmap?.taskId) return;
    try {
      if (agentHeatmap.visible) {
        clearHeatmapOverlay();
        setAgentHeatmap({ ...agentHeatmap, visible: false });
      } else {
        heatmapRef.current = await addHeatmapOverlay(viewer, activeItem._id, agentHeatmap.taskId, agentCacheKey);
        setAgentHeatmap({ ...agentHeatmap, visible: true });
      }
    } catch (err) {
      setAgentError(err?.message || 'heatmap failed');
    }
  }, [agentHeatmap, viewer, activeItem?._id, agentCacheKey, clearHeatmapOverlay, setAgentHeatmap, setAgentError]);

  const handleSaveAnnotation = useCallback(async () => {
    if (!agentNavTrail.length || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const elements = agentNavTrail.map((r, i) => makeRectangle(
        r.x, r.y, r.x + r.width, r.y + r.height,
        { group: 'ai-roi', lineColor: '#c27aff', label: `${i + 1}. ${r.rationale || 'region'}` },
      ));
      const doc = {
        name: `PathAgent — ${agentFinal?.answer?.slice(0, 60) || 'run'}`,
        description: [
          agentFinal?.answer,
          agentFinal && `Confidence ${agentFinal.confidence}%`,
          ...(agentFinal?.citations || []).map((c) => `• ${c.text} (${c.source})`),
        ].filter(Boolean).join('\n'),
        attributes: { group: 'ai-roi', source: 'pathagent' },
        elements,
      };
      await createAnnotation(activeItem._id, doc);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (err) {
      setAgentError(err?.message || 'save failed');
      setSaveState('idle');
    }
  }, [agentNavTrail, agentFinal, activeItem?._id, saveState, setAgentError]);

  const handleClear = useCallback(() => {
    clearHeatmapOverlay();
    resetAgentRun();
  }, [clearHeatmapOverlay, resetAgentRun]);

  // Guard — no slide open.
  if (!activeItem) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
        Open a slide to start a PathAgent run.
      </div>
    );
  }

  const hasRun = agentTrace.length > 0 || agentNavTrail.length > 0 || !!agentFinal;
  const statusTitle = agentStatus?.status === 'error'
    ? 'Preprocessing failed'
    : !agentCacheKey
      ? 'Case not prepared for PathAgent'
      : 'Preparing case… (features + consensus)';
  const showProgress = !terminal && (preparing || !!agentCacheKey);

  // running counter for navigate rows
  let navSeen = 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <style>{`
        @keyframes pa-bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{
        padding: '8px 10px 6px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)' }}>🧭 PathAgent</span>
          <span style={{
            fontSize: 9.5, fontWeight: 600, padding: '2px 9px', borderRadius: 999,
            background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.4)', color: '#a78bfa',
          }}>Diagnosis</span>
        </div>
        {hasRun && (
          <CtrlButton onClick={handleClear} title="Clear this run">Clear</CtrlButton>
        )}
      </div>

      {/* Prepare / status banner */}
      {(!agentCacheKey || !ready) && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(124,58,237,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, color: 'var(--fg)', fontWeight: 600 }}>{statusTitle}</div>
              {agentStatus?.stage && (
                <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 1 }}>{agentStatus.stage}</div>
              )}
            </div>
            <button
              onClick={handlePrepare}
              disabled={!canPrepare}
              title="Run Trident preprocessing (features + consensus) — can take a few minutes"
              style={{
                fontSize: 10, fontWeight: 600, padding: '4px 12px', borderRadius: 6, flexShrink: 0,
                cursor: canPrepare ? 'pointer' : 'default',
                background: canPrepare ? 'rgba(124,58,237,0.8)' : 'rgba(124,58,237,0.2)',
                border: '1px solid rgba(124,58,237,0.4)', color: '#fff', opacity: canPrepare ? 1 : 0.6,
              }}
            >
              {preparing ? 'Preparing…' : agentStatus?.status === 'error' ? 'Retry' : 'Prepare'}
            </button>
          </div>
          {showProgress && (
            <div style={{ marginTop: 7, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.round(clamp01(agentStatus?.progress) * 100)}%`, height: '100%',
                background: 'rgba(124,58,237,0.75)', transition: 'width 0.3s',
              }} />
            </div>
          )}
          {agentStatus?.status === 'error' && agentStatus?.stage && (
            <div style={{ fontSize: 9.5, color: '#f87171', marginTop: 6 }}>{agentStatus.stage}</div>
          )}
        </div>
      )}

      {/* Trace thread */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px', minHeight: 0 }}>
        {!hasRun ? (
          <div style={{ padding: '24px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, marginBottom: 8 }}>🧭</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>PathAgent</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
              {ready
                ? 'Ask a diagnostic question. The agent will navigate the slide and reason step by step.'
                : 'Prepare the case above, then ask a diagnostic question.'}
            </div>
          </div>
        ) : (
          <>
            <div style={{ borderLeft: '1px solid var(--border)', marginLeft: 4 }}>
              {agentTrace.map((evt, i) => {
                const navIdx = evt.type === 'navigate' ? navSeen++ : -1;
                return <TraceEvent key={i} evt={evt} navIdx={navIdx} onFocus={handleFocus} />;
              })}
            </div>
            {agentRunning && !agentFinal && <TypingIndicator />}
            <FinalCard final={agentFinal} scores={finalPhi} />
            <NavTrail trail={agentNavTrail} onFocus={handleFocus} />
          </>
        )}
        {agentError && (
          <div style={{ fontSize: 10, color: '#f87171', padding: '6px 0', textAlign: 'center' }}>{agentError}</div>
        )}
      </div>

      {/* Controls bar */}
      <div style={{
        padding: '6px 8px', borderTop: '1px solid var(--border)',
        display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <CtrlButton
          onClick={() => setAgentFollow(!agentFollow)}
          active={agentFollow}
          activeColor="16,185,129"
          textColor="#34d399"
          title={agentFollow ? 'Viewer follows the agent — click to pause' : 'Viewer paused — click to follow'}
        >
          {agentFollow ? '⦿ Following' : '⦾ Paused'}
        </CtrlButton>
        <CtrlButton
          onClick={handleToggleHeatmap}
          disabled={!agentHeatmap?.taskId}
          active={agentHeatmap?.visible}
          title={agentHeatmap?.taskId ? 'Toggle attention heatmap overlay' : 'Heatmap available after a run'}
        >
          {agentHeatmap?.visible ? '◼ Heatmap' : '◻ Heatmap'}
        </CtrlButton>
        <CtrlButton
          onClick={handleSaveAnnotation}
          disabled={!agentNavTrail.length || saveState === 'saving'}
          active={saveState === 'saved'}
          activeColor="16,185,129"
          textColor="#34d399"
          title="Save visited regions as an annotation"
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : 'Save ROIs'}
        </CtrlButton>
      </div>

      {/* Input row */}
      <div style={{
        padding: '8px 8px 10px', borderTop: '1px solid var(--border)',
        display: 'flex', gap: 6, alignItems: 'flex-end',
      }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={ready
            ? 'Ask a diagnostic question… (Enter to send, Shift+Enter for newline)'
            : 'Prepare the case to enable questions…'}
          rows={2}
          disabled={!ready || agentRunning}
          style={{
            flex: 1, resize: 'none', fontSize: 11, lineHeight: 1.5,
            padding: '6px 8px', borderRadius: 6,
            background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
            color: 'var(--fg)', outline: 'none', fontFamily: 'inherit',
            opacity: ready ? 1 : 0.5,
          }}
        />
        {agentRunning ? (
          <button
            onClick={handleStop}
            title="Stop the run"
            style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
              background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f87171',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!(ready && input.trim())}
            title="Run PathAgent"
            style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
              background: ready && input.trim() ? 'rgba(124,58,237,0.8)' : 'rgba(124,58,237,0.2)',
              border: '1px solid rgba(124,58,237,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', transition: 'background 0.15s',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
