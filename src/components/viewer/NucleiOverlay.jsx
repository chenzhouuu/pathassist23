// src/components/viewer/NucleiOverlay.jsx
// Copilot nuclei overlay (increment 5). Paints the centroids a plan run produced as dots
// on the slide, mirroring AnnotationCanvas: a <canvas> pinned over OSD, re-projected via
// imgToViewer on every viewport event so the dots track pan/zoom. Non-interactive (below
// the annotation canvas), driven entirely by the store's copilotNuclei + showNucleiOverlay.
import React, { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { imgToViewer } from '../annotations/annotationUtils.js';

export default function NucleiOverlay({ viewer }) {
  const canvasRef = useRef(null);
  const copilotNuclei = useStore((s) => s.copilotNuclei);
  const showNucleiOverlay = useStore((s) => s.showNucleiOverlay);

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
    if (!showNucleiOverlay || !copilotNuclei) return;

    const pts = copilotNuclei.points || [];
    ctx.save();
    ctx.fillStyle = 'rgba(34, 211, 238, 0.85)';    // cyan — distinct from ROI blue
    ctx.strokeStyle = 'rgba(8, 51, 68, 0.9)';
    ctx.lineWidth = 0.75;
    for (let i = 0; i < pts.length; i++) {
      const p = imgToViewer(osd, pts[i][0], pts[i][1]);
      if (p.x < -8 || p.y < -8 || p.x > canvas.width + 8 || p.y > canvas.height + 8) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }, [viewer, copilotNuclei, showNucleiOverlay]);

  // Re-render on every OSD viewport change so the dots stay pinned to the tissue.
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
