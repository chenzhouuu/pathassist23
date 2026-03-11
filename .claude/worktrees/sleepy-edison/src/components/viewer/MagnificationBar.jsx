// src/components/viewer/MagnificationBar.jsx
import React from 'react';

export default function MagnificationBar({ tilesInfo, zoom }) {
  return (
    <div
      className="flex items-center gap-3 px-3 shrink-0"
      style={{ height: '28px', background: 'var(--bg-toolbar)', borderTop: '1px solid var(--border)' }}
    >
      {/* Live zoom percentage */}
      <div className="flex items-center gap-1.5 text-xs font-mono shrink-0">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ color: 'var(--accent)' }}>
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
          {zoom || '—'}
        </span>
      </div>

      {/* Image resolution info */}
      {tilesInfo && (
        <div className="ml-auto flex items-center gap-2 text-xs font-mono"
          style={{ color: 'var(--muted)' }}>
          <span>{tilesInfo.sizeX?.toLocaleString()} × {tilesInfo.sizeY?.toLocaleString()} px</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>{tilesInfo.levels} levels</span>
          {tilesInfo.mm_x && (
            <>
              <span style={{ color: 'var(--border)' }}>|</span>
              <span>{(tilesInfo.mm_x * 1000).toFixed(3)} μm/px</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
