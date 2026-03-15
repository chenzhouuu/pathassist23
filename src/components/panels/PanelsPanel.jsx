// src/components/panels/PanelsPanel.jsx
// Collected viewport captures across slides — select and submit to Pragna AI.
import React, { useState } from 'react';
import { useStore } from '../../store/index.js';
import { getRegionImageBlob } from '../../api/index.js';
import { analyzeKi67WithGemini, GEMINI_MODEL_LABEL } from '../../api/geminiApi.js';

export default function PanelsPanel() {
  const { panels, removePanel, clearPanels, addAiResult, setRightPanelTab } = useStore();
  const [selected, setSelected] = useState(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }

  const toggleSelect = (id) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = () => {
    if (selected.size === panels.length) setSelected(new Set());
    else setSelected(new Set(panels.map((p) => p.id)));
  };

  const handleAnalyze = async () => {
    const targets = panels.filter((p) => selected.has(p.id));
    if (!targets.length) return;
    setAnalyzing(true);
    setProgress({ done: 0, total: targets.length });

    for (let i = 0; i < targets.length; i++) {
      const panel = targets[i];
      try {
        const { x, y, width, height } = panel.region;
        const blob = await getRegionImageBlob(panel.itemId, x, y, width, height, 20, 512);
        const { result, usage } = await analyzeKi67WithGemini(blob);
        addAiResult({
          id: crypto.randomUUID(),
          type: 'ki67',
          timestamp: new Date().toISOString(),
          itemId:     panel.itemId,
          itemName:   panel.itemName,
          modelLabel: 'Pragna',
          roi:        panel.region,
          thumbnail:  panel.thumbnail,
          result,
          usage,
        });
      } catch (e) {
        addAiResult({
          id: crypto.randomUUID(),
          type: 'ki67',
          timestamp: new Date().toISOString(),
          itemId:    panel.itemId,
          itemName:  panel.itemName,
          modelLabel: 'Pragna',
          result: { error: e?.message || 'Analysis failed' },
        });
      }
      setProgress({ done: i + 1, total: targets.length });
      if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 400));
    }

    setAnalyzing(false);
    setProgress(null);
    setSelected(new Set());
    setRightPanelTab('ai');
  };

  if (!panels.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-4" style={{ color: 'var(--muted)', minHeight: 180 }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
          <path d="M6 20.5h12"/>
        </svg>
        <div style={{ fontSize: 11, textAlign: 'center', lineHeight: 1.5 }}>
          No panels captured yet.<br/>
          Use <strong style={{ color: 'var(--text)' }}>Camera Save to Server</strong> to capture regions of interest.
        </div>
      </div>
    );
  }

  const allSelected = selected.size === panels.length;
  const nSelected = selected.size;

  return (
    <div className="flex flex-col h-full" style={{ overflow: 'hidden' }}>
      {/* ── Toolbar ── */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <button
          onClick={toggleAll}
          style={{ fontSize: 10, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <span style={{ fontSize: 10, color: 'var(--muted)', flex: 1 }}>{panels.length} panel{panels.length !== 1 ? 's' : ''}</span>
        {nSelected > 0 && !analyzing && (
          <button
            onClick={handleAnalyze}
            style={{
              fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
              background: 'rgba(124,58,237,0.15)', color: '#7c3aed',
              border: '1px solid rgba(124,58,237,0.35)',
            }}>
            Analyze {nSelected} with Pragna
          </button>
        )}
        {analyzing && progress && (
          <span style={{ fontSize: 10, color: '#7c3aed' }}>
            Analyzing {progress.done}/{progress.total}…
          </span>
        )}
        <button
          onClick={clearPanels}
          title="Clear all panels"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--muted)' }}
          onMouseEnter={e => e.currentTarget.style.color = '#e94560'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>

      {/* ── Panel cards ── */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {panels.map((panel) => {
          const isSelected = selected.has(panel.id);
          const time = new Date(panel.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const date = new Date(panel.capturedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
          const { x, y, width, height } = panel.region;
          return (
            <div
              key={panel.id}
              onClick={() => toggleSelect(panel.id)}
              style={{
                display: 'flex', gap: 8, borderRadius: 8, padding: '6px 8px', cursor: 'pointer',
                background: isSelected ? 'rgba(124,58,237,0.08)' : 'var(--highlight)',
                border: isSelected ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                transition: 'all 0.15s',
              }}>
              {/* Checkbox */}
              <div style={{ paddingTop: 2, flexShrink: 0 }}>
                <div style={{
                  width: 14, height: 14, borderRadius: 3, border: `1.5px solid ${isSelected ? '#7c3aed' : 'var(--border)'}`,
                  background: isSelected ? '#7c3aed' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {isSelected && (
                    <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                      <polyline points="2 6 5 9 10 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              </div>
              {/* Thumbnail */}
              <div style={{ width: 60, height: 45, flexShrink: 0, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-viewer)', border: '1px solid var(--border)' }}>
                {panel.thumbnail
                  ? <img src={panel.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.5">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                      </svg>
                    </div>
                }
              </div>
              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {panel.itemName}
                </div>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>
                  {date} {time}
                </div>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1, fontFamily: 'monospace' }}>
                  {Math.round(width / 1000)}k × {Math.round(height / 1000)}k px
                  <span style={{ marginLeft: 4 }}>@({Math.round(x / 1000)}k, {Math.round(y / 1000)}k)</span>
                </div>
              </div>
              {/* Delete */}
              <button
                onClick={(e) => { e.stopPropagation(); removePanel(panel.id); setSelected((s) => { const n = new Set(s); n.delete(panel.id); return n; }); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--muted)', alignSelf: 'flex-start', flexShrink: 0 }}
                onMouseEnter={e => e.currentTarget.style.color = '#e94560'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
