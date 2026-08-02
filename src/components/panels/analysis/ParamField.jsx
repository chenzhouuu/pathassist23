// src/components/panels/analysis/ParamField.jsx — one form field, for either kind of tool.
//
// Moved out of AnalysisPanel (Inc 6 · 02) and extended rather than duplicated: a CLI's Slicer tags
// render exactly as before, and the three shapes native tools need that Slicer has no word for
// (`pa-scope`, `pa-region`, `pa-artifact`) are three more cases in the same switch. A second
// renderer is what the five panels already were.
//
// Two additions the CLI path also gets for free:
//   · `options` — `[{value,label}]`, for enums whose label differs from the value. Slicer's
//     `<enumeration>` has no label, so CLIs keep using `enums` and nothing changes for them.
//   · `disabled` — a field that is present but not applicable right now, which is how the region
//     picker reads while the scope is set to the whole slide.
import React from 'react';
import { formatRoi } from '../useRegionSelect.js';

const inputStyle = {
  width: '100%', fontSize: 11, padding: '5px 8px', borderRadius: 5,
  background: 'var(--bg)', border: '1px solid var(--border-hex)', color: 'var(--text)',
  outline: 'none', fontFamily: 'inherit',
};

const BLUE = '#4da6ff';

function Label({ label, desc }) {
  return (
    <label className="block mb-1.5" style={{ color: 'var(--text)', fontSize: 11, fontWeight: 500 }}>
      {label}
      {desc && (
        <span className="block mt-0.5 leading-relaxed"
          style={{ color: 'var(--muted-hex)', fontSize: 9, fontWeight: 400 }}>
          {desc}
        </span>
      )}
    </label>
  );
}

/** Whole slide vs a drawn region. The choice, not the rectangle — `pa-region` is the rectangle. */
function ScopeField({ param, value, onChange }) {
  const opts = [
    { v: 'region', label: 'Region' },
    { v: 'whole', label: 'Whole slide' },
  ];
  return (
    <div>
      <Label label={param.label} desc={param.desc} />
      <div className="flex gap-1" role="radiogroup" aria-label={param.label}>
        {opts.map(o => {
          const on = value === o.v;
          return (
            <button key={o.v} type="button" role="radio" aria-checked={on}
              onClick={() => onChange(o.v)}
              className="flex-1 py-1.5 rounded text-xs transition-all"
              style={{
                background: on ? 'rgba(77,166,255,0.18)' : 'var(--highlight-hex)',
                color: on ? BLUE : 'var(--muted-hex)',
                border: `1px solid ${on ? 'rgba(77,166,255,0.35)' : 'var(--border-hex)'}`,
              }}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The drawn rectangle, through the shared `useRegionSelect` handle.
 *
 * Deliberately not a text box of four numbers like the CLI `<region>` field: this region is app
 * state that Copilot and the other panels already read, so typing coordinates here would create a
 * second, private one.
 */
function RegionField({ param, region, disabled }) {
  const { roi, awaiting, start, cancel, clear, show } = region || {};
  const btn = (extra = {}) => ({
    background: 'rgba(77,166,255,0.12)', color: BLUE,
    border: '1px solid rgba(77,166,255,0.3)', whiteSpace: 'nowrap', ...extra,
  });

  return (
    <div style={{ opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      <Label label={param.label} desc={param.desc} />
      {roi ? (
        <div className="flex items-center gap-1.5">
          <div className="flex-1 px-2 py-1.5 rounded truncate"
            style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10 }}
            title={formatRoi(roi)}>
            {formatRoi(roi)}
          </div>
          <button type="button" onClick={show} disabled={disabled}
            className="px-2 py-1 rounded shrink-0 text-xs" style={btn()}
            title="Bring the region back into view">Show</button>
          <button type="button" onClick={clear} disabled={disabled}
            className="px-2 py-1 rounded shrink-0 text-xs"
            style={{ background: 'var(--highlight-hex)', color: 'var(--muted-hex)', border: '1px solid var(--border-hex)' }}
            title="Forget this region">✕</button>
        </div>
      ) : awaiting ? (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded"
          style={{ background: 'rgba(77,166,255,0.12)', border: '1px solid rgba(77,166,255,0.35)' }}>
          <div className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: BLUE }} />
          <span style={{ color: BLUE, fontSize: 11 }}>Draw a rectangle on the slide…</span>
          <button type="button" onClick={cancel} className="ml-auto text-xs shrink-0"
            style={{ color: 'var(--muted-hex)' }}>Esc</button>
        </div>
      ) : (
        <button type="button" onClick={start} disabled={disabled}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs"
          style={btn()}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="3" y="3" width="18" height="18" rx="1" />
          </svg>
          Draw region
        </button>
      )}
    </div>
  );
}

/**
 * Pick an upstream artifact of one kind from this slide's ready rows.
 *
 * Empty is a real state and says so: "no nuclei run on this slide yet" is the answer to why the
 * Marker map cannot be submitted, and a disabled dropdown with no explanation is not.
 */
function ArtifactField({ param, value, onChange, artifacts, loading }) {
  // Not `status === 'ready'`. A **stopped** run leaves a complete artifact of a smaller area —
  // that is the whole point of a cooperative stop — and refusing to offer it would mean an hour of
  // whole-slide nuclei could not be used to run a marker map. What is excluded is a build with
  // nothing behind it yet: still queued, still running, or failed. For nuclei, which since 05 has
  // no row at all until its bytes exist, every row is offerable and this filter passes everything.
  const rows = (artifacts || []).filter(
    a => a.kind === param.artifactKind && !['queued', 'running', 'failed'].includes(a.status),
  );
  const describe = (a) => {
    const bits = [a.art_hash.slice(0, 8)];
    if (a.n_items != null) bits.push(`${a.n_items.toLocaleString()} items`);
    const when = a.created_at ? new Date(a.created_at).toLocaleDateString() : null;
    if (when) bits.push(when);
    return bits.join(' · ');
  };

  return (
    <div>
      <Label label={param.label} desc={param.desc} />
      {loading ? (
        <div style={{ ...inputStyle, color: 'var(--muted-hex)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded px-2 py-1.5 text-xs"
          style={{ background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', color: '#f5a623' }}>
          No {param.artifactKind} on this slide yet — run one first.
        </div>
      ) : (
        <select value={value || ''} onChange={e => onChange(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">Select…</option>
          {rows.map(a => <option key={a.art_hash} value={a.art_hash}>{describe(a)}</option>)}
        </select>
      )}
    </div>
  );
}

/** A single rendered form field, for a CLI param or a native one. */
export default function ParamField({
  param, value, onChange, onDrawRoi, region, artifacts, artifactsLoading, disabled = false,
}) {
  const { tag, label, desc, defVal, enums, options, min, max } = param;

  // ── Native-only shapes ────────────────────────────────────────────────────────────────
  if (tag === 'pa-scope') return <ScopeField param={param} value={value} onChange={onChange} />;
  if (tag === 'pa-region') return <RegionField param={param} region={region} disabled={disabled} />;
  if (tag === 'pa-artifact') return (
    <ArtifactField param={param} value={value} onChange={onChange}
      artifacts={artifacts} loading={artifactsLoading} />
  );

  // ── Slicer CLI shapes, unchanged ──────────────────────────────────────────────────────
  if (tag === 'boolean') return (
    <div className="flex items-start gap-2.5">
      <input type="checkbox" checked={value === 'true'} id={param.name}
        onChange={e => onChange(e.target.checked ? 'true' : 'false')}
        style={{ accentColor: BLUE, marginTop: 2, flexShrink: 0 }} />
      <label htmlFor={param.name} className="cursor-pointer" style={{ color: 'var(--text)', fontSize: 11 }}>
        {label}
        {desc && <span className="block mt-0.5" style={{ color: 'var(--muted-hex)', fontSize: 9 }}>{desc}</span>}
      </label>
    </div>
  );

  if (tag === 'string-enumeration') {
    // An option may carry a `note` — what is true about *that* choice specifically. The task
    // picker is what it exists for (Inc 6 · 07): a model's cohort, its metrics and its caveat are
    // facts about the selected head, not about the field, and the Task panel that used to state
    // them in a card is gone. Options without one render exactly as before.
    const chosen = options?.find(o => String(o.value) === String(value));
    return (
      <div>
        <Label label={label} desc={desc} />
        <select value={value} onChange={e => onChange(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}>
          {/* `options` carries a label distinct from the value; Slicer's <enumeration> has no
              label and so keeps the plain list. */}
          {options
            ? [<option key="" value="">Select…</option>,
               ...options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)]
            : enums.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        {chosen?.note && (
          <div className="mt-1.5 px-2 py-1.5 rounded leading-relaxed" data-cy="option-note"
            style={{
              background: 'var(--highlight-hex)', border: '1px solid var(--border-hex)',
              color: 'var(--muted-hex)', fontSize: 9, whiteSpace: 'pre-line',
            }}>
            {chosen.note}
          </div>
        )}
      </div>
    );
  }

  // ROI inputs: both <region> and <float-vector> are used by HistomicsTK for analysis_roi
  if (tag === 'region' || tag === 'float-vector') return (
    <div>
      <Label label={label} desc={desc} />
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input type="text" value={value} onChange={e => onChange(e.target.value)}
            placeholder={tag === 'region' ? '[-1, -1, -1, -1]' : '-1,-1,-1,-1'}
            style={{ ...inputStyle, fontFamily: 'monospace', paddingRight: value && value !== '-1,-1,-1,-1' ? 24 : 8 }}
            onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.5)'}
            onBlur={e => e.target.style.borderColor = 'var(--border-hex)'} />
          {value && value !== '-1,-1,-1,-1' && (
            <button onClick={() => onChange('-1,-1,-1,-1')}
              style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-hex)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, padding: 0 }}
              title="Reset to full slide">✕</button>
          )}
        </div>
        {/* Draw ROI button — triggers rectangle selection on the viewer canvas */}
        {onDrawRoi && (
          <button onClick={onDrawRoi}
            className="flex items-center gap-1 px-2 py-1 rounded shrink-0 text-xs transition-all"
            style={{ background: 'rgba(77,166,255,0.12)', color: BLUE, border: '1px solid rgba(77,166,255,0.3)', whiteSpace: 'nowrap' }}
            title="Draw a rectangle on the slide to set ROI coordinates">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="18" height="18" rx="1" />
            </svg>
            Draw
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 mt-1.5">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--muted-hex)" strokeWidth="2">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span style={{ color: 'var(--muted-hex)', fontSize: 9 }}>
          left, top, width, height (pixels) &nbsp;·&nbsp; <span style={{ fontFamily: 'monospace' }}>-1,-1,-1,-1</span> = entire slide
        </span>
      </div>
    </div>
  );

  if (tag === 'integer' || tag === 'float') return (
    <div>
      <Label label={label} desc={desc} />
      <input type="number" value={value} step={tag === 'integer' ? 1 : (param.step || 'any')}
        min={min} max={max}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
        onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.5)'}
        onBlur={e => e.target.style.borderColor = 'var(--border-hex)'} />
      {(min !== undefined || max !== undefined) && (
        <div style={{ color: 'var(--muted-hex)', fontSize: 9, marginTop: 3 }}>
          {min !== undefined && `min: ${min}`}{min !== undefined && max !== undefined && ' · '}{max !== undefined && `max: ${max}`}
        </div>
      )}
    </div>
  );

  // string / default
  return (
    <div>
      <Label label={label} desc={desc} />
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={defVal}
        style={inputStyle}
        onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.5)'}
        onBlur={e => e.target.style.borderColor = 'var(--border-hex)'} />
    </div>
  );
}
