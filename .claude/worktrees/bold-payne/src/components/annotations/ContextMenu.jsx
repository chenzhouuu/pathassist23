// src/components/annotations/ContextMenu.jsx
// Right-click context menu for annotation canvas
import React, { useEffect, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { useQueryClient } from '@tanstack/react-query';
import { deleteAnnotation } from '../../api/index.js';

function MenuItem({ icon, label, onClick, danger, disabled, hint }) {
  return (
    <button
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-left transition-colors rounded-md"
      style={{
        color: disabled ? 'var(--muted)' : danger ? '#e94560' : 'var(--text)',
        cursor: disabled ? 'default' : 'pointer',
        background: 'transparent',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = danger ? 'rgba(233,69,96,0.12)' : 'var(--highlight)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span className="shrink-0 w-4 flex items-center justify-center" style={{ color: disabled ? 'var(--muted)' : danger ? '#e94560' : 'var(--muted)' }}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs ml-auto shrink-0" style={{ color:'var(--muted)' }}>{hint}</span>}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />;
}

export default function ContextMenu({ x, y, ann, viewer, onClose, onAnnotateNuclei }) {
  const menuRef = useRef(null);
  const qc = useQueryClient();
  const { activeItem, setSelectedAnnotation, annotations } = useStore();

  // Reposition if near viewport edge
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > vw - 8) left = vw - rect.width - 8;
    if (top + rect.height > vh - 8) top = vh - rect.height - 8;
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
  }, [x, y]);

  // Close on Escape or click outside
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const handleCenterView = () => {
    onClose();
    const osd = viewer.current;
    if (!osd || !ann) return;
    const elements = ann.annotation?.elements ?? [];
    if (!elements.length) return;
    const el = elements[0];
    let imgX, imgY;
    if (el.center) {
      const c = el.center;
      imgX = Array.isArray(c) ? c[0] : c.x ?? 0;
      imgY = Array.isArray(c) ? c[1] : c.y ?? 0;
    } else if (el.points?.length) {
      const pts = el.points;
      imgX = pts.reduce((s, p) => s + (Array.isArray(p) ? p[0] : p.x ?? 0), 0) / pts.length;
      imgY = pts.reduce((s, p) => s + (Array.isArray(p) ? p[1] : p.y ?? 0), 0) / pts.length;
    } else return;
    try {
      const vp = osd.viewport.imageToViewportCoordinates(
        new window.OpenSeadragon.Point(imgX, imgY)
      );
      osd.viewport.panTo(vp, false);
    } catch (_) {}
  };

  const handleSelect = () => {
    onClose();
    setSelectedAnnotation(ann);
  };

  const handleDelete = async () => {
    if (!ann) return;
    if (!confirm(`Delete "${ann.annotation?.name || 'this annotation'}"?\nThis cannot be undone.`)) return;
    onClose();
    try {
      await deleteAnnotation(ann._id);
      qc.invalidateQueries({ queryKey: ['annotations', activeItem?._id] });
    } catch (e) { alert('Delete failed: ' + (e?.response?.data?.message || e.message)); }
  };

  const annName = ann?.annotation?.name;
  const elCount = ann?.elementCount ?? ann?.annotation?.elements?.length ?? 0;

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: x, top: y,
        zIndex: 1000,
        minWidth: 200,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '4px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Header: annotation info or empty-space label */}
      <div className="px-3 py-2 text-xs" style={{ borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        {ann ? (
          <>
            <div className="font-semibold truncate max-w-[170px]" style={{ color: 'var(--text)' }}>{annName || 'Annotation'}</div>
            <div className="mt-0.5" style={{ color: 'var(--muted)' }}>{elCount} element{elCount !== 1 ? 's' : ''}</div>
          </>
        ) : (
          <div className="italic" style={{ color: 'var(--muted)' }}>No annotation at cursor</div>
        )}
      </div>

      {/* Actions when an annotation is under the cursor */}
      {ann && (
        <>
          <MenuItem
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8-10-8-10-8z"/></svg>}
            label="Center in view"
            onClick={handleCenterView}
          />
          <MenuItem
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>}
            label="Select annotation"
            hint="highlight"
            onClick={handleSelect}
          />
          <Divider />
          <MenuItem
            icon={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="4"/><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/>
                <circle cx="5" cy="8" r="1" fill="currentColor"/><circle cx="19" cy="8" r="1" fill="currentColor"/>
                <circle cx="5" cy="16" r="1" fill="currentColor"/><circle cx="19" cy="16" r="1" fill="currentColor"/>
              </svg>
            }
            label="Annotate Nuclei"
            hint="Slicer CLI"
            onClick={() => { onAnnotateNuclei(ann); }}
          />
          <Divider />
          <MenuItem
            danger
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>}
            label="Delete annotation"
            onClick={handleDelete}
          />
        </>
      )}

      {/* Always: dismiss */}
      {ann && <Divider />}
      <MenuItem
        icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
        label="Dismiss"
        hint="Esc"
        onClick={onClose}
      />
    </div>
  );
}
