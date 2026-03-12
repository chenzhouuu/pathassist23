// src/components/viewer/ViewerToolbar.jsx
import React, { useState } from 'react';
import { useStore } from '../../store/index.js';
import { hexToRgba } from '../annotations/annotationUtils.js';
import ImageFilters from './ImageFilters.jsx';
import { getFolders, createFolder, uploadCaptureToFolder } from '../../api/index.js';

const ToolBtn = ({ title, active, onClick, children, color }) => (
  <button
    className={`tool-btn ${active ? 'active' : ''}`}
    onClick={onClick}
    title={title}
    style={active && color ? {
      background: hexToRgba(color, 0.2),
      color: color,
      borderColor: hexToRgba(color, 0.4),
    } : {}}>
    {children}
  </button>
);

export default function ViewerToolbar({ viewer }) {
  const { drawingMode, setDrawingMode, drawColor, setRightPanelTab, setRightPanelOpen, activeItem, user } = useStore();
  const [savingCapture, setSavingCapture] = useState(false);

  const zoom = (factor) => viewer.current?.viewport?.zoomBy(factor);
  const home = () => viewer.current?.viewport?.goHome();
  const full = () => { const v = viewer.current; v && v.setFullScreen(!v.isFullPage()); };

  const toggleDraw = (mode) => {
    if (drawingMode === mode) {
      setDrawingMode(null);
    } else {
      setDrawingMode(mode);
      // Auto-open annotations panel
      setRightPanelOpen(true);
      setRightPanelTab('annotations');
    }
  };

  const snapshot = () => {
    const canvas = document.querySelector('#osd-viewer canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.download = `slide-${Date.now()}.png`;
    a.href = canvas.toDataURL();
    a.click();
  };

  const ensureCapturesFolder = async () => {
    if (!activeItem?.folderId) throw new Error('No source folder available');
    const folders = await getFolders('folder', activeItem.folderId);
    const existing = (folders || []).find((f) => (f.name || '').toLowerCase() === 'captures');
    if (existing) return existing;
    return createFolder('folder', activeItem.folderId, 'Captures');
  };

  const snapshotToServer = async () => {
    if (savingCapture) return;
    const canvas = document.querySelector('#osd-viewer canvas');
    if (!canvas || !activeItem) return;
    setSavingCapture(true);
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Failed to capture screenshot');
      const capturesFolder = await ensureCapturesFolder();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeItem = (activeItem.name || 'slide').replace(/[^\w.-]+/g, '_');
      const filename = `${safeItem}__capture__${ts}.png`;
      await uploadCaptureToFolder(capturesFolder._id, blob, filename, {
        sourceItemId: activeItem._id,
        sourceItemName: activeItem.name || '',
        sourceFolderId: activeItem.folderId || '',
        capturedAt: new Date().toISOString(),
        capturedBy: user?.login || user?.firstName || 'unknown',
      });
      window.alert('Capture saved to server folder: Captures');
    } catch (e) {
      window.alert(`Failed to save capture: ${e?.message || 'Unknown error'}`);
    } finally {
      setSavingCapture(false);
    }
  };

  const activeColor = drawColor || '#4da6ff';

  return (
    <div className="viewer-toolbar">
      {/* Navigation */}
      <ToolBtn title="Zoom in [+]" onClick={() => zoom(1.5)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
      </ToolBtn>
      <ToolBtn title="Zoom out [-]" onClick={() => zoom(1/1.5)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
      </ToolBtn>
      <ToolBtn title="Fit to window [H]" onClick={home}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      </ToolBtn>
      <button
        title="Fullscreen [F]"
        onClick={full}
        className="tool-btn"
        style={{ background: 'rgba(77,166,255,0.12)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.25)', borderRadius: 6 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
        </svg>
      </button>

      <div className="divider"/>

      {/* Pan */}
      <ToolBtn title="Pan mode [Esc]" active={!drawingMode} onClick={() => setDrawingMode(null)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/>
          <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/>
          <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/>
          <path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
        </svg>
      </ToolBtn>

      <div className="divider"/>

      {/* Image filters */}
      <ImageFilters viewer={viewer}/>

      <div className="divider"/>

      {/* Drawing tools */}
      <ToolBtn title="Point" active={drawingMode === 'point'} color={activeColor} onClick={() => toggleDraw('point')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>
      </ToolBtn>
      <ToolBtn title="Rectangle (drag)" active={drawingMode === 'rectangle'} color={activeColor} onClick={() => toggleDraw('rectangle')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <rect x="3" y="3" width="18" height="18" rx="1.5"/>
        </svg>
      </ToolBtn>
      <ToolBtn title="Polygon (click pts, dbl-click finish)" active={drawingMode === 'polygon'} color={activeColor} onClick={() => toggleDraw('polygon')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="12 2 22 9 18 21 6 21 2 9"/>
        </svg>
      </ToolBtn>
      <ToolBtn title="Polyline (click pts, dbl-click finish)" active={drawingMode === 'polyline'} color={activeColor} onClick={() => toggleDraw('polyline')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 17 9 11 13 15 21 7"/>
        </svg>
      </ToolBtn>
      <ToolBtn title="Ellipse (drag)" active={drawingMode === 'ellipse'} color={activeColor} onClick={() => toggleDraw('ellipse')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <ellipse cx="12" cy="12" rx="10" ry="6"/>
        </svg>
      </ToolBtn>

      {/* Color preview dot */}
      {drawingMode && drawingMode !== 'measure' && (
        <div className="w-4 h-4 rounded-full ml-1 ring-1 ring-white/20 shrink-0"
          style={{ background: activeColor }}/>
      )}

      <div className="divider"/>

      {/* Measure tool */}
      <ToolBtn title="Measure distance [M]" active={drawingMode === 'measure'} onClick={() => toggleDraw('measure')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="2" y1="12" x2="22" y2="12"/>
          <line x1="2" y1="8" x2="2" y2="16"/>
          <line x1="22" y1="8" x2="22" y2="16"/>
          <line x1="8" y1="10" x2="8" y2="14"/>
          <line x1="14" y1="10" x2="14" y2="14"/>
        </svg>
      </ToolBtn>

      <div className="divider"/>

      {/* Snapshot */}
      <ToolBtn title="Screenshot (Local)" onClick={snapshot}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
      </ToolBtn>
      <ToolBtn title={savingCapture ? 'Saving capture to server...' : 'Camera Save to Server'} onClick={snapshotToServer}>
        {savingCapture ? (
          <div className="spinner" style={{ width: 12, height: 12 }}/>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
            <path d="M6 20.5h12"/>
            <rect x="8" y="21" width="8" height="2" rx="0.6"/>
          </svg>
        )}
      </ToolBtn>

      <div className="flex-1"/>

      {/* Active mode status */}
      {drawingMode && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
          style={{ background: hexToRgba(activeColor, 0.12), color: activeColor, border:`1px solid ${hexToRgba(activeColor, 0.3)}` }}>
          <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: activeColor }}/>
          {drawingMode}
          <span className="text-gray-600">
            {(drawingMode === 'polygon' || drawingMode === 'polyline') ? '• dbl-click to finish' : ''}
          </span>
          <button onClick={() => setDrawingMode(null)} className="ml-0.5 opacity-50 hover:opacity-100 text-sm leading-none">×</button>
        </div>
      )}
    </div>
  );
}
