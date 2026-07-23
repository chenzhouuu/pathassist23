// src/components/panels/CopilotPanel.jsx
// Copilot — the conversational panel over the autonomous /turns agent loop.
// Each message runs ONE agent turn that streams typed events (reasoning · tool calls · text),
// folded live into a render-ready trace (copilotTurn.js). The agent drives the viewer through
// client tools (co-navigation) and measures through gated server tools; a gate denial surfaces
// an inline "Approve & run" that re-sends the same ask with approval. Conversations persist
// per (Girder user, slide); only the final answer text survives a reload, the trace is live.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import {
  streamTurn, fetchTurnArtifact, listConversations, createConversation,
  getConversation, deleteConversation, checkHealth,
} from '../../api/copilotApi.js';
import { focusRegion, currentViewportBbox } from './agentViewerSync.js';
import { initTrace, reduceTurnEvent } from './copilotTurn.js';
import { Markdown } from './markdown.jsx';

// ── tiny inline icons (stroke = currentColor) ───────────────────────────────────
const Icon = ({ d, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);
const HistoryIcon = () => <Icon d={['M3 3v5h5', 'M3.05 13A9 9 0 1 0 6 5.3L3 8', 'M12 7v5l3 2.5']} />;
const PlusIcon = () => <Icon d="M12 5v14M5 12h14" />;
const BackIcon = () => <Icon d="M19 12H5M12 19l-7-7 7-7" />;
const TrashIcon = () => <Icon d={['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6']} size={13} />;
const CheckIcon = () => <Icon d="M20 6 9 17l-5-5" size={13} />;
const CloseIcon = () => <Icon d="M18 6 6 18M6 6l12 12" size={13} />;
const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
const ChevronIcon = ({ open }) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);
// client tool → a compass (co-navigation); server tool → a scan target (measurement)
const CompassIcon = () => <Icon d={['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
  'M16.24 7.76 14 14l-6.24 2.24L10 10z']} size={12} />;
const ScanIcon = () => <Icon d={['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2',
  'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M12 9v6', 'M9 12h6']} size={12} />;
const ShieldIcon = ({ size = 12 }) => <Icon d={['M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z']} size={size} />;
const RectIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinejoin="round" strokeDasharray="4 3">
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
  </svg>
);

const r0 = (n) => Math.round(n);
const fmtRoi = (r) => `${r0(r.width)}×${r0(r.height)} @ (${r0(r.x)}, ${r0(r.y)})`;
const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);

// Rebuild the thread from a hydrated conversation: turns → bubbles. The live trace is
// ephemeral (only the assistant's final answer text persists), so a reload shows plain
// bubbles; the rich trace appears only while a turn streams.
function buildMessages(full) {
  return (full.turns || []).map((t) => ({ role: t.role, text: t.text, roi: t.roi }));
}

// The region a conversation is focused on: the most recent user turn's ROI, stripped to the
// composer's { x, y, width, height } shape. Re-attaches the sticky region on (re)open.
function lastUserTurnRoi(full) {
  const turns = full.turns || [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.role === 'user' && t.roi) {
      const { x, y, width, height } = t.roi;
      return { x, y, width, height };
    }
  }
  return null;
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function CopilotPanel() {
  const {
    activeItem,
    copilotMessages, copilotConversationId, copilotStreaming, copilotError,
    addCopilotMessage, setCopilotMessages, setLastCopilotMessage,
    setCopilotConversationId, setCopilotStreaming, setCopilotError, resetCopilot,
    setDrawingMode, roiSelectResult, clearRoiSelectResult,
    copilotRoi, setCopilotRoi, restoreCopilotRoi, shownRoi, setShownRoi, viewer,
    setCopilotNuclei, clearCopilotNuclei, showNucleiOverlay, toggleNucleiOverlay,
    addCopilotRegion, clearCopilotRegions,
  } = useStore();
  const [input, setInput] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null);   // conversation pending delete-confirm
  const [mode, setMode] = useState(null);             // 'claude' | 'echo' — is the backend keyed
  const [awaitingRoi, setAwaitingRoi] = useState(false);  // waiting for the user to draw a box
  const threadRef = useRef(null);
  const abortRef = useRef(null);
  const traceRef = useRef(initTrace());   // the in-flight turn's accumulating trace

  const itemId = activeItem?._id || null;

  // Reuse the viewer's roi-select handshake: startRoi() puts the canvas in select mode;
  // AnnotationCanvas writes roiSelectResult when the box is drawn, and we capture it here.
  const startRoi = () => {
    if (!itemId || copilotStreaming) return;
    clearRoiSelectResult();
    setAwaitingRoi(true);
    setDrawingMode('roi-select');
  };
  const cancelRoi = () => {
    setAwaitingRoi(false);
    setDrawingMode(null);
  };
  useEffect(() => {
    if (awaitingRoi && roiSelectResult) {
      const { x, y, width, height } = roiSelectResult;
      const roi = { x, y, width, height };
      setCopilotRoi(roi);   // attach to the next message
      setShownRoi(roi);     // and paint it while composing
      setAwaitingRoi(false);
      clearRoiSelectResult();
    }
  }, [awaitingRoi, roiSelectResult, clearRoiSelectResult, setCopilotRoi, setShownRoi]);

  // Reveal a region on the viewer: pan/zoom to it and paint the box. Clicking the same region
  // again hides it (toggle). Display only — never changes the pending attachment.
  const showRoi = useCallback((roi) => {
    if (!roi) return;
    const same = shownRoi && shownRoi.x === roi.x && shownRoi.y === roi.y
      && shownRoi.width === roi.width && shownRoi.height === roi.height;
    if (same) { setShownRoi(null); return; }
    setShownRoi({ x: roi.x, y: roi.y, width: roi.width, height: roi.height });
    if (viewer) focusRegion(viewer, roi);
  }, [shownRoi, setShownRoi, viewer]);

  useEffect(() => { setAwaitingRoi(false); }, [itemId]);

  // Which chat backend is configured server-side, so the UI can label itself honestly.
  useEffect(() => {
    let ok = true;
    checkHealth().then((h) => { if (ok) setMode(h.chat || null); }).catch(() => {});
    return () => { ok = false; };
  }, []);

  const refreshList = useCallback(async () => {
    if (!itemId) { setConversations([]); return []; }
    const convs = await listConversations(itemId);
    setConversations(convs);
    return convs;
  }, [itemId]);

  // Hydrate for the current slide: list conversations + load the newest into the thread.
  useEffect(() => {
    if (!itemId) { setConversations([]); return undefined; }
    let cancelled = false;
    (async () => {
      setLoadingHistory(true);
      setCopilotError(null);
      try {
        const convs = await listConversations(itemId);
        if (cancelled) return;
        setConversations(convs);
        if (convs.length) {
          const full = await getConversation(convs[0].id);
          if (cancelled) return;
          setCopilotConversationId(full.id);
          setCopilotMessages(buildMessages(full));
          restoreCopilotRoi(itemId, lastUserTurnRoi(full));
        } else {
          setCopilotConversationId(null);
          setCopilotMessages([]);
          restoreCopilotRoi(itemId, null);   // no conversation yet, but a staged box may persist
        }
      } catch (err) {
        if (!cancelled) setCopilotError(err.message || 'Could not load history');
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [itemId, setCopilotError, setCopilotConversationId, setCopilotMessages, restoreCopilotRoi]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [copilotMessages, copilotStreaming]);

  // Run one agent turn: persist+render the user bubble, then stream typed events into a live
  // trace. `textArg` (a re-run of a gated ask) overrides the composer; `approved` lifts the
  // tool gate. Side effects ride the same events: client tools drive the viewer, a server
  // tool's artifact handle pulls its geometry into the overlay.
  const runTurn = useCallback(async ({ textArg = null, approved = false } = {}) => {
    const text = (textArg ?? input).trim();
    if (!text || copilotStreaming || !itemId) return;
    if (textArg == null) setInput('');
    setCopilotError(null);
    const roi = copilotRoi ? { kind: 'rect', ...copilotRoi } : null;

    let convId = copilotConversationId;
    try {
      if (!convId) {
        const conv = await createConversation({ itemId });
        convId = conv.id;
        setCopilotConversationId(convId);
      }
    } catch (err) {
      setCopilotError(err.message || 'Could not start conversation');
      return;
    }

    addCopilotMessage({ role: 'user', text, roi });
    traceRef.current = initTrace();
    addCopilotMessage({ role: 'assistant', trace: traceRef.current });
    setShownRoi(null);   // unpaint the composing box; the chip stays as the sticky indicator
    setCopilotStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamTurn({
        conversationId: convId,
        text,
        roi,
        viewer: currentViewportBbox(viewer),
        approved,
        signal: ctrl.signal,
        onEvent: (evt) => {
          traceRef.current = reduceTurnEvent(traceRef.current, evt);
          setLastCopilotMessage({ role: 'assistant', trace: traceRef.current });
          // Co-navigation: a client viewer tool moves the slide to where the agent is looking.
          if (evt.type === 'tool_call_start' && evt.tool_class === 'client') {
            const bbox = evt.args?.bbox;
            if (bbox && viewer) { focusRegion(viewer, bbox); setShownRoi(bbox); }
          }
          // A server tool's artifact handle → pull the geometry out-of-band into the overlay.
          if (evt.type === 'tool_call_result' && evt.artifact?.kind === 'nuclei') {
            fetchTurnArtifact(convId, evt.artifact.ref)
              .then((n) => setCopilotNuclei(n))
              .catch(() => {});
          }
          // A described region rides inline (bbox + magnification) — paint it as a rectangle.
          if (evt.type === 'tool_call_result' && evt.artifact?.kind === 'region') {
            addCopilotRegion({
              bbox: evt.artifact.bbox,
              magnification: evt.artifact.meta?.magnification,
            });
          }
        },
      });
    } catch (err) {
      // A user Stop aborts the fetch (AbortError) — a clean, non-error terminal state; any
      // other failure is a real run error. Both fold into the trace so the turn stops looking live.
      const evt = err.name === 'AbortError'
        ? { type: 'run_stopped' }
        : { type: 'run_error', message: err.message || 'Copilot request failed' };
      traceRef.current = reduceTurnEvent(traceRef.current, evt);
      setLastCopilotMessage({ role: 'assistant', trace: traceRef.current });
    } finally {
      setCopilotStreaming(false);
      abortRef.current = null;
      refreshList().catch(() => {});   // pick up the auto-title + turn count + new ordering
    }
  }, [input, copilotStreaming, itemId, copilotConversationId, copilotRoi, viewer, setShownRoi,
      addCopilotMessage, setLastCopilotMessage, setCopilotConversationId, setCopilotStreaming,
      setCopilotError, setCopilotNuclei, addCopilotRegion, refreshList]);

  // Stop the in-flight turn: abort the fetch. The SSE read throws AbortError, which runTurn
  // folds into a `run_stopped` trace, reclaiming the UI at once. The server-side GPU analysis
  // it already kicked off may still finish on its own — the abort just stops us waiting.
  const stopTurn = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runTurn(); }
  };

  const handleNew = () => {
    if (abortRef.current) abortRef.current.abort();
    if (awaitingRoi) cancelRoi();
    setCopilotRoi(null);
    setShownRoi(null);
    clearCopilotNuclei();
    clearCopilotRegions();
    resetCopilot();
    setHistoryOpen(false);
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    setConfirmId(null);
    try { await refreshList(); } catch (err) { setCopilotError(err.message); }
  };

  const openConversation = async (id) => {
    if (copilotStreaming) return;
    if (awaitingRoi) cancelRoi();
    setShownRoi(null);
    clearCopilotNuclei();
    clearCopilotRegions();
    setHistoryOpen(false);
    setCopilotError(null);
    try {
      const full = await getConversation(id);
      setCopilotConversationId(full.id);
      setCopilotMessages(buildMessages(full));
      setCopilotRoi(lastUserTurnRoi(full));   // adopt this thread's region (persists per slide)
    } catch (err) {
      setCopilotError(err.message || 'Could not open conversation');
    }
  };

  const handleDelete = async (id) => {
    setCopilotError(null);
    try {
      await deleteConversation(id);
      if (id === copilotConversationId) resetCopilot();   // was active → back to a fresh thread
      await refreshList();
    } catch (err) {
      setCopilotError(err.message || 'Could not delete conversation');
    } finally {
      setConfirmId(null);
    }
  };

  const canSend = !!input.trim() && !copilotStreaming && !!itemId;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0, overflow: 'hidden', color: 'var(--fg)' }}>
      <style>{CP_CSS}</style>

      {/* header */}
      <div className="cp-header">
        <span className="cp-mark">◆</span>
        <span className="cp-title">Copilot</span>
        {mode && (
          <span className="cp-mode" data-mode={mode} title={mode === 'claude'
            ? 'Autonomous agent on Claude' : 'Echo fallback — set AGENT_ANTHROPIC_API_KEY for Claude'}>
            <i />{mode === 'claude' ? 'Claude' : 'echo'}
          </span>
        )}
        <span className="cp-spacer" />
        <button className="cp-btn" onClick={openHistory} title="Conversation history"
          disabled={!itemId}>
          <HistoryIcon />
          <span>History</span>
          {conversations.length > 0 && <span className="cp-count">{conversations.length}</span>}
        </button>
        <button className="cp-btn cp-btn--accent" onClick={handleNew} title="New conversation"
          disabled={!itemId}>
          <PlusIcon /><span>New</span>
        </button>
      </div>

      {/* thread */}
      <div ref={threadRef} className="cp-thread">
        {loadingHistory && copilotMessages.length === 0 && (
          <div className="cp-hint">Loading history…</div>
        )}
        {!loadingHistory && copilotMessages.length === 0 && (
          <div className="cp-empty">
            {itemId ? (
              <>
                <div className="cp-empty-mark">◆</div>
                <p>Ask about this slide and I'll <b>act on it</b> — pan and zoom to a region,
                  then run analysis to <b>measure</b>. Counts come only from the tools, never
                  invented.</p>
                <p className="cp-empty-eg">Try “What's in this region?” or draw a
                  <RectIcon size={10} /> Region and ask “Count the nuclei here.”</p>
                <p className="cp-empty-slide">Slide in context · <span>{activeItem.name}</span></p>
              </>
            ) : (
              <p>Open a slide, then start a conversation here.</p>
            )}
          </div>
        )}
        {copilotMessages.map((m, i) => (
          m.role === 'assistant' && m.trace ? (
            <TurnTrace
              key={i}
              trace={m.trace}
              streaming={copilotStreaming && i === copilotMessages.length - 1}
              showOverlay={showNucleiOverlay}
              onToggleOverlay={toggleNucleiOverlay}
              onShowRoi={showRoi}
              onApprove={() => runTurn({ textArg: copilotMessages[i - 1]?.text, approved: true })}
              canApprove={!copilotStreaming}
            />
          ) : (
            <Bubble
              key={i}
              role={m.role}
              text={m.text}
              roi={m.roi}
              onShowRoi={showRoi}
            />
          )
        ))}
        {copilotError && <div className="cp-error">{copilotError}</div>}
      </div>

      {/* composer */}
      <div className="cp-composer-shell">
        {itemId && (
          <div className="cp-roibar">
            {copilotRoi ? (
              <span className="cp-roichip" title="Attached to your next message — click coords to show it on the slide">
                <button type="button" className="cp-roichip-coords" onClick={() => showRoi(copilotRoi)}>
                  <RectIcon />{fmtRoi(copilotRoi)}
                </button>
                <button className="cp-roichip-x" onClick={() => { setCopilotRoi(null); setShownRoi(null); }}
                  title="Remove region"><CloseIcon /></button>
              </span>
            ) : awaitingRoi ? (
              <span className="cp-roihint">
                <span className="cp-roidot" />Draw a box on the slide…
                <button className="cp-roilink" onClick={cancelRoi}>cancel</button>
              </span>
            ) : (
              <button className="cp-roibtn" onClick={startRoi} disabled={copilotStreaming}
                title="Ground your next message to a region on the slide">
                <RectIcon /> Region
              </button>
            )}
          </div>
        )}
        <div className="cp-composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={itemId ? 'Message the copilot…  (⌘/Ctrl + ⏎)' : 'Open a slide to begin'}
            disabled={!itemId}
          />
          {copilotStreaming ? (
            <button className="cp-send cp-stop" onClick={stopTurn}
              title="Stop the current turn">
              <StopIcon />
            </button>
          ) : (
            <button className="cp-send" onClick={() => runTurn()} disabled={!canSend}
              title="Send (⌘/Ctrl + ⏎)">➤</button>
          )}
        </div>
      </div>

      {/* history drawer */}
      {historyOpen && (
        <div className="cp-drawer">
          <div className="cp-drawer-head">
            <button className="cp-btn cp-btn--icon" onClick={() => setHistoryOpen(false)}
              title="Back to chat"><BackIcon /></button>
            <span className="cp-drawer-title">Conversations</span>
            <span className="cp-spacer" />
            <button className="cp-btn cp-btn--accent" onClick={handleNew} title="New conversation">
              <PlusIcon /><span>New</span>
            </button>
          </div>
          <div className="cp-list">
            {conversations.length === 0 && (
              <div className="cp-hint" style={{ padding: '18px 14px' }}>
                No saved conversations for this slide yet.
              </div>
            )}
            {conversations.map((c, i) => {
              const active = c.id === copilotConversationId;
              const confirming = c.id === confirmId;
              return (
                <div
                  key={c.id}
                  className="cp-conv"
                  data-active={active ? '1' : undefined}
                  style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                  onClick={() => !confirming && openConversation(c.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="cp-conv-accent" />
                  <div className="cp-conv-main">
                    <div className="cp-conv-title">{c.title || 'Untitled conversation'}</div>
                    <div className="cp-conv-meta">
                      {relTime(c.updated_at)}
                      {typeof c.turn_count === 'number' && <> · {c.turn_count} msg</>}
                      {active && <span className="cp-conv-live">active</span>}
                    </div>
                  </div>
                  {confirming ? (
                    <div className="cp-confirm" onClick={(e) => e.stopPropagation()}>
                      <span>Delete?</span>
                      <button className="cp-icon cp-icon--danger" title="Confirm delete"
                        onClick={() => handleDelete(c.id)}><CheckIcon /></button>
                      <button className="cp-icon" title="Cancel"
                        onClick={() => setConfirmId(null)}><CloseIcon /></button>
                    </div>
                  ) : (
                    <button className="cp-icon cp-conv-trash" title="Delete conversation"
                      onClick={(e) => { e.stopPropagation(); setConfirmId(c.id); }}>
                      <TrashIcon />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Bubble({ role, text, roi, onShowRoi }) {
  const isUser = role === 'user';
  return (
    <div className={`cp-bubble-wrap ${isUser ? 'is-user' : 'is-bot'}`}>
      {roi && (
        <button type="button" className="cp-msg-roi" onClick={() => onShowRoi?.(roi)}
          title="Show this region on the slide">
          <RectIcon size={10} />{fmtRoi(roi)}
        </button>
      )}
      <div className={`cp-bubble ${isUser ? 'cp-bubble--user' : 'cp-bubble--bot'}`}>
        {isUser ? (text || '') : (text ? <Markdown text={text} /> : '…')}
      </div>
    </div>
  );
}

// A live agent turn: collapsible reasoning, an ordered rail of tool cards (client = viewer
// navigation, server = measurement, with gate + evidence affordances), and the answer.
function TurnTrace({ trace, streaming, showOverlay, onToggleOverlay, onShowRoi, onApprove, canApprove }) {
  const [showThinking, setShowThinking] = useState(true);   // thinking visible by default
  const hasReasoning = !!trace.reasoning.trim();
  const thinking = streaming && !trace.text && trace.steps.length === 0;
  return (
    <div className="cp-turn">
      {thinking && !hasReasoning && (
        <div className="cp-think-live"><span className="cp-think-dots"><i /><i /><i /></span>Thinking…</div>
      )}

      {hasReasoning && (
        <div className="cp-think">
          <button type="button" className="cp-think-toggle" onClick={() => setShowThinking((v) => !v)}>
            <ChevronIcon open={showThinking} />
            <span>Reasoning</span>
            {streaming && !trace.text && <span className="cp-think-pulse" />}
          </button>
          {showThinking && <div className="cp-think-body">{trace.reasoning}</div>}
        </div>
      )}

      {trace.steps.length > 0 && (
        <div className="cp-steps">
          {trace.steps.map((s) => (
            <ToolCard key={s.id} step={s} showOverlay={showOverlay}
              onToggleOverlay={onToggleOverlay} onShowRoi={onShowRoi} />
          ))}
        </div>
      )}

      {trace.text && (
        <div className="cp-answer">
          <Markdown text={trace.text} />{streaming && <span className="cp-caret">▍</span>}
        </div>
      )}

      {trace.needsApproval && (
        <div className="cp-approve">
          <span className="cp-approve-note"><ShieldIcon size={11} />Analysis held for approval</span>
          <button className="cp-approve-btn" onClick={onApprove} disabled={!canApprove}>
            Approve &amp; run
          </button>
        </div>
      )}

      {trace.status === 'stopped' && (
        <div className="cp-turn-stopped">Stopped.</div>
      )}

      {trace.status === 'error' && trace.error && (
        <div className="cp-turn-err">{trace.error}</div>
      )}
    </div>
  );
}

// One tool call as a card: class-tinted icon, name, status, summary, and — for a server tool
// that produced nuclei — an evidence chip that toggles the overlay; for a client tool, a link
// back to the region it framed.
function ToolCard({ step, showOverlay, onToggleOverlay, onShowRoi }) {
  const isClient = step.toolClass === 'client';
  const bbox = step.args?.bbox;
  const hasNuclei = step.artifact?.kind === 'nuclei';
  const region = step.artifact?.kind === 'region' ? step.artifact : null;
  const regionMag = region?.meta?.magnification;
  const st = step.gated ? 'gated' : step.status;
  return (
    <div className="cp-tool" data-class={step.toolClass} data-st={st}>
      <span className="cp-tool-ic">{isClient ? <CompassIcon /> : <ScanIcon />}</span>
      <div className="cp-tool-body">
        <div className="cp-tool-top">
          <span className="cp-tool-name">{step.name}</span>
          <span className="cp-tool-tag">{isClient ? 'viewer' : 'analysis'}</span>
          <span className="cp-tool-status" data-st={st}>
            {st === 'running' && <span className="cp-spin" />}
            {st === 'ok' && <CheckIcon />}
            {st === 'gated' && <ShieldIcon size={12} />}
            {st === 'error' && <CloseIcon />}
          </span>
        </div>
        {step.summary && <div className="cp-tool-sum">{step.summary}</div>}
        <div className="cp-tool-foot">
          {isClient && bbox && (
            <button type="button" className="cp-tool-roi" onClick={() => onShowRoi?.(bbox)}
              title="Show this region on the slide"><RectIcon size={10} />{fmtRoi(bbox)}</button>
          )}
          {hasNuclei && (
            <button type="button" className="cp-tool-evi" onClick={onToggleOverlay}
              title="Toggle the nuclei overlay on the slide">
              <span className="cp-tool-dot" />{fmtInt(step.artifact.count)} nuclei ·
              {showOverlay ? ' hide' : ' show'}
            </button>
          )}
          {region && region.bbox && (
            <button type="button" className="cp-tool-region" onClick={() => onShowRoi?.(region.bbox)}
              title="Show the described region on the slide">
              <RectIcon size={10} />{fmtRoi(region.bbox)}
              {regionMag ? ` · ${(+regionMag).toFixed(regionMag < 1 ? 2 : 0)}×` : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Scoped styles — kept in-file so the panel is self-contained. Prefix `cp-` avoids collisions
// with the app's Tailwind/theme layers; colors come from the theme vars.
const CP_CSS = `
.cp-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.cp-mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;
  background:linear-gradient(160deg,#a78bfa,#7c3aed);color:#fff;font-size:11px;font-weight:700;
  box-shadow:0 0 0 1px rgba(167,139,250,.25),0 2px 8px rgba(124,58,237,.35)}
.cp-title{font-weight:600;font-size:13px;letter-spacing:.2px}
.cp-mode{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:monospace;
  color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:2px 7px}
.cp-mode i{width:5px;height:5px;border-radius:50%;background:#64748b}
.cp-mode[data-mode="claude"]{color:#c4b5fd;border-color:rgba(139,92,246,.35)}
.cp-mode[data-mode="claude"] i{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,.8)}
.cp-spacer{margin-left:auto}
.cp-btn{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);
  background:transparent;border:1px solid transparent;border-radius:7px;padding:4px 8px;cursor:pointer;
  transition:background .15s,color .15s,border-color .15s,opacity .15s}
.cp-btn:hover{background:rgba(148,163,184,.10);color:var(--fg)}
.cp-btn:disabled{opacity:.4;cursor:default}
.cp-btn--accent{color:#c4b5fd;border-color:rgba(139,92,246,.35)}
.cp-btn--accent:hover{background:rgba(139,92,246,.16);color:#ddd6fe}
.cp-btn--icon{padding:5px}
.cp-count{min-width:15px;height:15px;padding:0 4px;border-radius:8px;display:grid;place-items:center;
  font-size:9px;font-weight:700;color:#0b0c12;background:#a78bfa}
.cp-thread{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;display:flex;flex-direction:column;gap:10px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
.cp-hint{color:var(--muted);font-size:12px}
.cp-empty{color:var(--muted);font-size:12.5px;line-height:1.55;margin-top:6px;
  display:flex;flex-direction:column;gap:8px}
.cp-empty p{margin:0}
.cp-empty b{color:#c4b5fd;font-weight:600}
.cp-empty-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:15px;
  color:#a78bfa;background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.25)}
.cp-empty-eg{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.cp-empty-eg svg{vertical-align:-1px;margin:0 1px}
.cp-empty-slide{font-size:11px;color:var(--muted)}
.cp-empty-slide span{color:#a78bfa}
.cp-bubble-wrap{display:flex;flex-direction:column;gap:4px;max-width:88%;animation:cp-in .22s ease both}
.cp-bubble-wrap.is-user{align-self:flex-end;align-items:flex-end}
.cp-bubble-wrap.is-bot{align-self:flex-start;align-items:flex-start}
.cp-msg-roi{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-family:monospace;
  color:#c4b5fd;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.3);
  border-radius:6px;padding:2px 6px;cursor:pointer;transition:background .12s}
.cp-msg-roi:hover{background:rgba(139,92,246,.24)}
.cp-bubble{font-size:12.5px;line-height:1.5;padding:8px 11px;
  border-radius:12px 12px 12px 3px;background:var(--surface,#171a26);border:1px solid var(--border);
  white-space:pre-wrap;word-break:break-word}
.cp-bubble--user{color:#e9e3ff;border-radius:12px 12px 3px 12px;
  background:linear-gradient(160deg,#3b2a6b,#2a2050);border:1px solid rgba(167,139,250,.3)}
.cp-caret{opacity:.6}
.cp-error{font-size:11.5px;color:#f87171;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:7px 10px}

/* agent turn */
.cp-turn{align-self:stretch;display:flex;flex-direction:column;gap:8px;animation:cp-in .22s ease both}
.cp-think-live{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;color:var(--muted)}
.cp-think-dots{display:inline-flex;gap:3px}
.cp-think-dots i{width:5px;height:5px;border-radius:50%;background:#a78bfa;animation:cp-bounce 1.2s infinite}
.cp-think-dots i:nth-child(2){animation-delay:.15s}
.cp-think-dots i:nth-child(3){animation-delay:.3s}
.cp-think{border-left:2px solid rgba(139,92,246,.3);padding-left:9px}
.cp-think-toggle{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--muted);
  background:none;border:none;padding:0;cursor:pointer;transition:color .15s}
.cp-think-toggle:hover{color:#c4b5fd}
.cp-think-pulse{width:5px;height:5px;border-radius:50%;background:#a78bfa;animation:cp-pulse 1s infinite}
.cp-think-body{margin-top:5px;font-size:11.5px;line-height:1.55;color:var(--muted);white-space:pre-wrap;
  word-break:break-word}
.cp-steps{display:flex;flex-direction:column;gap:7px}
.cp-tool{display:flex;gap:9px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;
  background:var(--surface,#171a26);position:relative;overflow:hidden}
.cp-tool::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2.5px}
.cp-tool[data-class="client"]::before{background:linear-gradient(#38bdf8,#0ea5e9)}
.cp-tool[data-class="server"]::before{background:linear-gradient(#a78bfa,#7c3aed)}
.cp-tool[data-st="gated"]::before{background:linear-gradient(#fbbf24,#f59e0b)}
.cp-tool[data-st="error"]::before{background:linear-gradient(#f87171,#ef4444)}
.cp-tool-ic{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;flex:none;
  color:#c4b5fd;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.28)}
.cp-tool[data-class="client"] .cp-tool-ic{color:#7dd3fc;background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.3)}
.cp-tool-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.cp-tool-top{display:flex;align-items:center;gap:7px}
.cp-tool-name{font-family:monospace;font-size:11.5px;font-weight:600;color:var(--fg);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp-tool-tag{font-size:8.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);
  border:1px solid var(--border);border-radius:5px;padding:1px 5px;flex:none}
.cp-tool-status{margin-left:auto;display:grid;place-items:center;width:16px;height:16px;flex:none}
.cp-tool-status[data-st="ok"]{color:#34d399}
.cp-tool-status[data-st="gated"]{color:#f5a623}
.cp-tool-status[data-st="error"]{color:#f87171}
.cp-spin{width:12px;height:12px;border-radius:50%;border:2px solid rgba(148,163,184,.3);
  border-top-color:#a78bfa;animation:cp-spin .7s linear infinite}
.cp-tool-sum{font-size:11px;line-height:1.45;color:var(--muted);word-break:break-word}
.cp-tool[data-st="gated"] .cp-tool-sum{color:#b9975b}
.cp-tool-foot{display:flex;flex-wrap:wrap;gap:6px}
.cp-tool-roi,.cp-tool-evi{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-family:monospace;
  border-radius:6px;padding:2px 7px;cursor:pointer;transition:background .12s}
.cp-tool-roi{color:#7dd3fc;background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.3)}
.cp-tool-roi:hover{background:rgba(56,189,248,.2)}
.cp-tool-region{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-family:monospace;
  border-radius:6px;padding:2px 7px;cursor:pointer;transition:background .12s;
  color:#d8b4fe;background:rgba(192,132,252,.12);border:1px solid rgba(192,132,252,.35)}
.cp-tool-region:hover{background:rgba(192,132,252,.24)}
.cp-tool-evi{color:#22d3ee;background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.32)}
.cp-tool-evi:hover{background:rgba(34,211,238,.2)}
.cp-tool-dot{width:6px;height:6px;border-radius:50%;background:#22d3ee;box-shadow:0 0 5px rgba(34,211,238,.8)}
.cp-answer{font-size:12.5px;line-height:1.55;color:var(--fg);padding:2px 1px;word-break:break-word}
/* answer markdown */
.cp-md-p{margin:0 0 6px;white-space:pre-wrap}
.cp-answer>.cp-md-p:last-child{margin-bottom:0}
.cp-md-ul,.cp-md-ol{margin:2px 0 6px;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.cp-md-ul li,.cp-md-ol li{line-height:1.5}
.cp-answer strong{color:#e9e3ff;font-weight:600}
.cp-answer em{color:#e2ddf3}
.cp-md-code{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;
  background:rgba(148,163,184,.14);border:1px solid var(--border);border-radius:4px;padding:1px 4px}
.cp-md-pre{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;line-height:1.5;
  background:var(--bg2,#0d0e14);border:1px solid var(--border);border-radius:8px;padding:8px 10px;
  overflow-x:auto;margin:2px 0 6px;white-space:pre;color:var(--fg)}
/* gate: a quiet inline affordance, not a loud card */
.cp-approve{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:1px}
.cp-approve-note{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)}
.cp-approve-btn{font-size:11.5px;font-weight:500;color:#c4b5fd;background:transparent;
  border:1px solid rgba(139,92,246,.4);border-radius:7px;padding:4px 11px;cursor:pointer;
  transition:background .15s,border-color .15s,color .15s}
.cp-approve-btn:hover:not(:disabled){background:rgba(139,92,246,.14);color:#ddd6fe;border-color:rgba(139,92,246,.6)}
.cp-approve-btn:disabled{opacity:.45;cursor:default}
.cp-turn-err{font-size:11.5px;color:#fca5a5;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:7px 10px}
.cp-turn-stopped{font-size:11.5px;color:var(--muted);font-style:italic;padding:1px 2px}

/* composer */
.cp-composer-shell{border-top:1px solid var(--border);flex-shrink:0}
.cp-roibar{padding:8px 10px 0;display:flex;align-items:center;gap:8px}
.cp-roibtn{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:#c4b5fd;
  background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.3);border-radius:7px;
  padding:4px 9px;cursor:pointer;transition:background .15s}
.cp-roibtn:hover:not(:disabled){background:rgba(139,92,246,.2)}
.cp-roibtn:disabled{opacity:.5;cursor:default}
.cp-roichip{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-family:monospace;
  color:#c4b5fd;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.4);
  border-radius:7px;padding:3px 4px 3px 9px}
.cp-roichip-coords{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-family:monospace;
  color:#c4b5fd;background:transparent;border:none;padding:0;cursor:pointer}
.cp-roichip-coords:hover{color:#ddd6fe}
.cp-roichip-x{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;border:none;
  background:transparent;color:#c4b5fd;cursor:pointer;transition:background .15s}
.cp-roichip-x:hover{background:rgba(139,92,246,.28)}
.cp-roihint{display:inline-flex;align-items:center;gap:7px;font-size:10.5px;color:#f5a623}
.cp-roidot{width:6px;height:6px;border-radius:50%;background:#f5a623;animation:cp-pulse 1s ease-in-out infinite}
.cp-roilink{font-size:10.5px;color:var(--muted);background:none;border:none;cursor:pointer;
  text-decoration:underline;padding:0}
.cp-composer{padding:10px;display:flex;gap:8px;align-items:flex-end}
.cp-composer textarea{flex:1;resize:none;overflow-y:auto;max-height:160px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent;
  background:var(--bg2,#0d0e14);color:var(--fg);
  border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12.5px;
  font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.cp-composer textarea:focus{border-color:rgba(139,92,246,.6);box-shadow:0 0 0 2px rgba(139,92,246,.15)}
.cp-composer textarea:disabled{opacity:.5}
.cp-send{width:38px;height:38px;border-radius:8px;border:none;flex:none;color:#fff;cursor:pointer;
  background:linear-gradient(160deg,#8b5cf6,#7c3aed);transition:transform .12s,box-shadow .15s,opacity .15s}
.cp-send:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.cp-send:disabled{background:rgba(124,58,237,.35);cursor:default}
.cp-stop{background:linear-gradient(160deg,#f87171,#ef4444);display:grid;place-items:center}
.cp-stop:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(239,68,68,.4)}

/* history drawer */
.cp-drawer{position:absolute;inset:0;background:var(--bg2,#0d0e14);display:flex;flex-direction:column;
  min-height:0;animation:cp-slide .2s ease both}
.cp-drawer-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.cp-drawer-title{font-weight:600;font-size:13px}
.cp-list{flex:1;min-height:0;overflow-y:auto;padding:8px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
.cp-conv{position:relative;display:flex;align-items:center;gap:8px;padding:9px 8px 9px 12px;
  border:1px solid transparent;border-radius:9px;cursor:pointer;animation:cp-in .28s ease both;
  transition:background .15s,border-color .15s}
.cp-conv:hover{background:rgba(148,163,184,.06);border-color:var(--border)}
.cp-conv[data-active]{background:rgba(139,92,246,.10);border-color:rgba(139,92,246,.35)}
.cp-conv-accent{position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;background:transparent}
.cp-conv[data-active] .cp-conv-accent{background:linear-gradient(#a78bfa,#7c3aed)}
.cp-conv-main{min-width:0;flex:1}
.cp-conv-title{font-size:12.5px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp-conv-meta{font-size:10.5px;color:var(--muted);margin-top:2px;display:flex;align-items:center;gap:5px}
.cp-conv-live{color:#a78bfa;border:1px solid rgba(167,139,250,.4);border-radius:6px;padding:0 5px;font-size:9px}
.cp-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:7px;flex:none;
  color:var(--muted);background:transparent;border:none;cursor:pointer;transition:background .15s,color .15s}
.cp-icon:hover{background:rgba(148,163,184,.12);color:var(--fg)}
.cp-icon--danger:hover{background:rgba(248,113,113,.15);color:#f87171}
.cp-conv-trash{opacity:0}
.cp-conv:hover .cp-conv-trash,.cp-conv:focus-within .cp-conv-trash{opacity:1}
.cp-confirm{display:flex;align-items:center;gap:4px;font-size:10.5px;color:#f87171}
.cp-list::-webkit-scrollbar,.cp-thread::-webkit-scrollbar,.cp-composer textarea::-webkit-scrollbar{width:10px}
.cp-list::-webkit-scrollbar-track,.cp-thread::-webkit-scrollbar-track,.cp-composer textarea::-webkit-scrollbar-track{
  background:transparent}
.cp-list::-webkit-scrollbar-thumb,.cp-thread::-webkit-scrollbar-thumb,.cp-composer textarea::-webkit-scrollbar-thumb{
  background:rgba(148,163,184,.4);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.cp-list::-webkit-scrollbar-thumb:hover,.cp-thread::-webkit-scrollbar-thumb:hover,
.cp-composer textarea::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.62);background-clip:padding-box}
@keyframes cp-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cp-slide{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
@keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes cp-spin{to{transform:rotate(360deg)}}
@keyframes cp-bounce{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-4px);opacity:1}}
`;
