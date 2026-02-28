// src/components/panels/AnnotationsPanel.jsx
// Foldable annotation list matching HistomicsUI style
import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnnotationList, getAnnotationFull, deleteAnnotation, updateAnnotation } from '../../api/index.js';
import { ANN_COLORS, hexToRgba } from '../annotations/annotationUtils.js';

const DRAW_COLORS = [
  '#4da6ff','#e94560','#4caf82','#f5a623',
  '#c27aff','#ff6b6b','#00bcd4','#ff9800',
];

// Element type icons
function ElementIcon({ type }) {
  const props = { width:11, height:11, viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', strokeWidth:2 };
  if (type === 'point')     return <svg {...props}><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>;
  if (type === 'rectangle') return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="2"/></svg>;
  if (type === 'ellipse')   return <svg {...props}><ellipse cx="12" cy="12" rx="9" ry="6"/></svg>;
  if (type === 'polyline')  return <svg {...props}><polyline points="3 17 9 11 13 15 21 7"/></svg>;
  return <svg {...props}><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/></svg>;
}

// Single element row inside an expanded annotation
function ElementRow({ el, idx, annColor }) {
  const lc = el.lineColor || annColor;
  const typeLabel = el.type === 'polyline' ? (el.closed ? 'polygon' : 'polyline') : el.type;
  const coords = el.center
    ? `(${Math.round(el.center[0])}, ${Math.round(el.center[1])})`
    : el.points?.length
      ? `${el.points.length} pts`
      : '';

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs"
      style={{ borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
      <span className="w-4 flex items-center justify-center shrink-0" style={{ color: lc }}>
        <ElementIcon type={el.type}/>
      </span>
      <span className="text-gray-400 capitalize w-16 shrink-0">{typeLabel}</span>
      <span className="text-gray-700 font-mono text-xs flex-1 truncate">{coords}</span>
      {el.label?.value && (
        <span className="text-xs px-1.5 py-0.5 rounded font-mono truncate max-w-[80px]"
          style={{ background: hexToRgba(lc, 0.15), color: lc, border:`1px solid ${hexToRgba(lc, 0.3)}`}}>
          {el.label.value}
        </span>
      )}
    </div>
  );
}

// Annotation rename modal
function RenameModal({ ann, onSave, onClose }) {
  const [name, setName] = useState(ann.annotation?.name || '');
  const [desc, setDesc] = useState(ann.annotation?.description || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAnnotation(ann._id, { ...ann.annotation, name, description: desc });
      onSave(name, desc);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background:'rgba(0,0,0,0.7)', backdropFilter:'blur(6px)' }}>
      <div className="rounded-xl w-80 mx-4" style={{ background:'#13151f', border:'1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
          <span className="text-sm font-semibold text-white">Edit Annotation</span>
          <button onClick={onClose} className="text-gray-600 hover:text-white">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="login-input text-xs w-full" placeholder="Annotation name"
              onKeyDown={e => e.key === 'Enter' && handleSave()}/>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Description</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2}
              className="login-input text-xs w-full resize-none" placeholder="Optional description"/>
          </div>
        </div>
        <div className="px-4 py-3 flex gap-2 justify-end" style={{ borderTop:'1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={onClose} className="btn-ghost text-xs px-3">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="text-xs px-3 py-1.5 rounded transition-all"
            style={{ background:'rgba(77,166,255,0.15)', color:'#4da6ff', border:'1px solid rgba(77,166,255,0.3)' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single foldable annotation row ────────────────────────────────────────────
function AnnotationRow({ ann, idx, onDelete, onSelect, isSelected, isVisible, onToggleVisibility }) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [localName, setLocalName] = useState(ann.annotation?.name || `Annotation ${idx + 1}`);
  const [localDesc, setLocalDesc] = useState(ann.annotation?.description || '');
  const [fullElements, setFullElements] = useState(null);
  const [loadingEl, setLoadingEl] = useState(false);

  const annColor = ANN_COLORS[idx % ANN_COLORS.length];
  const elements = fullElements || ann.annotation?.elements || [];
  const elCount  = ann.annotation?.elementCount ?? elements.length;

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !fullElements) {
      setLoadingEl(true);
      try {
        const full = await getAnnotationFull(ann._id);
        setFullElements(full.annotation?.elements || []);
      } catch(e) { console.error(e); }
      setLoadingEl(false);
    }
  };

  const handleRename = (name, desc) => {
    setLocalName(name);
    setLocalDesc(desc);
    setRenaming(false);
  };

  return (
    <>
      {renaming && <RenameModal ann={{ ...ann, annotation: { ...ann.annotation, name: localName, description: localDesc }}}
        onSave={handleRename} onClose={() => setRenaming(false)}/>}

      <div className="annotation-group" style={{ opacity: isVisible ? 1 : 0.4 }}>
        {/* ── Header row ── */}
        <div
          className={`flex items-center gap-1.5 px-2 py-2 cursor-pointer group transition-colors rounded-lg mx-1 mb-0.5 ${isSelected ? 'selected' : ''}`}
          style={{
            background: isSelected ? hexToRgba(annColor, 0.12) : 'transparent',
            border: isSelected ? `1px solid ${hexToRgba(annColor, 0.25)}` : '1px solid transparent',
          }}
          onClick={() => { onSelect(ann); handleExpand(); }}>

          {/* Chevron */}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2.5"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition:'transform 0.15s', flexShrink:0 }}>
            <polyline points="9 18 15 12 9 6"/>
          </svg>

          {/* Color swatch */}
          <span className="w-3 h-3 rounded-sm shrink-0 ring-1 ring-white/10"
            style={{ background: annColor }}/>

          {/* Name */}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate" style={{ color: isSelected ? annColor : '#d1d5db' }}>
              {localName}
            </div>
            {localDesc && (
              <div className="text-xs text-gray-700 truncate">{localDesc}</div>
            )}
          </div>

          {/* Element count badge */}
          <span className="text-xs px-1.5 py-0.5 rounded font-mono shrink-0"
            style={{ background:'rgba(255,255,255,0.05)', color:'#6b7280' }}>
            {elCount}
          </span>

          {/* Action buttons — visible on hover */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={e => e.stopPropagation()}>

            {/* Visibility toggle */}
            <button title={isVisible ? 'Hide' : 'Show'} className="btn-icon"
              onClick={() => onToggleVisibility(ann._id)}>
              {isVisible
                ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>}
            </button>

            {/* Rename */}
            <button title="Edit name" className="btn-icon" onClick={() => setRenaming(true)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>

            {/* Delete */}
            <button title="Delete annotation" className="btn-icon"
              style={{ color:'#e94560' }}
              onClick={() => onDelete(ann)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Expanded elements list ── */}
        {expanded && (
          <div className="mx-2 mb-2 rounded-lg overflow-hidden"
            style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.06)' }}>
            {loadingEl ? (
              <div className="flex items-center justify-center py-3 gap-2">
                <div className="spinner" style={{ width:12, height:12 }}/>
                <span className="text-xs text-gray-600">Loading elements…</span>
              </div>
            ) : elements.length === 0 ? (
              <div className="text-xs text-gray-700 text-center py-3">No elements</div>
            ) : (
              <>
                {elements.map((el, ei) => (
                  <ElementRow key={ei} el={el} idx={ei} annColor={annColor}/>
                ))}
                <div className="px-3 py-1.5 text-xs text-gray-700 font-mono"
                  style={{ borderTop:'1px solid rgba(255,255,255,0.04)' }}>
                  {elements.length} element{elements.length !== 1 ? 's' : ''} · ID {ann._id.slice(-6)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Drawing controls bar ───────────────────────────────────────────────────────
function DrawingControls() {
  const { drawingMode, setDrawingMode, drawColor, setDrawColor, drawLabel, setDrawLabel, drawGroup, setDrawGroup } = useStore();
  const [showSettings, setShowSettings] = useState(false);

  const tools = [
    { mode:'point',     icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>,            tip:'Point' },
    { mode:'rectangle', icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1.5"/></svg>, tip:'Rectangle' },
    { mode:'polygon',   icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 22 9 18 21 6 21 2 9"/></svg>,         tip:'Polygon' },
    { mode:'polyline',  icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 17 9 11 13 15 21 7"/></svg>,           tip:'Polyline' },
    { mode:'ellipse',   icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="10" ry="6"/></svg>,          tip:'Ellipse' },
  ];

  return (
    <div className="px-2 py-2 space-y-2" style={{ borderBottom:'1px solid var(--border)' }}>
      {/* Tool buttons */}
      <div className="flex items-center gap-1 flex-wrap">
        <button
          className={`tool-btn text-xs ${!drawingMode ? 'active' : ''}`}
          title="Pan (Esc)"
          onClick={() => setDrawingMode(null)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/>
            <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
          </svg>
        </button>
        {tools.map(t => (
          <button key={t.mode}
            className={`tool-btn text-xs ${drawingMode === t.mode ? 'active' : ''}`}
            title={t.tip + (t.mode === 'polygon' || t.mode === 'polyline' ? ' (dbl-click to finish)' : '')}
            style={drawingMode === t.mode ? { background: hexToRgba(drawColor || '#4da6ff', 0.2), color: drawColor || '#4da6ff', borderColor: hexToRgba(drawColor || '#4da6ff', 0.4) } : {}}
            onClick={() => setDrawingMode(drawingMode === t.mode ? null : t.mode)}>
            {t.icon}
          </button>
        ))}
        {/* Settings toggle */}
        <button className={`tool-btn ml-auto ${showSettings ? 'active' : ''}`}
          title="Drawing settings" onClick={() => setShowSettings(s => !s)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
          </svg>
        </button>
      </div>

      {/* Drawing settings */}
      {showSettings && (
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-10 shrink-0">Color</span>
            <div className="flex items-center gap-1 flex-wrap">
              {DRAW_COLORS.map(c => (
                <button key={c} onClick={() => setDrawColor(c)}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                  style={{ background:c, outline: drawColor === c ? `2px solid white` : 'none', outlineOffset:1 }}/>
              ))}
              <input type="color" value={drawColor || '#4da6ff'} onChange={e => setDrawColor(e.target.value)}
                className="w-5 h-5 rounded cursor-pointer border-0 p-0"
                style={{ background:'transparent' }} title="Custom color"/>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-10 shrink-0">Label</span>
            <input value={drawLabel || ''} onChange={e => setDrawLabel(e.target.value)}
              placeholder="Optional label…" maxLength={64}
              className="flex-1 text-xs rounded px-2 py-1 outline-none"
              style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.08)', color:'#d1d5db' }}/>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-10 shrink-0">Group</span>
            <input value={drawGroup || ''} onChange={e => setDrawGroup(e.target.value)}
              placeholder="e.g. Tumor, Stroma…" maxLength={64}
              className="flex-1 text-xs rounded px-2 py-1 outline-none"
              style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.08)', color:'#d1d5db' }}/>
          </div>
        </div>
      )}

      {/* Active mode indicator */}
      {drawingMode && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
          style={{ background: hexToRgba(drawColor || '#4da6ff', 0.1), border:`1px solid ${hexToRgba(drawColor || '#4da6ff', 0.2)}` }}>
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: drawColor || '#4da6ff' }}/>
          <span style={{ color: drawColor || '#4da6ff' }}>Drawing: <strong>{drawingMode}</strong></span>
          <span className="text-gray-600 flex-1">
            {(drawingMode === 'polygon' || drawingMode === 'polyline') ? '· dbl-click to finish' : '· drag to draw'}
          </span>
          <button onClick={() => setDrawingMode(null)} className="text-gray-500 hover:text-white" title="Cancel (Esc)">✕</button>
        </div>
      )}
    </div>
  );
}

// ── Main AnnotationsPanel ─────────────────────────────────────────────────────
export default function AnnotationsPanel() {
  const {
    activeItem, annotations, setAnnotations,
    visibleAnnotations, toggleAnnotationVisibility,
    showAllAnnotations, hideAllAnnotations,
    selectedAnnotation, setSelectedAnnotation,
  } = useStore();
  const qc = useQueryClient();

  // Fetch annotation list (headers only — elements may be truncated)
  const { isLoading, isError } = useQuery({
    queryKey: ['annotations', activeItem?._id],
    queryFn: async () => {
      const list = await getAnnotationList(activeItem._id);
      // For each annotation with few elements, the list already includes them.
      // For large ones, elements will be loaded on expand.
      return list;
    },
    enabled: !!activeItem?._id,
    refetchOnWindowFocus: false,
    onSuccess: setAnnotations,
  });

  // TanStack v5 compat — onSuccess was removed; use useEffect instead
  const { data: annData } = useQuery({
    queryKey: ['annotations', activeItem?._id],
    queryFn: () => getAnnotationList(activeItem._id),
    enabled: !!activeItem?._id,
    refetchOnWindowFocus: false,
  });
  useEffect(() => { if (annData) setAnnotations(annData); }, [annData, setAnnotations]);

  const handleDelete = async (ann) => {
    if (!confirm(`Delete "${ann.annotation?.name || 'this annotation'}"?\nThis cannot be undone.`)) return;
    try {
      await deleteAnnotation(ann._id);
      qc.invalidateQueries({ queryKey: ['annotations', activeItem?._id] });
    } catch(e) { alert('Delete failed: ' + (e?.response?.data?.message || e.message)); }
  };

  if (!activeItem) return (
    <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2a3050" strokeWidth="1.5">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      <span className="text-xs text-gray-700">Select a slide first</span>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Drawing controls */}
      <DrawingControls/>

      {/* List header */}
      <div className="flex items-center px-3 py-1.5 shrink-0" style={{ borderBottom:'1px solid var(--border)' }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2" className="mr-1.5">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        <span className="text-xs font-semibold text-gray-300">Annotations</span>
        <span className="ml-1.5 text-xs text-gray-600 font-mono">({annotations.length})</span>

        <div className="ml-auto flex items-center gap-1">
          {annotations.length > 0 && (
            <>
              <button className="btn-icon" title="Show all" onClick={showAllAnnotations}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <button className="btn-icon" title="Hide all" onClick={hideAllAnnotations}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              </button>
            </>
          )}
          <button className="btn-icon" title="Refresh"
            onClick={() => qc.invalidateQueries({ queryKey: ['annotations', activeItem?._id] })}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Annotation list */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8 gap-2">
            <div className="spinner" style={{ width:16, height:16 }}/>
            <span className="text-xs text-gray-600">Loading annotations…</span>
          </div>
        )}

        {isError && (
          <div className="text-xs text-red-400 text-center py-4 px-3">
            Failed to load annotations.
            <button className="block mx-auto mt-1 underline" onClick={() => qc.invalidateQueries({ queryKey: ['annotations', activeItem?._id] })}>
              Retry
            </button>
          </div>
        )}

        {!isLoading && !isError && annotations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2 px-4 text-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2a3050" strokeWidth="1.5">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            <p className="text-xs text-gray-600">No annotations yet</p>
            <p className="text-xs text-gray-700">Select a drawing tool above to create one</p>
          </div>
        )}

        {!isLoading && annotations.map((ann, idx) => (
          <AnnotationRow
            key={ann._id}
            ann={ann}
            idx={idx}
            isSelected={selectedAnnotation?._id === ann._id}
            isVisible={visibleAnnotations[ann._id] !== false}
            onSelect={setSelectedAnnotation}
            onToggleVisibility={toggleAnnotationVisibility}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
