// src/components/panels/PathChatPanel.jsx
// AskPA — AI copilot chat panel for pathology case consultation.
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import {
  sendPathChat, generateReport, buildSystemPrompt, buildContextSuffix,
  captureViewport, computeZoomString, serializeMessages, CHAT_MODELS, calcChatCost,
  predictBRCA,
} from '../../api/pathChatApi.js';

// ── Model selector ────────────────────────────────────────────────────────────
function ModelSelector() {
  const { chatModel, setChatModel } = useStore();
  const models = Object.entries(CHAT_MODELS).map(([id, cfg]) => ({ id, label: cfg.label, provider: cfg.provider }));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {models.map((m) => {
        const isLocal   = m.provider === 'dcpenn';
        const isActive  = chatModel === m.id;
        return (
          <button
            key={m.id}
            onClick={() => setChatModel(m.id)}
            title={isLocal ? 'Runs locally on DCPenn — free, private, no data leaves the server' : ''}
            style={{
              fontSize: 9, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
              background: isActive
                ? (isLocal ? 'rgba(16,185,129,0.18)' : 'rgba(124,58,237,0.22)')
                : 'transparent',
              color: isActive
                ? (isLocal ? '#34d399' : '#a78bfa')
                : 'var(--muted)',
              border: isActive
                ? (isLocal ? '1px solid rgba(16,185,129,0.45)' : '1px solid rgba(124,58,237,0.45)')
                : '1px solid var(--border)',
              transition: 'all 0.15s',
            }}
          >
            {isLocal && '⚡ '}{m.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Usage footer ──────────────────────────────────────────────────────────────
function UsageFooter({ usage, modelId }) {
  if (!usage) return null;
  const modelLabel = CHAT_MODELS[modelId]?.label || modelId;
  const cost = usage.cost_usd ?? calcChatCost(modelId, usage.input_tokens, usage.output_tokens);
  return (
    <div style={{
      fontSize: 8.5, color: 'var(--muted)', opacity: 0.65, marginTop: 4,
      display: 'flex', gap: 6, flexWrap: 'wrap',
    }}>
      <span style={{ color: '#a78bfa', opacity: 1 }}>[{modelLabel}]</span>
      <span>{(usage.input_tokens || 0).toLocaleString()} in</span>
      <span>· {(usage.output_tokens || 0).toLocaleString()} out</span>
      <span>· ${cost.toFixed(4)}</span>
    </div>
  );
}

// ── Message bubbles ───────────────────────────────────────────────────────────
function UserBubble({ msg }) {
  const imgBlock = msg.content.find((b) => b.type === 'image');
  const textBlock = msg.content.find((b) => b.type === 'text');
  const rawText = textBlock?.text || '';
  const displayText = rawText.replace(/\n\n\[Zoom:.*?\]$/s, '').trim();

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
      <div style={{ maxWidth: '85%' }}>
        {imgBlock && (
          <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'flex-end' }}>
            <img
              src={`data:image/jpeg;base64,${imgBlock.source.data}`}
              alt="Viewport"
              style={{
                width: 80, height: 56, objectFit: 'cover', borderRadius: 4,
                border: '1px solid var(--border)', display: 'block',
              }}
            />
          </div>
        )}
        <div style={{
          background: 'rgba(124,58,237,0.18)',
          border: '1px solid rgba(124,58,237,0.3)',
          borderRadius: '10px 10px 2px 10px',
          padding: '7px 10px',
          fontSize: 12, lineHeight: 1.5, color: 'var(--fg)',
          wordBreak: 'break-word',
        }}>
          {displayText}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ msg, modelId }) {
  const textBlock = msg.content.find((b) => b.type === 'text');
  const text = textBlock?.text || '';
  const isError = msg._error;

  const renderText = (t) => {
    return t.split('\n').map((line, i) => {
      const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
      return (
        <React.Fragment key={i}>
          {parts.map((part, j) => {
            if (part.startsWith('**') && part.endsWith('**')) {
              return <strong key={j}>{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith('`') && part.endsWith('`')) {
              return <code key={j} style={{ background: 'rgba(255,255,255,0.08)', padding: '0 3px', borderRadius: 3, fontSize: 10 }}>{part.slice(1, -1)}</code>;
            }
            return part;
          })}
          {i < t.split('\n').length - 1 && <br />}
        </React.Fragment>
      );
    });
  };

  return (
    <div style={{ display: 'flex', marginBottom: 10 }}>
      <div style={{ maxWidth: '90%' }}>
        <div style={{
          background: isError ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
          borderRadius: '10px 10px 10px 2px',
          padding: '7px 10px',
          fontSize: 12, lineHeight: 1.6, color: isError ? '#f87171' : 'var(--fg)',
          wordBreak: 'break-word',
        }}>
          {renderText(text)}
        </div>
        <UsageFooter usage={msg._usage} modelId={modelId} />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', marginBottom: 10 }}>
      <div style={{
        background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
        borderRadius: '10px 10px 10px 2px', padding: '8px 12px',
        display: 'flex', gap: 4, alignItems: 'center',
      }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{
            width: 5, height: 5, borderRadius: '50%', background: 'var(--muted)',
            animation: 'askpa-bounce 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.2}s`,
          }} />
        ))}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
const SUGGESTIONS = [
  'What stain is this?',
  'Describe the cell morphology',
  'Grade this tumor',
  'Any mitotic figures visible?',
  'Estimate tumor cellularity',
];

function EmptyState({ onSuggestion }) {
  return (
    <div style={{ padding: '24px 14px', textAlign: 'center' }}>
      <div style={{ fontSize: 22, marginBottom: 8 }}>🔬</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>
        AskPA
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
        Your AI copilot for pathology case consultation.<br/>
        Ask about the current slide or attach a viewport snapshot.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, justifyContent: 'center' }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onSuggestion(s)}
            style={{
              fontSize: 10, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
              background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.25)',
              color: '#a78bfa',
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Attachment preview ────────────────────────────────────────────────────────
function AttachmentPreview() {
  const { chatPendingAttachment, clearChatPendingAttachment } = useStore();
  if (!chatPendingAttachment) return null;
  return (
    <div style={{
      padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8,
      borderTop: '1px solid var(--border)', background: 'rgba(77,166,255,0.05)',
    }}>
      <img
        src={`data:image/jpeg;base64,${chatPendingAttachment}`}
        alt="Pending attachment"
        style={{ width: 44, height: 32, objectFit: 'cover', borderRadius: 3, border: '1px solid var(--border)' }}
      />
      <span style={{ fontSize: 10, color: '#4da6ff', flex: 1 }}>Viewport attached</span>
      <button
        onClick={clearChatPendingAttachment}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)',
          fontSize: 14, lineHeight: 1, padding: '0 2px',
        }}
        title="Remove attachment"
      >×</button>
    </div>
  );
}

// ── Report modal ──────────────────────────────────────────────────────────────
function ReportModal({ report, onClose }) {
  const handleCopy = () => navigator.clipboard.writeText(report).catch(() => {});
  const handleDownload = () => {
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pathology_report.txt'; a.click();
    URL.revokeObjectURL(url);
  };

  const toHtml = (md) => md
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 12,
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
        width: '100%', maxHeight: '90%', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 12px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Pathology Report</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleCopy} style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.35)', color: '#a78bfa',
            }}>Copy</button>
            <button onClick={handleDownload} style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)',
            }}>Download</button>
            <button onClick={onClose} style={{
              fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)',
            }}>×</button>
          </div>
        </div>
        <div
          style={{
            padding: '12px', overflowY: 'auto', flex: 1,
            fontSize: 11.5, lineHeight: 1.7, color: 'var(--fg)',
          }}
          dangerouslySetInnerHTML={{ __html: toHtml(report) }}
        />
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function PathChatPanel() {
  const {
    chatMessages, chatLoading, chatError, chatModel,
    chatPendingAttachment,
    addChatMessage, setChatLoading, setChatError,
    setChatPendingAttachment, clearChatPendingAttachment, clearChat,
    activeItem, tilesInfo, viewer, roiSelectResult,
  } = useStore();

  const [input, setInput] = useState('');
  const [reportText, setReportText] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [brcaLoading, setBrcaLoading] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  const systemPrompt = useMemo(
    () => buildSystemPrompt(activeItem, tilesInfo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeItem?._id, tilesInfo?.sizeX],
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatMessages.length, chatLoading]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || chatLoading) return;

    const zoom = computeZoomString(viewer, tilesInfo);
    const suffix = buildContextSuffix(zoom, roiSelectResult);

    const blocks = [];
    if (chatPendingAttachment) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: chatPendingAttachment },
      });
    }
    blocks.push({ type: 'text', text: text + suffix });

    const userMsg = { role: 'user', content: blocks };
    const nextMessages = [...chatMessages, userMsg];

    addChatMessage(userMsg);
    setInput('');
    clearChatPendingAttachment();
    setChatLoading(true);
    setChatError(null);

    try {
      const { text: reply, usage } = await sendPathChat(
        chatModel,
        systemPrompt,
        serializeMessages(nextMessages),
      );
      addChatMessage({
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        _usage: usage,
      });
    } catch (err) {
      const errMsg = err?.message || 'Request failed';
      setChatError(errMsg);
      addChatMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Error: ${errMsg}` }],
        _error: true,
      });
    } finally {
      setChatLoading(false);
    }
  }, [
    input, chatLoading, chatPendingAttachment, chatMessages, chatModel,
    systemPrompt, viewer, tilesInfo, roiSelectResult,
    addChatMessage, setChatLoading, setChatError, clearChatPendingAttachment,
  ]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAttachViewport = () => {
    const b64 = captureViewport(800);
    if (b64) setChatPendingAttachment(b64);
  };

  const handleBrcaPredict = async () => {
    if (brcaLoading) return;
    const slideId = activeItem?.name || activeItem?._id || '';
    setBrcaLoading(true);
    try {
      const r = await predictBRCA(slideId);
      if (r.error) {
        const isWrongTissue = r.error.includes('outside the BRCA cohort') || r.error.includes('not a breast cancer');
        const cleanId = slideId.replace(/\.(svs|ndpi|tiff|tif|scn)$/i, '');
        const text = isWrongTissue
          ? `**Not a breast tissue slide**\n\n` +
            `This slide does not appear to be breast tissue. The BRCA subtype classifier (IDC vs ILC) only works on breast cancer whole-slide images.\n\n` +
            `**What you can do instead:**\n` +
            `- Attach a viewport snapshot (📷 button) and ask: *"What tissue type is this? What is the diagnosis?"*\n` +
            `- Or type: *"What organ/tissue is visible in this slide?"*\n\n` +
            `*Slide: ${cleanId}*`
          : `**Slide not indexed**\n\n` +
            `Slide \`${cleanId}\` was not found in the 942-slide TCGA BRCA index.\n\n` +
            `Only TCGA breast cancer slides with pre-extracted UNI features are currently supported.`;
        addChatMessage({ role: 'assistant', content: [{ type: 'text', text }] });
      } else {
        const bar = (pct) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        const gt = r.ground_truth ? `\nGround truth: **${r.ground_truth}** ${r.correct ? '✓ correct' : '✗ incorrect'}` : '';
        const text =
          `**BRCA Subtype Prediction** *(ABMIL 5-fold ensemble, AUC 0.9624)*\n\n` +
          `Prediction: **${r.prediction}** — ${r.confidence}% confidence\n\n` +
          `IDC ${bar(r.idc_prob)} ${r.idc_prob}%\n` +
          `ILC ${bar(r.ilc_prob)} ${r.ilc_prob}%\n\n` +
          `Patches analysed: ${r.num_patches}  ·  Top-attention patches: ${r.top_patches.slice(0,5).join(', ')}…` +
          gt;
        addChatMessage({ role: 'assistant', content: [{ type: 'text', text }] });
      }
    } catch (err) {
      addChatMessage({ role: 'assistant', content: [{ type: 'text', text: `BRCA server error: ${err.message}` }], _error: true });
    } finally {
      setBrcaLoading(false);
    }
  };

  const handleGenerateReport = async () => {
    if (chatMessages.length === 0 || reportLoading) return;
    setReportLoading(true);
    try {
      const { report } = await generateReport(chatModel, systemPrompt, chatMessages);
      setReportText(report);
    } catch (err) {
      alert(`Report generation failed: ${err?.message}`);
    } finally {
      setReportLoading(false);
    }
  };

  const handleSuggestion = (text) => {
    setInput(text);
    textareaRef.current?.focus();
  };

  if (!activeItem) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
        Open a slide to start an AskPA consultation.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <style>{`
        @keyframes askpa-bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{
        padding: '8px 10px 6px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap',
      }}>
        <ModelSelector />
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <button
            onClick={handleBrcaPredict}
            disabled={brcaLoading}
            title="Run BRCA subtype prediction (IDC vs ILC) on this slide"
            style={{
              fontSize: 9, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
              background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.35)',
              color: '#34d399', opacity: brcaLoading ? 0.5 : 1,
            }}
          >
            {brcaLoading ? 'Predicting…' : '🔬 BRCA'}
          </button>
          {chatMessages.length > 0 && (
            <button
              onClick={handleGenerateReport}
              disabled={reportLoading}
              title="Generate pathology report from this conversation"
              style={{
                fontSize: 9, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.35)',
                color: '#60a5fa', opacity: reportLoading ? 0.5 : 1,
              }}
            >
              {reportLoading ? 'Generating…' : 'Report'}
            </button>
          )}
          {chatMessages.length > 0 && (
            <button
              onClick={clearChat}
              title="Clear conversation"
              style={{
                fontSize: 9, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)',
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Message thread */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px', minHeight: 0 }}>
        {chatMessages.length === 0 ? (
          <EmptyState onSuggestion={handleSuggestion} />
        ) : (
          <>
            {chatMessages.map((msg, i) =>
              msg.role === 'user'
                ? <UserBubble key={i} msg={msg} />
                : <AssistantBubble key={i} msg={msg} modelId={chatModel} />
            )}
            {chatLoading && <TypingIndicator />}
          </>
        )}
        {chatError && !chatLoading && (
          <div style={{ fontSize: 10, color: '#f87171', padding: '4px 0', textAlign: 'center' }}>
            {chatError}
          </div>
        )}
      </div>

      {/* Attachment preview */}
      <AttachmentPreview />

      {/* Input row */}
      <div style={{
        padding: '8px 8px 10px',
        borderTop: chatPendingAttachment ? 'none' : '1px solid var(--border)',
        display: 'flex', gap: 6, alignItems: 'flex-end',
      }}>
        <button
          onClick={handleAttachViewport}
          title="Include current viewport in next message"
          style={{
            flexShrink: 0, width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
            background: chatPendingAttachment ? 'rgba(77,166,255,0.2)' : 'rgba(255,255,255,0.05)',
            border: chatPendingAttachment ? '1px solid rgba(77,166,255,0.4)' : '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: chatPendingAttachment ? '#4da6ff' : 'var(--muted)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this slide… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={chatLoading}
          style={{
            flex: 1, resize: 'none', fontSize: 11, lineHeight: 1.5,
            padding: '6px 8px', borderRadius: 6,
            background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
            color: 'var(--fg)', outline: 'none', fontFamily: 'inherit',
          }}
        />

        <button
          onClick={handleSend}
          disabled={chatLoading || !input.trim()}
          title="Send message"
          style={{
            flexShrink: 0, width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
            background: input.trim() && !chatLoading ? 'rgba(124,58,237,0.8)' : 'rgba(124,58,237,0.2)',
            border: '1px solid rgba(124,58,237,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', transition: 'background 0.15s',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>

      {reportText && (
        <ReportModal report={reportText} onClose={() => setReportText(null)} />
      )}
    </div>
  );
}
