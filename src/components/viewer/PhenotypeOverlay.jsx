// src/components/viewer/PhenotypeOverlay.jsx
// Copilot cell-phenotype overlay (Inc 3a). Paints each phenotyped nucleus as a dot coloured by its
// LINEAGE (Tumour, Cytotoxic T, Macrophage, ...), mirroring NucleiOverlay's canvas/projection
// lifecycle, and adds a hover tooltip showing that cell's phenotype, functional flags and its
// gate-deciding marker-positivity probabilities (region-relative predictions, not intensities).
// Driven by the store's copilotPhenotypes + showPhenotypeOverlay.
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useStore } from '../../store/index.js';
import { imgToViewer } from '../annotations/annotationUtils.js';
import { colorForPhenotype, presentPhenotypes } from './phenotypeColors.js';
import {
  phenotypeCounts, flagCounts, legendLabel, cellTooltip, nearestCell,
} from './phenotypeUtils.js';

export default function PhenotypeOverlay({ viewer }) {
  const canvasRef = useRef(null);
  const pheno = useStore((s) => s.copilotPhenotypes);
  const show = useStore((s) => s.showPhenotypeOverlay);
  const [hover, setHover] = useState(null); // { sx, sy, cell }

  const points = (show && pheno?.points) || [];
  const classes = pheno?.classes;
  const cells = pheno?.cells;

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
    if (!show || !pheno) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(8, 51, 68, 0.9)';
    ctx.lineWidth = 0.75;
    for (let i = 0; i < points.length; i++) {
      const p = imgToViewer(osd, points[i][0], points[i][1]);
      if (p.x < -8 || p.y < -8 || p.x > canvas.width + 8 || p.y > canvas.height + 8) continue;
      ctx.fillStyle = colorForPhenotype(classes?.[i] ?? null);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }, [viewer, pheno, show, points, classes]);

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

  // Hover hit-testing on the OSD container (read-only mousemove; OSD keeps pan/zoom).
  useEffect(() => {
    const osd = viewer.current;
    const el = osd?.element;
    if (!el || !show || !cells) return undefined;
    const onMove = (ev) => {
      const rect = el.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const project = (i) => imgToViewer(osd, points[i][0], points[i][1]);
      const idx = nearestCell(points, project, sx, sy);
      setHover(idx >= 0 ? { sx, sy, cell: cells[idx] } : null);
    };
    const onLeave = () => setHover(null);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [viewer, show, cells, points]);

  const present = (show && pheno) ? presentPhenotypes(pheno) : [];
  const counts = (show && pheno) ? phenotypeCounts(pheno) : {};
  const flags = (show && pheno) ? flagCounts(pheno) : {};
  const flagLine = Object.keys(flags)
    .sort((a, b) => flags[b] - flags[a])
    .map((f) => `${flags[f]} ${f}`)
    .join(' · ');

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%', zIndex: 4, pointerEvents: 'none',
        }}
      />
      {present.length > 0 && (
        <div
          style={{
            position: 'absolute', bottom: 12, left: 12, zIndex: 5, pointerEvents: 'none',
            background: 'rgba(15,23,42,0.72)', color: '#e2e8f0', borderRadius: 6,
            padding: '6px 8px', font: '11px/1.4 system-ui, sans-serif', maxWidth: 220,
          }}
        >
          {present.map((name) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: colorForPhenotype(name), border: '1px solid rgba(8,51,68,0.9)',
              }} />
              {legendLabel(name, counts)}
            </div>
          ))}
          {flagLine && (
            <div style={{ marginTop: 4, opacity: 0.8, borderTop: '1px solid rgba(148,163,184,0.3)',
                          paddingTop: 4 }}>
              {flagLine}
            </div>
          )}
          <div style={{ marginTop: 4, opacity: 0.6, fontSize: 10 }}>
            predicted · relative to region
          </div>
        </div>
      )}
      {hover && (
        <div
          style={{
            position: 'absolute', left: Math.min(hover.sx + 12, 9999), top: hover.sy + 12,
            zIndex: 6, pointerEvents: 'none', background: 'rgba(15,23,42,0.92)', color: '#f1f5f9',
            borderRadius: 5, padding: '4px 7px', font: '11px/1.4 system-ui, sans-serif',
            maxWidth: 260, whiteSpace: 'nowrap',
          }}
        >
          {cellTooltip(hover.cell)}
        </div>
      )}
    </>
  );
}
