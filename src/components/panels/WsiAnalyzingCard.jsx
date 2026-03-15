// src/components/panels/WsiAnalyzingCard.jsx
import React from 'react';
import { useStore } from '../../store/index.js';

// Grid size is dynamic — driven by progress.total

const STATE_COLOR = {
  pending:   'rgba(255,255,255,0.08)',
  analyzing: '#4da6ff',
  done:      '#4caf82',
  skipped:   'rgba(255,255,255,0.15)',
  failed:    '#e94560',
};

export default function WsiAnalyzingCard() {
  const progress = useStore((s) => s.wsiProgress);
  if (!progress) return null;

  const { current, total, patchGrid } = progress;
  const gridN    = Math.round(Math.sqrt(total)) || 4;
  const done     = (patchGrid ?? []).filter((s) => s === 'done').length;
  const skipped  = (patchGrid ?? []).filter((s) => s === 'skipped').length;

  return (
    <div style={{
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 12px', marginBottom: 10,
    }}>
      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 18, height: 18, borderRadius: '50%',
          border: '2.5px solid #4da6ff', borderTopColor: 'transparent',
          animation: 'spin 0.9s linear infinite', flexShrink: 0,
        }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            Analyzing whole slide…
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
            Patch {current} / {total} · {done} analyzed · {skipped} background
          </div>
        </div>
        <span style={{
          fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
          background: 'rgba(52,168,83,0.15)', color: '#34a853',
          border: '1px solid rgba(52,168,83,0.3)',
        }}>Gemini</span>
      </div>

      {/* 4×4 live patch grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${gridN}, 1fr)`,
        gap: 3,
      }}>
        {Array.from({ length: total }, (_, i) => {
          const state = (patchGrid ?? [])[i] ?? 'pending';
          return (
            <div key={i} title={`Patch ${i + 1}: ${state}`} style={{
              height: 18, borderRadius: 3,
              background: STATE_COLOR[state] ?? STATE_COLOR.pending,
              border: state === 'analyzing' ? '1px solid #4da6ff' : '1px solid rgba(255,255,255,0.06)',
              transition: 'background 0.3s',
            }} />
          );
        })}
      </div>

      {/* legend */}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {[
          { state: 'done',      label: 'Analyzed'   },
          { state: 'analyzing', label: 'Running'    },
          { state: 'skipped',   label: 'Background' },
          { state: 'failed',    label: 'Failed'     },
        ].map(({ state, label }) => (
          <div key={state} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: STATE_COLOR[state] }} />
            <span style={{ fontSize: 9, color: 'var(--muted)' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
