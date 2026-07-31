// src/components/viewer/TissueOverlay.jsx
// Tissue segmentation overlay (Inc 2b-3). Paints the tissue contours a Preprocess segmentation
// stage produced as outlined polygons on the slide, mirroring RegionOverlay/NucleiOverlay: a
// <canvas> pinned over OSD, re-projected via imgToViewer on every viewport event so the outlines
// track pan/zoom. Non-interactive; driven entirely by the store's tissueContours + showTissueOverlay.
// Contours are a GeoJSON FeatureCollection of Polygons in level-0 px (Trident contours.geojson).
import React, { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { imgToViewer } from '../annotations/annotationUtils.js';

const STROKE = '#34d399';                 // tissue green — distinct from copilot purple / nuclei cyan
const FILL = 'rgba(52, 211, 153, 0.08)';

// Each GeoJSON Polygon is [outerRing, ...holes]; we outline the outer ring only (holes read as
// background but drawing them adds little for a QC overlay).
function polygonRings(geojson) {
  const rings = [];
  for (const feat of geojson?.features || []) {
    const geom = feat?.geometry;
    if (!geom) continue;
    if (geom.type === 'Polygon') {
      if (geom.coordinates?.[0]) rings.push(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates || []) if (poly?.[0]) rings.push(poly[0]);
    }
  }
  return rings;
}

export default function TissueOverlay({ viewer }) {
  const canvasRef = useRef(null);
  const tissueContours = useStore((s) => s.tissueContours);
  const showTissueOverlay = useStore((s) => s.showTissueOverlay);

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
    if (!showTissueOverlay || !tissueContours) return;

    const rings = polygonRings(tissueContours);
    if (!rings.length) return;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = STROKE;
    ctx.fillStyle = FILL;
    for (const ring of rings) {
      if (ring.length < 2) continue;
      ctx.beginPath();
      let onScreen = false;
      for (let i = 0; i < ring.length; i++) {
        const p = imgToViewer(osd, ring[i][0], ring[i][1]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        if (p.x > -40 && p.y > -40 && p.x < canvas.width + 40 && p.y < canvas.height + 40) {
          onScreen = true;
        }
      }
      if (!onScreen) continue;   // whole contour off-screen → skip fill/stroke
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }, [viewer, tissueContours, showTissueOverlay]);

  // Re-render on every OSD viewport change so the outlines stay pinned to the tissue.
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
        width: '100%', height: '100%', zIndex: 3, pointerEvents: 'none',
      }}
    />
  );
}
