// src/components/viewer/MagnificationBar.jsx
import React from 'react';

const MAG_LEVELS = [0.5, 1, 2.5, 5, 10, 20, 40, 60];

export default function MagnificationBar({ viewer, tilesInfo }) {
  const maxMag = tilesInfo?.magnification || 40;
  const maxZoom = tilesInfo?.levels ? Math.pow(2, tilesInfo.levels - 1) : 1;

  const goToMag = (mag) => {
    const v = viewer.current;
    if (!v || !tilesInfo) return;
    // Compute what fraction of the full image this magnification represents
    const fraction = mag / maxMag;
    try {
      // imageToViewportZoom converts a zoom relative to image pixels to OSD viewport zoom
      const vpZoom = v.viewport.imageToViewportZoom(fraction * maxMag);
      v.viewport.zoomTo(vpZoom, null, false);
    } catch (_) {
      // Fallback: set zoom as image fraction directly
      const currentMax = v.viewport.getMaxZoom();
      v.viewport.zoomTo(fraction * currentMax);
    }
  };

  return (
    <div
      className="flex items-center gap-1 px-3 shrink-0"
      style={{ height:'30px', background:'var(--bg-toolbar)', borderTop:'1px solid var(--border)' }}
    >
      <span className="text-xs text-gray-600 mr-1 font-mono">Mag:</span>
      {MAG_LEVELS.filter(m => m <= maxMag * 1.1).map(mag => (
        <button key={mag} className="mag-btn" onClick={() => goToMag(mag)} title={`${mag}× magnification`}>
          {mag}×
        </button>
      ))}
      {tilesInfo && (
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-600 font-mono">
          <span>{tilesInfo.sizeX?.toLocaleString()} × {tilesInfo.sizeY?.toLocaleString()} px</span>
          <span style={{ color:'var(--border)' }}>|</span>
          <span>{tilesInfo.levels} levels</span>
          {tilesInfo.mm_x && (
            <span style={{ color:'var(--border)' }}>| {(tilesInfo.mm_x*1000).toFixed(3)} μm/px</span>
          )}
        </div>
      )}
    </div>
  );
}
