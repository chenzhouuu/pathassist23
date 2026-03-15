// src/components/panels/AIPanel.jsx
// AI analysis panel — shows Ki67 IHC results produced by Claude Opus.
import React from 'react';
import { useStore } from '../../store/index.js';
import { AI_MODEL_LABEL } from '../../api/claudeApi.js';
import WsiResultCard from './WsiResultCard.jsx';
import WsiAnalyzingCard from './WsiAnalyzingCard.jsx';

// ── Colour helpers ─────────────────────────────────────────────────────────────
function activityColor(level) {
  if (level === 'high')         return '#e94560';
  if (level === 'intermediate') return '#f5a623';
  if (level === 'low')          return '#4caf82';
  return 'var(--muted)';
}
function qualityColor(q) {
  if (q === 'good') return '#4caf82';
  if (q === 'fair') return '#f5a623';
  if (q === 'poor') return '#e94560';
  return 'var(--muted)';
}
function confidenceColor(c) {
  if (c === 'high')   return '#4caf82';
  if (c === 'medium') return '#f5a623';
  if (c === 'low')    return '#e94560';
  return 'var(--muted)';
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function Ki67Bar({ pct }) {
  const p = typeof pct === 'number' && isFinite(pct) ? pct : 0;
  const color = p > 30 ? '#e94560' : p > 15 ? '#f5a623' : '#4caf82';
  return (
    <div style={{ position:'relative', height:8, borderRadius:4, background:'var(--border)', overflow:'hidden', margin:'6px 0 2px' }}>
      <div style={{ position:'absolute', left:0, top:0, bottom:0, width:`${Math.min(p,100)}%`, background:color, borderRadius:4, transition:'width 0.6s ease' }} />
      <div style={{ position:'absolute', left:'15%', top:0, bottom:0, width:1, background:'rgba(255,255,255,0.3)' }} />
      <div style={{ position:'absolute', left:'30%', top:0, bottom:0, width:1, background:'rgba(255,255,255,0.3)' }} />
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────────
function Badge({ label, color }) {
  if (!label || label === 'undefined' || label === 'null') return null;
  return (
    <span style={{
      fontSize:9, fontWeight:600, padding:'2px 6px', borderRadius:4,
      background:`${color}22`, color, border:`1px solid ${color}44`,
      textTransform:'capitalize',
    }}>
      {label}
    </span>
  );
}

// ── Error card ────────────────────────────────────────────────────────────────
function ErrorCard({ entry, onRemove }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  return (
    <div style={{ background:'var(--bg-panel)', border:'1px solid rgba(233,69,96,0.35)', borderRadius:10, overflow:'hidden', marginBottom:10 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderBottom:'1px solid rgba(233,69,96,0.2)' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e94560" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style={{ fontSize:11, fontWeight:600, color:'#e94560', flex:1 }}>Analysis failed</span>
        <span style={{ fontSize:10, color:'var(--muted)' }}>{time}</span>
        <button onClick={onRemove} style={{ background:'none', border:'none', cursor:'pointer', padding:'2px', color:'var(--muted)', display:'flex' }}
          onMouseEnter={e => e.currentTarget.style.color='#e94560'}
          onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div style={{ padding:'8px 10px', fontSize:11, color:'var(--muted)', lineHeight:1.5 }}>
        {entry.result?.error || 'Unknown error'}
      </div>
    </div>
  );
}

// ── Model badge in card header ─────────────────────────────────────────────────
function ModelTag({ label }) {
  if (!label) return null;
  const isGemini = label.includes('Gemini');
  const color = isGemini ? '#34a853' : '#4da6ff';
  const short = isGemini ? 'Gemini' : 'Sonnet';
  return (
    <span style={{
      fontSize:9, fontWeight:600, padding:'1px 5px', borderRadius:3,
      background:`${color}18`, color, border:`1px solid ${color}33`,
      flexShrink:0,
    }}>{short}</span>
  );
}

// ── Single result card ────────────────────────────────────────────────────────
function ResultCard({ entry }) {
  const { roi, thumbnailUrl, result: r, timestamp, itemName, modelLabel } = entry;
  const removeAiResult = useStore((s) => s.removeAiResult);

  if (r?.error) return <ErrorCard entry={entry} onRemove={() => removeAiResult(entry.id)} />;

  const time = new Date(timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const date = new Date(timestamp).toLocaleDateString([], { month:'short', day:'numeric' });

  const pct      = typeof r.ki67_percentage === 'number' ? r.ki67_percentage : null;
  const activity = r.proliferation_activity;
  const quality  = r.stain_quality;
  const conf     = r.confidence;

  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  return (
    <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden', marginBottom:10 }}>
      {/* header */}
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 10px', borderBottom:'1px solid var(--border)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/>
        </svg>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--text)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {itemName || 'Slide'}
        </span>
        <ModelTag label={modelLabel} />
        <span style={{ fontSize:10, color:'var(--muted)', flexShrink:0 }}>{date} {time}</span>
        <button
          onClick={() => removeAiResult(entry.id)}
          title="Remove this result"
          style={{ background:'none', border:'none', cursor:'pointer', padding:'2px', color:'var(--muted)', display:'flex', alignItems:'center', flexShrink:0 }}
          onMouseEnter={e => e.currentTarget.style.color='#e94560'}
          onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* body */}
      <div style={{ display:'flex', gap:10, padding:'10px 10px 8px' }}>
        {thumbnailUrl && (
          <img src={thumbnailUrl} alt="ROI"
            style={{ width:68, height:68, objectFit:'cover', borderRadius:6, flexShrink:0, border:'1px solid var(--border)' }}
          />
        )}
        <div style={{ flex:1, minWidth:0 }}>
          {/* big percentage */}
          <div style={{ display:'flex', alignItems:'baseline', gap:4, marginBottom:2 }}>
            <span style={{ fontSize:30, fontWeight:700, lineHeight:1, color: activityColor(activity) }}>
              {pct != null ? pct.toFixed(1) : '—'}
            </span>
            <span style={{ fontSize:11, color:'var(--muted)', fontWeight:500 }}>% Ki67+</span>
          </div>
          <Ki67Bar pct={pct ?? 0} />
          {/* axis labels */}
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'var(--muted)', marginBottom:7 }}>
            <span>0</span><span>15%</span><span>30%</span><span>100%</span>
          </div>

          {/* cell counts */}
          <div style={{ display:'flex', gap:8, marginBottom:8 }}>
            {[
              { val: r.positive_count, label:'positive', color:'#c8813a' },
              { val: r.negative_count, label:'negative', color:'#4da6ff' },
              { val: r.total_count,    label:'total',    color:'var(--text)' },
            ].map(({ val, label, color }, i, arr) => (
              <React.Fragment key={label}>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:14, fontWeight:700, color, lineHeight:1.2 }}>{val?.toLocaleString() ?? '—'}</div>
                  <div style={{ fontSize:9, color:'var(--muted)', marginTop:1 }}>{label}</div>
                </div>
                {i < arr.length - 1 && <div style={{ width:1, background:'var(--border)', alignSelf:'stretch' }} />}
              </React.Fragment>
            ))}
          </div>

          {/* badges */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
            {activity && <Badge label={cap(activity)}                    color={activityColor(activity)} />}
            {quality  && <Badge label={`Quality: ${cap(quality)}`}       color={qualityColor(quality)}   />}
            {conf     && <Badge label={`Confidence: ${cap(conf)}`}       color={confidenceColor(conf)}   />}
          </div>
        </div>
      </div>

      {r.interpretation && (
        <div style={{ padding:'0 10px 8px', fontSize:11, color:'var(--text)', lineHeight:1.6, borderTop:'1px solid var(--border)', paddingTop:8 }}>
          {r.interpretation}
        </div>
      )}
      {r.notes && (
        <div style={{ padding:'0 10px 8px', fontSize:10, color:'var(--muted)', lineHeight:1.5, fontStyle:'italic' }}>
          {r.notes}
        </div>
      )}
      {roi && (
        <div style={{ padding:'3px 10px 4px', fontSize:10, color:'var(--muted)', opacity:0.7 }}>
          {roi.width}×{roi.height} px · ({roi.x}, {roi.y})
        </div>
      )}

      <UsageFooter usage={entry.usage} modelLabel={modelLabel} />
    </div>
  );
}

function UsageFooter({ usage, modelLabel }) {
  if (!usage) return null;
  const { input_tokens: inp, output_tokens: out, cost_usd } = usage;
  const totalTok = (inp + out).toLocaleString();
  const costStr  = cost_usd < 0.001 ? '<$0.001' : `$${cost_usd.toFixed(4)}`;
  const isGemini = modelLabel?.includes('Gemini');
  const modelIcon = isGemini
    ? <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
    : <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 10px 7px', borderTop:'1px solid var(--border)', marginTop:2 }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2">
        {modelIcon}
      </svg>
      <span style={{ fontSize:9, color:'var(--muted)', flex:1 }}>{modelLabel || AI_MODEL_LABEL}</span>
      <span style={{ fontSize:9, color:'var(--muted)' }}>
        {inp.toLocaleString()} in · {out.toLocaleString()} out · {totalTok} tok
      </span>
      <span style={{
        fontSize:9, fontWeight:600, color:'#4caf82',
        background:'rgba(76,175,130,0.12)', border:'1px solid rgba(76,175,130,0.3)',
        borderRadius:3, padding:'1px 5px',
      }}>
        {costStr}
      </span>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ ki67Pending }) {
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:24, textAlign:'center', gap:12 }}>
      {ki67Pending ? (
        <>
          <div style={{ width:36, height:36, borderRadius:'50%', border:'3px solid #4da6ff', borderTopColor:'transparent', animation:'spin 0.9s linear infinite' }} />
          <div style={{ fontSize:12, color:'var(--text)', fontWeight:600 }}>Draw ROI on the slide</div>
          <div style={{ fontSize:11, color:'var(--muted)' }}>Click and drag a rectangle over the area of interest, then release to start Ki67 analysis.</div>
        </>
      ) : (
        <>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.5">
            <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"/>
          </svg>
          <div style={{ fontSize:12, color:'var(--text)', fontWeight:600 }}>No AI analyses yet</div>
          <div style={{ fontSize:11, color:'var(--muted)', maxWidth:190, lineHeight:1.5 }}>
            Right-click on the slide:<br/>
            <strong style={{ color:'var(--text)' }}>Analyze Ki67 %</strong> — draw a region<br/>
            <strong style={{ color:'var(--text)' }}>Analyze Whole Slide</strong> — full scan
          </div>
        </>
      )}
    </div>
  );
}

// ── Analyzing spinner ─────────────────────────────────────────────────────────
function AnalyzingCard() {
  const pendingModel = useStore((s) => s.ki67PendingModel);
  const label = pendingModel === 'gemini' ? 'Gemini 2.5 Flash Lite' : AI_MODEL_LABEL;
  return (
    <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 12px', marginBottom:10, display:'flex', alignItems:'center', gap:10 }}>
      <div style={{ width:20, height:20, borderRadius:'50%', border:'2.5px solid #4da6ff', borderTopColor:'transparent', animation:'spin 0.9s linear infinite', flexShrink:0 }} />
      <div>
        <div style={{ fontSize:12, fontWeight:600, color:'var(--text)' }}>Analyzing with {label}…</div>
        <div style={{ fontSize:10, color:'var(--muted)', marginTop:2 }}>Counting Ki67+ nuclei at 40× magnification</div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function AIPanel() {
  const { aiResults, clearAiResults, ki67RoiPending } = useStore();
  const analyzing    = useStore((s) => s.ki67Analyzing);
  const wsiAnalyzing = useStore((s) => s.wsiAnalyzing);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      {/* header */}
      <div style={{ padding:'10px 12px 8px', borderBottom:'1px solid var(--border)', flexShrink:0, display:'flex', alignItems:'center', gap:8 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--text)', flex:1 }}>AI Analysis</span>
        {aiResults.length > 0 && (
          <button onClick={clearAiResults}
            style={{ fontSize:10, color:'var(--muted)', background:'none', border:'none', cursor:'pointer', padding:'2px 4px', borderRadius:4 }}
            onMouseEnter={e => e.currentTarget.style.color='#e94560'}
            onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}
          >Clear all</button>
        )}
      </div>

      {/* hint strip */}
      {!ki67RoiPending && !analyzing && !wsiAnalyzing && (
        <div style={{ padding:'6px 12px', background:'rgba(77,166,255,0.08)', borderBottom:'1px solid rgba(77,166,255,0.15)', flexShrink:0 }}>
          <span style={{ fontSize:10, color:'#4da6ff' }}>
            Right-click on the slide → <strong>Analyze Ki67 %</strong> → draw a region of interest
          </span>
        </div>
      )}

      {/* scrollable results */}
      <div style={{ flex:1, overflowY:'auto', padding:'10px 10px 0' }}>
        {wsiAnalyzing && <WsiAnalyzingCard />}
        {analyzing    && <AnalyzingCard />}
        {aiResults.length === 0 && !analyzing && !wsiAnalyzing
          ? <EmptyState ki67Pending={ki67RoiPending} />
          : aiResults.map((entry) =>
              entry.type === 'wsi' || entry.type === 'roi-grid'
                ? <WsiResultCard key={entry.id} entry={entry} />
                : <ResultCard    key={entry.id} entry={entry} />
            )
        }
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
