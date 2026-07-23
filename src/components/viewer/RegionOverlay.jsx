// src/components/viewer/RegionOverlay.jsx
// Copilot region overlay (increment 2c). Paints the regions a describe_region (Perceptor /
// MedGemma) call read as labelled rectangles on the slide, mirroring NucleiOverlay: a <canvas>
// pinned over OSD, re-projected via imgToViewer on every viewport event so the boxes track
// pan/zoom. Non-interactive; driven entirely by the store's copilotRegions + showRegionsOverlay.
// Each region is { bbox:{x,y,width,height} (level-0 px), magnification }. Four corners are
// projected (not two) so the box stays correct under rotation.
import React, { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { imgToViewer } from '../annotations/annotationUtils.js';

const STROKE = '#c084fc';                 // copilot purple — distinct from the cyan nuclei dots
const FILL = 'rgba(192, 132, 252, 0.10)';
const LABEL_BG = 'rgba(88, 28, 135, 0.92)';

export default function RegionOverlay({ viewer }) {
  const canvasRef = useRef(null);
  const copilotRegions = useStore((s) => s.copilotRegions);
  const showRegionsOverlay = useStore((s) => s.showRegionsOverlay);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const osd = viewer.current;
    if (!canvas || !osd?.element) return;
    const el = osd.element;
    if (canvas.width !== el.clientWidth || canvas.height !== el.clientHeight) {
      canvas.width = el.clientWidth;
      canvas.height = el.clientHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showRegionsOverlay || !copilotRegions?.length) return;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = '600 11px system-ui, sans-serif';
    for (const r of copilotRegions) {
      const b = r?.bbox;
      if (!b) continue;
      const corners = [
        imgToViewer(osd, b.x, b.y),
        imgToViewer(osd, b.x + b.width, b.y),
        imgToViewer(osd, b.x + b.width, b.y + b.height),
        imgToViewer(osd, b.x, b.y + b.height),
      ];
      // Cull if the whole box is far off-screen.
      const off = corners.every((p) => p.x < -40 || p.y < -40
        || p.x > canvas.width + 40 || p.y > canvas.height + 40);
      if (off) continue;

      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = FILL;
      ctx.fill();
      ctx.strokeStyle = STROKE;
      ctx.stroke();

      // Label chip at the top-left corner: the magnification the Perceptor actually saw.
      const mag = r.magnification;
      const label = mag ? `MedGemma ${(+mag).toFixed(mag < 1 ? 2 : 0)}×` : 'MedGemma';
      const tw = ctx.measureText(label).width;
      const lx = corners[0].x;
      const ly = corners[0].y;
      ctx.fillStyle = LABEL_BG;
      ctx.fillRect(lx, ly - 18, tw + 12, 17);
      ctx.fillStyle = '#f3e8ff';
      ctx.fillText(label, lx + 6, ly - 5);
    }
    ctx.restore();
  }, [viewer, copilotRegions, showRegionsOverlay]);

  // Re-render on every OSD viewport change so the boxes stay pinned to the tissue.
  useEffect(() => {
    const osd = viewer.current;
    if (!osd) return undefined;
    const events = ['open', 'animation', 'animation-finish', 'pan', 'zoom',
                    'resize', 'rotate', 'update-viewport'];
    events.forEach((e) => osd.addHandler(e, render));
    render();
    return () => {
      events.forEach((e) => { try { osd.removeHandler(e, render); } catch (_) { /* */ } });
    };
  }, [viewer, render]);

  useEffect(() => { render(); }, [render]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', top: 0, left: 0,
        width: '100%', height: '100%', zIndex: 4, pointerEvents: 'none',
      }}
    />
  );
}
