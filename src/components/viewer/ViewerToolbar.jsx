// src/components/viewer/ViewerToolbar.jsx
import React from 'react';
import { useStore } from '../../store/index.js';

const ToolBtn = ({ title, active, onClick, children }) => (
  <button
    className={`tool-btn ${active ? 'active' : ''}`}
    onClick={onClick}
    title={title}
  >
    {children}
  </button>
);

export default function ViewerToolbar({ viewer }) {
  const { drawingMode, setDrawingMode, activeItem } = useStore();

  const zoomIn = () => viewer.current?.viewport?.zoomBy(1.4);
  const zoomOut = () => viewer.current?.viewport?.zoomBy(1 / 1.4);
  const zoomHome = () => viewer.current?.viewport?.goHome();
  const zoomFull = () => {
    const v = viewer.current;
    if (!v) return;
    v.setFullScreen(!v.isFullPage());
  };

  const toggleDraw = (mode) => setDrawingMode(drawingMode === mode ? null : mode);

  const snapshot = () => {
    const canvas = document.querySelector('#osd-viewer canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `slide-snapshot-${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
  };

  return (
    <div className="viewer-toolbar">
      {/* Zoom */}
      <ToolBtn title="Zoom in (+)" onClick={zoomIn}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v6M8 11h6" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Zoom out (-)" onClick={zoomOut}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M8 11h6" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Fit to window" onClick={zoomHome}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Fullscreen" onClick={zoomFull}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </ToolBtn>

      <div className="divider" />

      {/* Drawing tools */}
      <ToolBtn title="Pan mode" active={!drawingMode} onClick={() => setDrawingMode(null)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
          <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
          <path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Draw point" active={drawingMode === 'point'} onClick={() => toggleDraw('point')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
          <circle cx="12" cy="12" r="4" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Draw rectangle" active={drawingMode === 'rectangle'} onClick={() => toggleDraw('rectangle')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Draw polygon" active={drawingMode === 'polygon'} onClick={() => toggleDraw('polygon')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Draw line" active={drawingMode === 'polyline'} onClick={() => toggleDraw('polyline')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 17 9 11 13 15 21 7" />
        </svg>
      </ToolBtn>
      <ToolBtn title="Draw ellipse" active={drawingMode === 'ellipse'} onClick={() => toggleDraw('ellipse')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <ellipse cx="12" cy="12" rx="10" ry="6" />
        </svg>
      </ToolBtn>

      <div className="divider" />

      {/* Utility */}
      <ToolBtn title="Snapshot" onClick={snapshot}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </ToolBtn>

      <div className="flex-1" />

      {/* Drawing mode indicator */}
      {drawingMode && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
          style={{ background: 'rgba(77,166,255,0.1)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.2)' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          Drawing: {drawingMode}
          <button onClick={() => setDrawingMode(null)} className="ml-1 opacity-60 hover:opacity-100">×</button>
        </div>
      )}
    </div>
  );
}
