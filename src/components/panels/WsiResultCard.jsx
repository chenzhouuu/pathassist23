// src/components/panels/WsiResultCard.jsx
import React from 'react';
import { useStore } from '../../store/index.js';

const GRID_N = 4;

// ── Colour helpers ─────────────────────────────────────────────────────────────
function tumorColor(pct) {
  if (pct > 50) return '#e94560';
  if (pct > 20) return '#f5a623';
  return '#4caf82';
}
function heterogeneityLabel(hi) {
  if (hi > 0.6) return { text: 'High',     color: '#e94560' };
  if (hi > 0.3) return { text: 'Moderate', color: '#f5a623' };
  return              { text: 'Low',       color: '#4caf82' };
}

// ── Patch grid heatmap ────────────────────────────────────────────────────────
function PatchGrid({ patchResults, gridN }) {
  const cells = Array.from({ length: gridN * gridN }, (_, i) => {
    const p = (patchResults ?? []).find((r) => r.patchIndex === i);
    if (!p || p.status === 'pending')   return { color: 'rgba(255,255,255,0.06)', tip: `Patch ${i + 1}` };
    if (p.status === 'skipped')         return { color: 'rgba(255,255,255,0.12)', tip: `Patch ${i + 1}: background` };
    if (p.status === 'failed')          return { color: '#555', tip: `Patch ${i + 1}: failed` };
    const pct = p.tumor_pct ?? 0;
    return { color: tumorColor(pct), tip: `Patch ${i + 1}: ${pct.toFixed(0)}% tumor` };
  });

  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--muted-hex)', marginBottom: 4 }}>
        Tumor % per patch
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridN}, 1fr)`, gap: 2 }}>
        {cells.map(({ color, tip }, i) => (
          <div key={i} title={tip} style={{
            height: 16, borderRadius: 2, background: color,
            border: '1px solid rgba(255,255,255,0.06)',
          }} />
        ))}
      </div>
      {/* color scale legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--muted-hex)', marginTop: 3 }}>
        <span style={{ color: '#4caf82' }}>▪ &lt;20%</span>
        <span style={{ color: '#f5a623' }}>▪ 20-50%</span>
        <span style={{ color: '#e94560' }}>▪ &gt;50%</span>
      </div>
    </div>
  );
}

// ── Histogram bar chart ───────────────────────────────────────────────────────
function HistogramBars({ histogram }) {
  if (!histogram) return null;
  const max = Math.max(...histogram, 1);
  const labels = ['0–20%', '20–40%', '40–60%', '60–80%', '80–100%'];
  const colors = ['#4caf82', '#8bc34a', '#f5a623', '#ff7043', '#e94560'];
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--muted-hex)', marginBottom: 4 }}>
        Patch distribution (tumor %)
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 32 }}>
        {histogram.map((count, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <div style={{
              width: '100%', background: colors[i], borderRadius: '2px 2px 0 0',
              height: `${(count / max) * 100}%`, minHeight: count > 0 ? 3 : 0,
            }} />
            <span style={{ fontSize: 8, color: 'var(--muted-hex)', whiteSpace: 'nowrap' }}>{labels[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Metric row ────────────────────────────────────────────────────────────────
function Metric({ label, value, unit = '%', color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ fontSize: 10, color: 'var(--muted-hex)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--text)' }}>
        {value != null ? value : '—'}{value != null ? unit : ''}
      </span>
    </div>
  );
}

// ── Usage footer ──────────────────────────────────────────────────────────────
function UsageFooter({ usage, modelLabel }) {
  if (!usage) return null;
  const { input_tokens: inp, output_tokens: out, cost_usd, patch_calls } = usage;
  const costStr = cost_usd < 0.001 ? '<$0.001' : `$${cost_usd.toFixed(4)}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px 7px', borderTop: '1px solid var(--border-hex)', marginTop: 2 }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--muted-hex)" strokeWidth="2">
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
      </svg>
      <span style={{ fontSize: 9, color: 'var(--muted-hex)', flex: 1 }}>
        {modelLabel} · {patch_calls} patches
      </span>
      <span style={{ fontSize: 9, color: 'var(--muted-hex)' }}>
        {(inp + out).toLocaleString()} tok
      </span>
      <span style={{ fontSize: 9, fontWeight: 600, color: '#4caf82', background: 'rgba(76,175,130,0.12)', border: '1px solid rgba(76,175,130,0.3)', borderRadius: 3, padding: '1px 5px' }}>
        {costStr}
      </span>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────
export default function WsiResultCard({ entry }) {
  const removeAiResult = useStore((s) => s.removeAiResult);
  const viewer = useStore((s) => s.viewer);
  const annotations = useStore((s) => s.annotations);
  const setSelectedAnnotation = useStore((s) => s.setSelectedAnnotation);

  const locateRoi = () => {
    if (!entry.roi || !viewer?.viewport || !window.OpenSeadragon) return;
    const rect = new window.OpenSeadragon.Rect(entry.roi.x, entry.roi.y, entry.roi.width, entry.roi.height);
    viewer.viewport.fitBounds(rect, true);
    if (entry.aiAnnotationId) {
      const ann = annotations.find((a) => a._id === entry.aiAnnotationId);
      if (ann) setSelectedAnnotation(ann);
    }
  };

  // Error case
  if (entry.result?.error) {
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
      <div style={{ background: 'var(--bg-panel)', border: '1px solid rgba(233,69,96,0.35)', borderRadius: 10, overflow: 'hidden', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(233,69,96,0.2)' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e94560" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#e94560', flex: 1 }}>WSI analysis failed</span>
          <span style={{ fontSize: 10, color: 'var(--muted-hex)' }}>{time}</span>
          <button onClick={() => removeAiResult(entry.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--muted-hex)', display: 'flex' }}
            onMouseEnter={e => e.currentTarget.style.color = '#e94560'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--muted-hex)'}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--muted-hex)', lineHeight: 1.5 }}>
          {entry.result.error}
        </div>
      </div>
    );
  }

  const { aggregate: a, patchResults, gridN, itemName, modelLabel, timestamp, usage } = entry;

  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const hi   = a?.heterogeneity_index != null ? heterogeneityLabel(a.heterogeneity_index) : null;

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hex)', borderRadius: 10, overflow: 'hidden', marginBottom: 10 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border-hex)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {itemName || 'Slide'}
        </span>
        <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
          background: entry.type === 'roi-grid' ? 'rgba(77,166,255,0.15)' : 'rgba(52,168,83,0.15)',
          color: entry.type === 'roi-grid' ? '#4da6ff' : '#34a853',
          border: entry.type === 'roi-grid' ? '1px solid rgba(77,166,255,0.3)' : '1px solid rgba(52,168,83,0.3)',
          flexShrink: 0 }}>
          {entry.type === 'roi-grid' ? 'ROI Grid' : 'WSI'}
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted-hex)', flexShrink: 0 }}>{date} {time}</span>
        <button onClick={() => removeAiResult(entry.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--muted-hex)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
          onMouseEnter={e => e.currentTarget.style.color = '#e94560'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--muted-hex)'}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* body */}
      <div style={{ display: 'flex', gap: 10, padding: '10px' }}>
        {/* left: patch heatmap */}
        <div style={{ width: 90, flexShrink: 0 }}>
          <PatchGrid patchResults={patchResults} gridN={gridN ?? GRID_N} />
          <div style={{ marginTop: 8, fontSize: 9, color: 'var(--muted-hex)', textAlign: 'center' }}>
            {a?.analyzed_count ?? 0}/{a?.total_patches ?? (GRID_N * GRID_N)} patches
            {a?.skipped_count > 0 && ` · ${a.skipped_count} bg`}
          </div>
        </div>

        {/* right: metrics */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Metric label="Tumor %" value={a?.tumor_pct_mean?.toFixed(1)} color={tumorColor(a?.tumor_pct_mean ?? 0)} />
          <Metric label="Tumor purity" value={a?.tumor_purity != null ? (a.tumor_purity * 100).toFixed(1) : null} />
          <Metric label="Necrosis %" value={a?.necrosis_pct_mean?.toFixed(1)} color={a?.necrosis_pct_mean > 10 ? '#e94560' : undefined} />
          <Metric label="Stroma %" value={a?.stroma_pct_mean?.toFixed(1)} unit="%" color="#4da6ff" />
          {hi && (
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ fontSize: 10, color: 'var(--muted-hex)' }}>Heterogeneity</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: hi.color }}>
                {hi.text} <span style={{ fontSize: 9, fontWeight: 400, color: 'var(--muted-hex)' }}>CV={a.heterogeneity_index.toFixed(2)}</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* histogram */}
      {a?.tumor_pct_histogram && (
        <div style={{ padding: '0 10px 10px' }}>
          <HistogramBars histogram={a.tumor_pct_histogram} />
        </div>
      )}

      {/* patch-level stats */}
      {a && (
        <div style={{ padding: '0 10px 8px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {[
            { label: 'Min tumor', val: a.tumor_pct_min },
            { label: 'Max tumor', val: a.tumor_pct_max },
            { label: 'Std dev',   val: a.tumor_pct_std },
          ].map(({ label, val }) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{val?.toFixed(1) ?? '—'}%</div>
              <div style={{ fontSize: 9, color: 'var(--muted-hex)' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {a?.partial_warning && (
        <div style={{ padding: '0 10px 8px', fontSize: 10, color: '#f5a623' }}>
          ⚠ {a.partial_warning}
        </div>
      )}

      {entry.roi && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'0 10px 8px' }}>
          <div style={{ fontSize:10, color:'var(--muted-hex)', flex:1 }}>
            ROI {entry.roi.width}×{entry.roi.height} px · ({entry.roi.x}, {entry.roi.y})
          </div>
          <button
            onClick={locateRoi}
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '3px 8px',
              borderRadius: 999,
              background: 'rgba(77,166,255,0.12)',
              color: '#4da6ff',
              border: '1px solid rgba(77,166,255,0.25)',
              cursor: 'pointer',
            }}
          >
            Locate ROI
          </button>
        </div>
      )}

      <UsageFooter usage={usage} modelLabel={modelLabel} />
    </div>
  );
}
