// src/components/panels/CopilotPanel.jsx
// Copilot — PathAgent v2 conversational panel.
// - inc 1: conversations + turns persist in Postgres, keyed by (Girder user, slide);
//   History drawer to browse / switch / delete threads.
// - inc 2: replies stream from Claude (or echo when unkeyed); mode pill + error frame.
// - inc 3: "Region" grounds the next message to an ROI drawn on the slide (reuses the
//   viewer's roi-select handshake); the ROI rides along and renders on the message.
// - inc 4: a quantitative ask returns a Plan card (proposed steps + cost/time envelope)
//   that the user must Approve before anything runs; older plans expire. Nothing executes
//   yet — that's inc 5.
// The run/claim UI lands in later increments; this file grows, the tab stays.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import {
  streamMessage, listConversations, createConversation, getConversation, deleteConversation,
  approvePlan, rejectPlan, streamRun, fetchArtifact, checkHealth,
} from '../../api/copilotApi.js';
import { focusRegion } from './agentViewerSync.js';

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
const MemoryIcon = ({ size = 12 }) => (
  <Icon d={['M12 2 2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5']} size={size} />
);
const RectIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinejoin="round" strokeDasharray="4 3">
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
  </svg>
);

const r0 = (n) => Math.round(n);
const fmtRoi = (r) => `${r0(r.width)}×${r0(r.height)} @ (${r0(r.x)}, ${r0(r.y)})`;

// Rebuild the thread from a hydrated conversation: turns as bubbles, with each plan card
// slotted in right after the turn that triggered it (plan.turn_id).
function buildMessages(full) {
  const turns = full.turns || [];
  const plans = full.plans || [];
  const byTurn = new Map();
  const tail = [];
  plans.forEach((p) => {
    if (p.turn_id == null) { tail.push(p); return; }
    const arr = byTurn.get(p.turn_id) || [];
    arr.push(p);
    byTurn.set(p.turn_id, arr);
  });
  const msgs = [];
  turns.forEach((t) => {
    msgs.push({ role: t.role, text: t.text, roi: t.roi });
    (byTurn.get(t.id) || []).forEach((p) => msgs.push({ role: 'plan', plan: p }));
  });
  tail.forEach((p) => msgs.push({ role: 'plan', plan: p }));
  return msgs;
}

// The region a conversation is currently focused on: the most recent user turn's ROI,
// stripped to the composer's { x, y, width, height } shape (turns store it as { kind, ... }).
// Used to re-attach the sticky region when a slide/conversation is (re)opened.
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

const PLAN_STATE = {
  AWAITING_APPROVAL: { s: 'await', label: 'Awaiting' },
  APPROVED: { s: 'approved', label: 'Approved' },
  REJECTED: { s: 'rejected', label: 'Rejected' },
  EXPIRED: { s: 'expired', label: 'Expired' },
};

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
    addCopilotMessage, setCopilotMessages, updateLastCopilotMessage, setLastCopilotMessage,
    expireCopilotPlans, updateCopilotPlanState,
    setCopilotConversationId, setCopilotStreaming, setCopilotError, resetCopilot,
    setDrawingMode, roiSelectResult, clearRoiSelectResult,
    copilotRoi, setCopilotRoi, restoreCopilotRoi, shownRoi, setShownRoi, viewer,
    setCopilotNuclei, clearCopilotNuclei, showNucleiOverlay, toggleNucleiOverlay,
  } = useStore();
  const [input, setInput] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null);   // conversation pending delete-confirm
  const [mode, setMode] = useState(null);             // 'claude' | 'echo' — which backend is live
  const [awaitingRoi, setAwaitingRoi] = useState(false);  // waiting for the user to draw a box
  const [planBusy, setPlanBusy] = useState(false);        // approve/reject request in flight
  const [runByDigest, setRunByDigest] = useState({});     // digest → { status, steps, result, error, runId }
  const [blackboard, setBlackboard] = useState([]);       // per-slide case memory (deduped facts)
  // The grounded region (copilotRoi) lives in the store so the viewer can paint it too.
  const threadRef = useRef(null);
  const abortRef = useRef(null);

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

  // Reveal a region on the viewer: pan/zoom to it and paint the box. Clicking the same
  // region again hides it (toggle). Display only — never changes the pending attachment.
  const showRoi = useCallback((roi) => {
    if (!roi) return;
    const same = shownRoi && shownRoi.x === roi.x && shownRoi.y === roi.y
      && shownRoi.width === roi.width && shownRoi.height === roi.height;
    if (same) { setShownRoi(null); return; }
    setShownRoi({ x: roi.x, y: roi.y, width: roi.width, height: roi.height });
    if (viewer) focusRegion(viewer, roi);
  }, [shownRoi, setShownRoi, viewer]);

  // Reveal a blackboard fact's evidence on the slide: focus + paint its region, and pull its
  // nuclei overlay. The fact carries its OWN conversation_id, so the artifact fetch stays
  // owner-scoped even when the fact was asserted in a different thread on this slide.
  const revealFact = useCallback((f) => {
    if (f.scope?.roi) showRoi(f.scope.roi);
    const ref = (f.evidence || []).find((e) => e.key === 'nuclei');
    if (ref) {
      fetchArtifact(f.conversation_id, ref.run_id, 'nuclei')
        .then((n) => setCopilotNuclei(n))
        .catch(() => {});
    }
  }, [showRoi, setCopilotNuclei]);

  // Rehydrate persisted Claims (increment 6a): re-seed each approved plan's run trace to
  // "done" (so its card shows the Claim, not a Run button) and restore the nuclei overlay
  // from the latest claim's evidence — so a reload brings back the result + overlay.
  const rehydrateClaims = useCallback((full) => {
    const claims = full.claims || [];
    const plansByDigest = {};
    (full.plans || []).forEach((p) => { plansByDigest[p.digest] = p; });
    const runs = {};
    claims.forEach((c) => {
      const steps = {};
      (plansByDigest[c.plan_digest]?.steps || []).forEach((s) => { steps[s.n] = 'done'; });
      runs[c.plan_digest] = {
        status: 'done', runId: c.run_id, result: c.metrics || {}, steps, claim: c,
      };
    });
    setRunByDigest(runs);
    const withNuclei = claims.filter((c) => (c.evidence || []).some((e) => e.key === 'nuclei'));
    const last = withNuclei[withNuclei.length - 1];
    if (last) {
      const ref = last.evidence.find((e) => e.key === 'nuclei');
      fetchArtifact(full.id, ref.run_id, 'nuclei').then((n) => setCopilotNuclei(n)).catch(() => {});
    } else {
      clearCopilotNuclei();
    }
  }, [setCopilotNuclei, clearCopilotNuclei]);

  // Reset the local "awaiting a box" flag + run traces when the slide changes; the grounded
  // copilotRoi and nuclei overlay are cleared at the store level (setActiveItem / openCaseItem).
  useEffect(() => { setAwaitingRoi(false); setRunByDigest({}); setBlackboard([]); }, [itemId]);

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
  // A `cancelled` guard drops stale responses if the slide changes mid-fetch.
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
          rehydrateClaims(full);
          setBlackboard(full.blackboard || []);   // per-slide case memory
          // Re-attach the sticky region: localStorage (staged box / explicit clear on this
          // slide) wins; otherwise adopt the conversation's last-used region.
          restoreCopilotRoi(itemId, lastUserTurnRoi(full));
        } else {
          setCopilotConversationId(null);
          setCopilotMessages([]);
          setBlackboard([]);
          restoreCopilotRoi(itemId, null);   // no conversation yet, but a staged box may persist
        }
      } catch (err) {
        if (!cancelled) setCopilotError(err.message || 'Could not load history');
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [itemId, setCopilotError, setCopilotConversationId, setCopilotMessages, rehydrateClaims,
      restoreCopilotRoi]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [copilotMessages, copilotStreaming]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || copilotStreaming || !itemId) return;
    setInput('');
    setCopilotError(null);
    const roi = copilotRoi ? { kind: 'rect', ...copilotRoi } : null;

    // Ensure a server conversation exists (lazy-create on first message).
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
    addCopilotMessage({ role: 'assistant', text: '' });
    // The region is STICKY: it rides on this message AND stays attached for follow-ups
    // (and across refresh) until the user clears it. Only unpaint the viewer box; the
    // composer chip remains as the "still grounded here" indicator.
    setShownRoi(null);
    setCopilotStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamMessage({
        conversationId: convId,
        text,
        roi,
        signal: ctrl.signal,
        onEvent: (evt) => {
          if (evt.type === 'plan') {
            expireCopilotPlans();   // a new proposal supersedes any prior live plan
            setLastCopilotMessage({ role: 'plan', plan: {
              digest: evt.digest, state: evt.state, steps: evt.steps, scope: evt.scope,
              envelope: evt.envelope, reason: evt.reason, turn_id: evt.turn_id,
            } });
          } else if (evt.type === 'token' || evt.type === 'done') {
            // A plan frame may have replaced the placeholder; only chat/guidance carry text.
            if (evt.full != null || evt.text != null) {
              updateLastCopilotMessage(evt.full ?? evt.text ?? '');
            }
          } else if (evt.type === 'error') {
            setCopilotError(evt.message || 'The copilot backend failed mid-reply.');
            updateLastCopilotMessage(evt.full || '(interrupted)');
          }
        },
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        setCopilotError(err.message || 'Copilot request failed');
        updateLastCopilotMessage('(no response)');
      }
    } finally {
      setCopilotStreaming(false);
      abortRef.current = null;
      refreshList().catch(() => {});   // pick up the auto-title + turn count + new ordering
    }
  }, [input, copilotStreaming, itemId, copilotConversationId, copilotRoi, setShownRoi,
      addCopilotMessage, updateLastCopilotMessage, setLastCopilotMessage, expireCopilotPlans,
      setCopilotConversationId, setCopilotStreaming, setCopilotError, refreshList]);

  // Run an approved plan (increment 5): stream per-step progress into runByDigest, and on
  // completion fetch the nuclei artifact and hand it to the viewer overlay.
  const runPlan = useCallback((digest) => {
    const convId = copilotConversationId;
    if (!convId) return;
    setRunByDigest((m) => ({ ...m, [digest]: { status: 'running', steps: {}, result: null } }));
    const patch = (fn) => setRunByDigest((m) => ({ ...m, [digest]: fn(m[digest] || {}) }));
    streamRun({
      conversationId: convId,
      digest,
      onEvent: (evt) => {
        if (evt.type === 'run_step') {
          patch((r) => ({ ...r, status: 'running', runId: evt.run_id,
            steps: { ...(r.steps || {}), [evt.n]: evt.status } }));
        } else if (evt.type === 'run_done') {
          patch((r) => ({ ...r, status: 'done', runId: evt.run_id,
            result: evt.result, claim: evt.claim, cached: evt.cached }));
          if (evt.blackboard) setBlackboard(evt.blackboard);   // live-refresh the case memory
          const ref = (evt.artifacts || []).find((a) => a.key === 'nuclei');
          if (ref) {
            fetchArtifact(convId, evt.run_id, 'nuclei')
              .then((n) => setCopilotNuclei(n))
              .catch((err) => setCopilotError(err.message));
          }
        } else if (evt.type === 'run_error') {
          patch((r) => ({ ...r, status: 'error', error: evt.message }));
        }
      },
    }).catch((err) => patch((r) => ({ ...r, status: 'error', error: err.message })));
  }, [copilotConversationId, setCopilotNuclei, setCopilotError]);

  // Approve / reject the live plan. The gate is server-authoritative; we reflect the
  // returned state into the card. On approve, execution auto-starts (increment 5).
  const resolvePlan = useCallback(async (digest, action) => {
    if (!copilotConversationId || planBusy) return;
    setPlanBusy(true);
    setCopilotError(null);
    try {
      const fn = action === 'approve' ? approvePlan : rejectPlan;
      const updated = await fn(copilotConversationId, digest);
      updateCopilotPlanState(digest, updated.state);
      if (action === 'approve' && updated.state === 'APPROVED') runPlan(digest);
    } catch (err) {
      setCopilotError(err.message || `Could not ${action} the plan`);
    } finally {
      setPlanBusy(false);
    }
  }, [copilotConversationId, planBusy, updateCopilotPlanState, setCopilotError, runPlan]);

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  };

  // New conversation: clear the thread + drop the id so the next message lazily
  // creates a fresh one. The prior conversation stays saved.
  const handleNew = () => {
    if (abortRef.current) abortRef.current.abort();
    if (awaitingRoi) cancelRoi();
    setCopilotRoi(null);
    setShownRoi(null);
    clearCopilotNuclei();
    setRunByDigest({});
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
    setRunByDigest({});
    setHistoryOpen(false);
    setCopilotError(null);
    try {
      const full = await getConversation(id);
      setCopilotConversationId(full.id);
      setCopilotMessages(buildMessages(full));   // same builder as reload → interleaves plan cards by turn_id
      rehydrateClaims(full);
      setBlackboard(full.blackboard || []);      // per-slide case memory (same across threads)
      setCopilotRoi(lastUserTurnRoi(full));      // adopt this thread's region (persists it for the slide)
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
            ? 'Replies from Claude' : 'Echo fallback — set AGENT_ANTHROPIC_API_KEY for Claude'}>
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

      {/* research-use ribbon */}
      <div className="cp-ribbon">RESEARCH USE ONLY · NOT A DIAGNOSTIC DEVICE</div>

      {/* case memory (increment 6c): per-slide deduped facts, spans threads */}
      <MemoryStrip facts={blackboard} onReveal={revealFact} />

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
                {mode === 'echo' ? (
                  <p>Start a conversation. I echo your message back for now — set
                    <b> AGENT_ANTHROPIC_API_KEY</b> to switch replies to Claude. Either way your
                    thread <b>persists</b>: reload and it's still here.</p>
                ) : (
                  <p>Ask about the tissue, staining, or analysis workflow for this slide. I reason
                    with <b>Claude</b> — research use only, and I can't run image analysis on the
                    pixels <i>yet</i> (that lands in a later release).</p>
                )}
                <p className="cp-empty-slide">Slide in context · <span>{activeItem.name}</span></p>
              </>
            ) : (
              <p>Open a slide, then start a conversation here.</p>
            )}
          </div>
        )}
        {copilotMessages.map((m, i) => (
          m.role === 'plan' ? (
            <PlanCard
              key={i}
              plan={m.plan}
              busy={planBusy}
              run={runByDigest[m.plan.digest]}
              showOverlay={showNucleiOverlay}
              onApprove={(d) => resolvePlan(d, 'approve')}
              onReject={(d) => resolvePlan(d, 'reject')}
              onRun={runPlan}
              onShowRoi={showRoi}
              onToggleOverlay={toggleNucleiOverlay}
            />
          ) : (
            <Bubble
              key={i}
              role={m.role}
              text={m.text}
              roi={m.roi}
              onShowRoi={showRoi}
              streaming={copilotStreaming && i === copilotMessages.length - 1 && m.role === 'assistant'}
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
          <button className="cp-send" onClick={send} disabled={!canSend} title="Send (⌘/Ctrl + ⏎)">
            {copilotStreaming ? '…' : '➤'}
          </button>
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

function Bubble({ role, text, roi, streaming, onShowRoi }) {
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
        {text}{streaming && <span className="cp-caret">▍</span>}
      </div>
    </div>
  );
}

// Plan card (inc 4) — the human gate. Numbered steps, tool/param chips, cost envelope,
// Approve/Reject. Nothing runs on approve yet; only one plan is ever live (older → Expired).
function PlanCard({ plan, busy, run, showOverlay, onApprove, onReject, onRun, onShowRoi,
  onToggleOverlay }) {
  const meta = PLAN_STATE[plan.state] || { s: 'await', label: plan.state };
  const roi = plan.scope && plan.scope.roi;
  const env = plan.envelope || {};
  const awaiting = plan.state === 'AWAITING_APPROVAL';
  return (
    <div className="cp-plan" data-state={meta.s}>
      <div className="cp-plan-top">
        <span className="cp-plan-ic">◆</span>
        <div className="cp-plan-h">Plan<small>digest {plan.digest}</small></div>
        <span className="cp-plan-pill" data-s={meta.s}>{meta.label}</span>
      </div>

      <div className="cp-plan-steps">
        {(plan.steps || []).map((s) => (
          <div className="cp-step" key={s.n}>
            <div className="cp-step-rail">
              <span className="cp-step-dot" data-run={run?.steps?.[s.n] || ''}>
                {run?.steps?.[s.n] === 'done' ? '✓' : s.n}
              </span>
              <span className="cp-step-line" />
            </div>
            <div className="cp-step-body">
              <div>
                <span className="cp-step-tool">{s.tool}</span>
                {s.category && <span className="cp-step-cat">{s.category}</span>}
              </div>
              {s.args && Object.keys(s.args).length > 0 && (
                <div className="cp-params">
                  {Object.entries(s.args).map(([k, v]) => (
                    <span className="cp-param" key={k}><b>{k}</b>={String(v)}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="cp-plan-env">
        {roi && (
          <button type="button" className="cp-env-roi" onClick={() => onShowRoi?.(roi)}
            title="Show this region on the slide"><RectIcon size={10} />{fmtRoi(roi)}</button>
        )}
        {env.tools != null && <span>{env.tools} tool{env.tools === 1 ? '' : 's'}</span>}
        {env.est_seconds != null && <span>~{env.est_seconds}s</span>}
        {env.device && <span>{env.device}</span>}
        {env.mode && <span>{env.mode}</span>}
      </div>

      {plan.reason && <div className="cp-plan-reason">{plan.reason}</div>}

      {awaiting ? (
        <div className="cp-plan-actions">
          <button className="cp-plan-approve" onClick={() => onApprove(plan.digest)} disabled={busy}>
            Approve &amp; freeze
          </button>
          <button className="cp-plan-reject" onClick={() => onReject(plan.digest)} disabled={busy}>
            Reject
          </button>
        </div>
      ) : (
        <div className="cp-plan-resolved" data-s={meta.s}>
          {plan.state === 'APPROVED' && (
            run ? (
              <div className="cp-run" data-s={run.status}>
                {run.status === 'running' && (
                  <span className="cp-run-line"><span className="cp-run-spin" />Running the plan…</span>
                )}
                {run.status === 'done' && run.result && (
                  <ClaimCard result={run.result} claim={run.claim} cached={run.cached}
                    showOverlay={showOverlay} onToggleOverlay={onToggleOverlay} />
                )}
                {run.status === 'error' && (
                  <span className="cp-run-line cp-run-err">Run failed: {run.error}</span>
                )}
              </div>
            ) : (
              <div className="cp-plan-actions">
                <span className="cp-plan-frozen">Approved — frozen as <code>{plan.digest}</code>.</span>
                <button className="cp-plan-approve" onClick={() => onRun(plan.digest)} disabled={busy}>
                  Run
                </button>
              </div>
            )
          )}
          {plan.state === 'REJECTED' && <>Rejected. Ask again to propose a new plan.</>}
          {plan.state === 'EXPIRED' && <>Superseded by a newer plan — only the latest is runnable.</>}
        </div>
      )}
    </div>
  );
}

// Claim card (inc 6a) — the durable, evidence-bound result of a run. The number is the
// authoritative tool output (the LLM never emits it); the evidence chip toggles the nuclei
// overlay that grounds it. Rendered identically live (run_done frame) and after a reload
// (rehydrated from the persisted claim), so the result survives a refresh.
// Case memory (increment 6c): a compact strip of the slide's deduped current facts, above
// the thread. Each fact is the latest Claim for a (subject, predicate); clicking it reveals
// that fact's evidence (region + nuclei overlay) on the slide. Hidden when empty.
function MemoryStrip({ facts, onReveal }) {
  if (!facts || facts.length === 0) return null;
  return (
    <div className="cp-bb">
      <span className="cp-bb-label" title="What this slide's analyses have established so far">
        <MemoryIcon /> Case memory
      </span>
      <div className="cp-bb-facts">
        {facts.map((f, i) => {
          const canReveal = !!f.scope?.roi || (f.evidence || []).some((e) => e.key === 'nuclei');
          return (
            <button key={`${f.subject}:${f.predicate}:${i}`} type="button" className="cp-bb-fact"
              disabled={!canReveal} onClick={() => onReveal(f)}
              title={canReveal ? 'Show this evidence on the slide' : undefined}>
              <span className="cp-bb-subj">{f.subject}</span>
              <span className="cp-bb-val">{f.value}<em>{f.unit}</em></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ClaimCard({ result, claim, showOverlay, cached, onToggleOverlay }) {
  const count = result?.count;
  const subject = result?.cell_class || claim?.subject || 'cells';
  const density = result?.density;
  const nNuclei = claim?.metrics?.count ?? count;
  const hasOverlay = (claim?.evidence || []).some((e) => e.key === 'nuclei');
  return (
    <div className="cp-claim">
      <div className="cp-claim-head">
        <div className="cp-claim-value">{count}<span className="cp-claim-subject">{subject}</span></div>
        {density != null && (
          <div className="cp-claim-density">{density} <small>{result.density_unit}</small></div>
        )}
      </div>
      <div className="cp-claim-foot">
        {hasOverlay && (
          <button type="button" className="cp-claim-evi" onClick={onToggleOverlay}
            title="Toggle the nuclei overlay on the slide">
            <span className="cp-claim-dot" />{nNuclei} nuclei · {showOverlay ? 'hide' : 'show'}
          </button>
        )}
        {cached && (
          <span className="cp-claim-cached" title="Reused a prior identical run — no recomputation">
            ⚡ reused
          </span>
        )}
        <span className="cp-claim-ruo">research use only</span>
      </div>
    </div>
  );
}

// Scoped styles — kept in-file so the panel is self-contained. Prefix `cp-` avoids
// collisions with the app's Tailwind/theme layers; colors come from the theme vars.
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
.cp-ribbon{font-size:9px;letter-spacing:.4px;color:#f5a623;background:rgba(245,166,35,.07);
  border-bottom:1px solid var(--border);padding:4px 12px;font-family:monospace;flex-shrink:0}
.cp-bb{display:flex;align-items:center;gap:8px;padding:6px 10px;flex-shrink:0;
  border-bottom:1px solid var(--border);background:rgba(56,189,248,.05)}
.cp-bb-label{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;letter-spacing:.3px;
  text-transform:uppercase;color:#7dd3fc;white-space:nowrap;flex-shrink:0}
.cp-bb-facts{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
.cp-bb-facts::-webkit-scrollbar{display:none}
.cp-bb-fact{display:inline-flex;align-items:baseline;gap:5px;white-space:nowrap;font-size:11px;
  padding:2px 8px;border-radius:999px;border:1px solid rgba(56,189,248,.3);
  background:rgba(56,189,248,.1);color:var(--fg);cursor:pointer}
.cp-bb-fact:hover:not(:disabled){background:rgba(56,189,248,.2);border-color:rgba(56,189,248,.5)}
.cp-bb-fact:disabled{cursor:default;opacity:.75}
.cp-bb-subj{color:var(--muted)}
.cp-bb-val{font-weight:700;color:#7dd3fc}
.cp-bb-val em{font-style:normal;font-weight:400;color:var(--muted);font-size:9.5px;margin-left:2px}
.cp-thread{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;display:flex;flex-direction:column;gap:10px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}
.cp-hint{color:var(--muted);font-size:12px}
.cp-empty{color:var(--muted);font-size:12.5px;line-height:1.55;margin-top:6px;
  display:flex;flex-direction:column;gap:8px}
.cp-empty p{margin:0}
.cp-empty b{color:#c4b5fd;font-weight:600}
.cp-empty-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:15px;
  color:#a78bfa;background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.25)}
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
.cp-plan{align-self:stretch;border:1px solid var(--border);border-radius:12px;
  background:var(--surface,#171a26);overflow:hidden;animation:cp-in .22s ease both;
  transition:opacity .25s,filter .25s}
.cp-plan[data-state="expired"]{opacity:.55;filter:grayscale(.4)}
.cp-plan-top{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--border)}
.cp-plan-ic{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:10px;
  color:#c4b5fd;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.3)}
.cp-plan-h{font-size:12.5px;font-weight:600;line-height:1.2}
.cp-plan-h small{display:block;font-family:monospace;font-size:9.5px;color:var(--muted);
  font-weight:400;margin-top:1px}
.cp-plan-pill{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-family:monospace;
  font-size:9px;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:999px}
.cp-plan-pill::before{content:"";width:5px;height:5px;border-radius:50%}
.cp-plan-pill[data-s="await"]{color:#f5a623;background:rgba(245,166,35,.12)}
.cp-plan-pill[data-s="await"]::before{background:#f5a623;animation:cp-pulse 1.5s infinite}
.cp-plan-pill[data-s="approved"]{color:#34d399;background:rgba(52,211,153,.12)}
.cp-plan-pill[data-s="approved"]::before{background:#34d399}
.cp-plan-pill[data-s="rejected"]{color:#f87171;background:rgba(248,113,113,.12)}
.cp-plan-pill[data-s="rejected"]::before{background:#f87171}
.cp-plan-pill[data-s="expired"]{color:#94a3b8;background:rgba(148,163,184,.12)}
.cp-plan-pill[data-s="expired"]::before{background:#94a3b8}
.cp-plan-steps{padding:4px 11px 6px}
.cp-step{display:flex;gap:9px;padding:7px 0}
.cp-step-rail{display:flex;flex-direction:column;align-items:center;flex:none}
.cp-step-dot{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-family:monospace;
  font-size:9px;font-weight:700;color:#c4b5fd;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.3);
  transition:background .15s,color .15s,border-color .15s}
.cp-step-dot[data-run="running"]{color:#fbbf24;background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.5);
  animation:cp-pulse 1s ease-in-out infinite}
.cp-step-dot[data-run="done"]{color:#86efac;background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.5)}
@keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.cp-step-line{width:1.5px;flex:1;background:var(--border);margin:2px 0 -7px}
.cp-step:last-child .cp-step-line{display:none}
.cp-step-body{flex:1;min-width:0}
.cp-step-tool{font-size:12px;font-weight:600}
.cp-step-cat{font-family:monospace;font-size:9px;color:#7dd3fc;background:rgba(77,166,255,.12);
  border-radius:5px;padding:2px 5px;margin-left:6px}
.cp-params{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.cp-param{font-family:monospace;font-size:10px;color:var(--fg);background:rgba(148,163,184,.1);
  border:1px solid var(--border);border-radius:5px;padding:2px 6px}
.cp-param b{color:#c4b5fd;font-weight:600}
.cp-plan-env{display:flex;flex-wrap:wrap;gap:5px 12px;padding:8px 11px;border-top:1px dashed var(--border);
  font-family:monospace;font-size:10px;color:var(--muted)}
.cp-plan-env span{display:inline-flex;align-items:center;gap:4px}
.cp-env-roi{display:inline-flex;align-items:center;gap:4px;font-family:monospace;font-size:10px;
  color:#c4b5fd;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.3);border-radius:6px;
  padding:1px 6px;cursor:pointer;transition:background .12s}
.cp-env-roi:hover{background:rgba(139,92,246,.24)}
.cp-plan-reason{padding:9px 11px;font-size:11.5px;line-height:1.5;color:var(--muted);
  border-top:1px solid var(--border)}
.cp-plan-actions{display:flex;gap:8px;padding:10px 11px;border-top:1px solid var(--border)}
.cp-plan-approve{flex:1;font-size:12px;font-weight:600;color:#fff;border:none;border-radius:8px;
  padding:9px 12px;cursor:pointer;background:linear-gradient(160deg,#8b5cf6,#7c3aed);
  transition:transform .12s,box-shadow .15s,opacity .15s}
.cp-plan-approve:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.cp-plan-approve:disabled{opacity:.5;cursor:default}
.cp-plan-reject{font-size:12px;font-weight:600;color:var(--muted);background:transparent;
  border:1px solid var(--border);border-radius:8px;padding:9px 14px;cursor:pointer;
  transition:color .15s,border-color .15s}
.cp-plan-reject:hover:not(:disabled){color:#f87171;border-color:rgba(248,113,113,.5)}
.cp-plan-reject:disabled{opacity:.5;cursor:default}
.cp-plan-resolved{padding:9px 11px;font-size:11px;line-height:1.5;color:var(--muted);
  border-top:1px solid var(--border)}
.cp-plan-resolved code{font-family:monospace;font-size:10px;color:#c4b5fd}
.cp-plan-resolved[data-s="approved"]{color:#86efac}
.cp-plan-resolved[data-s="rejected"]{color:#fca5a5}
.cp-run-line{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.5}
.cp-run-ok{color:#86efac}
.cp-run-err{color:#fca5a5}
.cp-run-spin{width:11px;height:11px;border-radius:50%;border:2px solid rgba(251,191,36,.3);
  border-top-color:#fbbf24;animation:cp-spin .7s linear infinite}
@keyframes cp-spin{to{transform:rotate(360deg)}}
.cp-claim{display:flex;flex-direction:column;gap:7px;padding:1px 0}
.cp-claim-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.cp-claim-value{font-size:20px;font-weight:700;color:#86efac;line-height:1;
  display:flex;align-items:baseline;gap:6px}
.cp-claim-subject{font-size:11px;font-weight:500;color:var(--muted)}
.cp-claim-density{font-size:12px;color:var(--fg)}
.cp-claim-density small{color:var(--muted)}
.cp-claim-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cp-claim-evi{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-family:monospace;
  color:#22d3ee;background:rgba(34,211,238,.10);border:1px solid rgba(34,211,238,.32);
  border-radius:6px;padding:2px 7px;cursor:pointer;transition:background .12s}
.cp-claim-evi:hover{background:rgba(34,211,238,.2)}
.cp-claim-dot{width:6px;height:6px;border-radius:50%;background:#22d3ee;
  box-shadow:0 0 5px rgba(34,211,238,.8)}
.cp-claim-cached{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-family:monospace;
  color:#fbbf24;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);
  border-radius:6px;padding:1px 6px}
.cp-claim-ruo{font-size:8.5px;letter-spacing:.4px;text-transform:uppercase;color:#f5a623;
  font-family:monospace;opacity:.8}
.cp-plan-frozen{flex:1;font-size:11px;color:var(--muted);align-self:center}
.cp-plan-frozen code{font-family:monospace;font-size:10px;color:#c4b5fd}
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
`;
