// src/components/viewer/HeatmapOverlay.jsx
// The downstream task's per-patch evidence map (Inc 2c), painted over OpenSeadragon.
//
// The technique matters as much as the picture: the scores are baked ONCE into an offscreen canvas
// at one pixel per patch, then drawn scaled with `multiply` blending. Redraw cost is therefore
// independent of patch count (a 40k-patch slide costs the same as a 2k one), the browser's own
// scaling interpolation supplies the smoothness, and because the ramp's midpoint is near-white —
// multiply-neutral — tissue without evidence keeps its own colour and the histology still reads
// through the tint. That is what the CLAM demo's right-hand pane looks like.
//
// Mirrors TissueOverlay's lifecycle: a <canvas> pinned over OSD, re-projected on every viewport
// event, driven entirely by store state.
import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { imgToViewer } from '../annotations/annotationUtils.js';
import { colormap, normaliseEvidence, gridExtent } from '../panels/taskUtils.js';

// Bake the per-patch scores into a cols×rows canvas — one pixel per patch, in level-0 order.
// Cells with no patch stay white rather than transparent: under `multiply` both are no-ops, but
// white avoids alpha haloes when the browser interpolates during the scale-up.
function bakeGrid(doc) {
  const patchPx = Number(doc?.patch_px) || 0;
  const grid = gridExtent(doc?.coords, patchPx);
  if (!grid || typeof document === 'undefined') return null;

  const { x0, y0, cols, rows } = grid;
  const cv = document.createElement('canvas');
  cv.width = cols;
  cv.height = rows;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  img.data.fill(255);                                   // white + opaque everywhere

  const scores = normaliseEvidence(doc.evidence);
  const coords = doc.coords || [];
  for (let i = 0; i < scores.length; i++) {
    const x = Number(coords[i * 2]);
    const y = Number(coords[i * 2 + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const gx = Math.round((x - x0) / patchPx);
    const gy = Math.round((y - y0) / patchPx);
    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
    const [r, g, b] = colormap(scores[i]);
    const o = (gy * cols + gx) * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: cv, x0, y0, w: cols * patchPx, h: rows * patchPx };
}

export default function HeatmapOverlay({ viewer, alpha }) {
  const canvasRef = useRef(null);
  const taskHeatmap = useStore((s) => s.taskHeatmap);
  const taskOpacity = useStore((s) => s.taskOpacity);
  const opacity = alpha != null ? alpha : taskOpacity;

  // Re-bake only when the prediction changes — not on pan, zoom or an opacity drag.
  const baked = useMemo(() => (taskHeatmap ? bakeGrid(taskHeatmap) : null), [taskHeatmap]);

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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!baked || !(opacity > 0)) return;

    // Three corners of the grid rect give the full affine (scale + any viewer rotation), so the
    // map stays registered to the tissue however the viewport is oriented.
    const { x0, y0, w, h } = baked;
    const tl = imgToViewer(osd, x0, y0);
    const tr = imgToViewer(osd, x0 + w, y0);
    const bl = imgToViewer(osd, x0, y0 + h);
    const a = (tr.x - tl.x) / w;
    const b = (tr.y - tl.y) / w;
    const c = (bl.x - tl.x) / h;
    const d = (bl.y - tl.y) / h;
    if (![a, b, c, d, tl.x, tl.y].every(Number.isFinite) || (a === 0 && b === 0)) return;

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(a, b, c, d, tl.x, tl.y);
    ctx.drawImage(baked.canvas, 0, 0, w, h);            // ← the whole technique, one call
    ctx.restore();
  }, [viewer, baked, opacity]);

  useEffect(() => {
    const osd = viewer.current;
    if (!osd) return undefined;
    const onEvent = () => render();
    osd.addHandler('animation', onEvent);
    osd.addHandler('open', onEvent);
    osd.addHandler('resize', onEvent);
    window.addEventListener('resize', onEvent);
    render();
    return () => {
      try {
        osd.removeHandler('animation', onEvent);
        osd.removeHandler('open', onEvent);
        osd.removeHandler('resize', onEvent);
      } catch { /* viewer already destroyed */ }
      window.removeEventListener('resize', onEvent);
    };
  }, [viewer, render]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 6 }}
    />
  );
}
