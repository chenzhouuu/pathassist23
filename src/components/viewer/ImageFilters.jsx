// src/components/viewer/ImageFilters.jsx
// Slide image filters: contrast, brightness, saturation, hue-rotate,
// invert, blur, grayscale — applied as CSS filters on the OSD canvas.
import React, { useState, useEffect, useRef } from 'react';

const DEFAULT = {
  contrast:   100,  // % → CSS contrast(X/100)
  brightness: 100,  // % → CSS brightness(X/100)
  saturation: 100,  // % → CSS saturate(X/100)
  hueRotate:    0,  // deg → CSS hue-rotate(Xdeg)
  invert:       0,  // % → CSS invert(X/100)
  blur:         0,  // px → CSS blur(Xpx)
  grayscale:    0,  // % → CSS grayscale(X/100)
};

function isDefault(f) {
  return (
    f.contrast   === 100 && f.brightness === 100 && f.saturation === 100 &&
    f.hueRotate  ===   0 && f.invert     ===   0 &&
    f.blur       ===   0 && f.grayscale  ===   0
  );
}

function buildFilter(f) {
  const parts = [];
  if (f.contrast   !== 100) parts.push(`contrast(${f.contrast / 100})`);
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness / 100})`);
  if (f.saturation !== 100) parts.push(`saturate(${f.saturation / 100})`);
  if (f.hueRotate  !==   0) parts.push(`hue-rotate(${f.hueRotate}deg)`);
  if (f.invert     !==   0) parts.push(`invert(${f.invert / 100})`);
  if (f.blur       !==   0) parts.push(`blur(${f.blur}px)`);
  if (f.grayscale  !==   0) parts.push(`grayscale(${f.grayscale / 100})`);
  return parts.join(' ');
}

function getCanvas(viewer) {
  return viewer.current?.drawer?.canvas
    || document.querySelector('#osd-viewer canvas');
}

function SliderRow({ label, value, min, max, step, onChange }) {
  return (
    <div className="flex items-center gap-2" style={{ minHeight: 26 }}>
      <span className="text-xs shrink-0" style={{ width: 76, color: 'var(--muted-hex)' }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
        style={{ accentColor: '#4da6ff' }}
      />
      <span className="text-xs font-mono text-right shrink-0" style={{ width: 32, color: 'var(--muted-hex)' }}>
        {value}
      </span>
    </div>
  );
}

export default function ImageFilters({ viewer }) {
  const [open,    setOpen]    = useState(false);
  const [filters, setFilters] = useState(DEFAULT);
  const wrapRef = useRef(null);

  const noChange = isDefault(filters);

  const apply = (next) => {
    const canvas = getCanvas(viewer);
    if (!canvas) return;
    canvas.style.filter = isDefault(next) ? '' : buildFilter(next);
  };

  const update = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    apply(next);
  };

  const reset = () => {
    setFilters(DEFAULT);
    const canvas = getCanvas(viewer);
    if (canvas) canvas.style.filter = '';
  };

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>

      {/* Toolbar button */}
      <button
        className={`tool-btn ${open || !noChange ? 'active' : ''}`}
        title="Slide Filters"
        onClick={() => setOpen(o => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
        </svg>
        {!noChange && (
          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400"/>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-50 rounded-xl p-4"
          style={{
            width: 290,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-hex)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}>

          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold" style={{ color: 'var(--text)' }}>Slide Filters</span>
            {!noChange && (
              <button onClick={reset}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                Reset All
              </button>
            )}
          </div>

          <div className="flex flex-col gap-2.5">
            <SliderRow label="Contrast"   value={filters.contrast}   min={0} max={300} step={1}   onChange={v => update('contrast',   v)}/>
            <SliderRow label="Brightness" value={filters.brightness} min={0} max={300} step={1}   onChange={v => update('brightness', v)}/>
            <SliderRow label="Saturation" value={filters.saturation} min={0} max={300} step={1}   onChange={v => update('saturation', v)}/>
            <SliderRow label="Hue Rotate" value={filters.hueRotate}  min={0} max={360} step={1}   onChange={v => update('hueRotate',  v)}/>
            <SliderRow label="Invert"     value={filters.invert}     min={0} max={100} step={1}   onChange={v => update('invert',     v)}/>
            <SliderRow label="Blur"       value={filters.blur}       min={0} max={20}  step={0.5} onChange={v => update('blur',       v)}/>
            <SliderRow label="Grayscale"  value={filters.grayscale}  min={0} max={100} step={1}   onChange={v => update('grayscale',  v)}/>
          </div>
        </div>
      )}
    </div>
  );
}
