// src/components/panels/CopilotPanel.jsx
// Copilot — PathAgent v2 conversational panel.
// Increment 1: conversations + turns persist in Postgres, keyed by (Girder user, slide).
// The panel hydrates the newest conversation for the slide, lazily creates one on the
// first message, and exposes a History drawer to browse / switch / delete past threads.
// The plan/run/claim UI lands in later increments; this file grows, the tab stays.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import {
  streamMessage, listConversations, createConversation, getConversation, deleteConversation,
} from '../../api/copilotApi.js';

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
    addCopilotMessage, setCopilotMessages, updateLastCopilotMessage,
    setCopilotConversationId, setCopilotStreaming, setCopilotError, resetCopilot,
  } = useStore();
  const [input, setInput] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null);   // conversation pending delete-confirm
  const threadRef = useRef(null);
  const abortRef = useRef(null);

  const itemId = activeItem?._id || null;

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
          setCopilotMessages((full.turns || []).map((t) => ({ role: t.role, text: t.text })));
        } else {
          setCopilotConversationId(null);
          setCopilotMessages([]);
        }
      } catch (err) {
        if (!cancelled) setCopilotError(err.message || 'Could not load history');
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [itemId, setCopilotError, setCopilotConversationId, setCopilotMessages]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [copilotMessages, copilotStreaming]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || copilotStreaming || !itemId) return;
    setInput('');
    setCopilotError(null);

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

    addCopilotMessage({ role: 'user', text });
    addCopilotMessage({ role: 'assistant', text: '' });
    setCopilotStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamMessage({
        conversationId: convId,
        text,
        signal: ctrl.signal,
        onEvent: (evt) => {
          if (evt.type === 'token' || evt.type === 'done') {
            updateLastCopilotMessage(evt.full ?? evt.text ?? '');
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
  }, [input, copilotStreaming, itemId, copilotConversationId, addCopilotMessage,
      updateLastCopilotMessage, setCopilotConversationId, setCopilotStreaming, setCopilotError,
      refreshList]);

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  };

  // New conversation: clear the thread + drop the id so the next message lazily
  // creates a fresh one. The prior conversation stays saved.
  const handleNew = () => {
    if (abortRef.current) abortRef.current.abort();
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
    setHistoryOpen(false);
    setCopilotError(null);
    try {
      const full = await getConversation(id);
      setCopilotConversationId(full.id);
      setCopilotMessages((full.turns || []).map((t) => ({ role: t.role, text: t.text })));
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
      height: '100%', color: 'var(--fg)' }}>
      <style>{CP_CSS}</style>

      {/* header */}
      <div className="cp-header">
        <span className="cp-mark">◆</span>
        <span className="cp-title">Copilot</span>
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
                <p>Start a conversation. For now I echo your message back while the framework
                  comes online — but your thread <b>persists</b>: reload and it's still here.</p>
                <p className="cp-empty-slide">Slide in context · <span>{activeItem.name}</span></p>
              </>
            ) : (
              <p>Open a slide, then start a conversation here.</p>
            )}
          </div>
        )}
        {copilotMessages.map((m, i) => (
          <Bubble
            key={i}
            role={m.role}
            text={m.text}
            streaming={copilotStreaming && i === copilotMessages.length - 1 && m.role === 'assistant'}
          />
        ))}
        {copilotError && <div className="cp-error">{copilotError}</div>}
      </div>

      {/* composer */}
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

function Bubble({ role, text, streaming }) {
  const isUser = role === 'user';
  return (
    <div className={`cp-bubble ${isUser ? 'cp-bubble--user' : 'cp-bubble--bot'}`}>
      {text}{streaming && <span className="cp-caret">▍</span>}
    </div>
  );
}

// Scoped styles — kept in-file so the panel is self-contained. Prefix `cp-` avoids
// collisions with the app's Tailwind/theme layers; colors come from the theme vars.
const CP_CSS = `
.cp-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border)}
.cp-mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;
  background:linear-gradient(160deg,#a78bfa,#7c3aed);color:#fff;font-size:11px;font-weight:700;
  box-shadow:0 0 0 1px rgba(167,139,250,.25),0 2px 8px rgba(124,58,237,.35)}
.cp-title{font-weight:600;font-size:13px;letter-spacing:.2px}
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
  border-bottom:1px solid var(--border);padding:4px 12px;font-family:monospace}
.cp-thread{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.cp-hint{color:var(--muted);font-size:12px}
.cp-empty{color:var(--muted);font-size:12.5px;line-height:1.55;margin-top:6px;
  display:flex;flex-direction:column;gap:8px}
.cp-empty p{margin:0}
.cp-empty b{color:#c4b5fd;font-weight:600}
.cp-empty-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:15px;
  color:#a78bfa;background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.25)}
.cp-empty-slide{font-size:11px;color:var(--muted)}
.cp-empty-slide span{color:#a78bfa}
.cp-bubble{align-self:flex-start;max-width:88%;font-size:12.5px;line-height:1.5;padding:8px 11px;
  border-radius:12px 12px 12px 3px;background:var(--surface,#171a26);border:1px solid var(--border);
  white-space:pre-wrap;word-break:break-word;animation:cp-in .22s ease both}
.cp-bubble--user{align-self:flex-end;color:#e9e3ff;border-radius:12px 12px 3px 12px;
  background:linear-gradient(160deg,#3b2a6b,#2a2050);border:1px solid rgba(167,139,250,.3)}
.cp-caret{opacity:.6}
.cp-error{font-size:11.5px;color:#f87171;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:7px 10px}
.cp-composer{border-top:1px solid var(--border);padding:10px;display:flex;gap:8px;align-items:flex-end}
.cp-composer textarea{flex:1;resize:none;background:var(--bg2,#0d0e14);color:var(--fg);
  border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12.5px;
  font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.cp-composer textarea:focus{border-color:rgba(139,92,246,.6);box-shadow:0 0 0 2px rgba(139,92,246,.15)}
.cp-composer textarea:disabled{opacity:.5}
.cp-send{width:38px;height:38px;border-radius:8px;border:none;flex:none;color:#fff;cursor:pointer;
  background:linear-gradient(160deg,#8b5cf6,#7c3aed);transition:transform .12s,box-shadow .15s,opacity .15s}
.cp-send:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.cp-send:disabled{background:rgba(124,58,237,.35);cursor:default}
.cp-drawer{position:absolute;inset:0;background:var(--bg2,#0d0e14);display:flex;flex-direction:column;
  animation:cp-slide .2s ease both}
.cp-drawer-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border)}
.cp-drawer-title{font-weight:600;font-size:13px}
.cp-list{flex:1;overflow-y:auto;padding:8px}
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
.cp-list::-webkit-scrollbar,.cp-thread::-webkit-scrollbar{width:8px}
.cp-list::-webkit-scrollbar-thumb,.cp-thread::-webkit-scrollbar-thumb{
  background:rgba(148,163,184,.25);border-radius:8px}
@keyframes cp-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cp-slide{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
`;
