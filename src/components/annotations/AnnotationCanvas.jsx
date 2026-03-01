// src/components/annotations/AnnotationCanvas.jsx
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useQueryClient } from '@tanstack/react-query';
import { createAnnotation } from '../../api/index.js';
import {
  ANN_COLORS, hexToRgba, viewerToImg,
  makePoint, makeRectangle, makePolyline, makeEllipse,
  renderElementOnCanvas, renderDrawingPreview,
  findAnnotationAtViewer,
} from './annotationUtils.js';
import ContextMenu from './ContextMenu.jsx';
import NucleiDetectionModal from './NucleiDetectionModal.jsx';

export default function AnnotationCanvas({ viewer }) {
  const canvasRef = useRef(null);
  const qc = useQueryClient();

  const {
    activeItem,
    drawingMode, setDrawingMode,
    drawColor, drawLineWidth, drawLabel, drawGroup,
    annotations, setAnnotations,
    visibleAnnotations,
    selectedAnnotation,
  } = useStore();

  // mutable draw state (not React state — avoids re-renders on mouse move)
  const ds = useRef({ active: false, points: [], start: null, cursor: null });

  // Context menu + nuclei detection modal state
  const [ctxMenu, setCtxMenu]   = useState(null); // { x, y, ann }
  const [nucleiAnn, setNucleiAnn] = useState(null); // annotation to run nuclei detection on

  // ── Canvas resize ───────────────────────────────────────────────────────────
  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const osd = viewer.current;
    if (!canvas || !osd?.element) return;
    const el = osd.element;
    if (canvas.width !== el.clientWidth || canvas.height !== el.clientHeight) {
      canvas.width  = el.clientWidth;
      canvas.height = el.clientHeight;
    }
  }, [viewer]);

  // ── Full canvas render ──────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const osd = viewer.current;
    if (!canvas || !osd) return;

    syncCanvasSize();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Render saved annotations
    let totalElements = 0;
    annotations.forEach((ann, idx) => {
      if (visibleAnnotations[ann._id] === false) return;
      const fallback = ANN_COLORS[idx % ANN_COLORS.length];
      const isSelected = selectedAnnotation?._id === ann._id;
      const elements = ann.annotation?.elements || [];
      totalElements += elements.length;
      elements.forEach(el => renderElementOnCanvas(ctx, el, fallback, osd, isSelected));
    });
    if (annotations.length > 0) {
      console.debug(`[Canvas] render: ${annotations.length} annotations, ${totalElements} total elements, canvas=${canvas.width}x${canvas.height}`);
    }

    // Render live drawing preview
    if (drawingMode && ds.current.active) {
      renderDrawingPreview(ctx, drawingMode, ds.current, osd, drawColor || ANN_COLORS[0]);
    }
  }, [annotations, visibleAnnotations, selectedAnnotation, drawingMode, drawColor, viewer, syncCanvasSize]);

  // ── Attach OSD events ───────────────────────────────────────────────────────
  useEffect(() => {
    const osd = viewer.current;
    if (!osd) return;
    const events = ['open','animation','animation-finish','pan','zoom','resize','rotate','update-viewport'];
    const onResize = () => { syncCanvasSize(); render(); };
    events.forEach(e => osd.addHandler(e, render));
    osd.addHandler('resize', onResize);
    syncCanvasSize();
    render();
    return () => {
      events.forEach(e => { try { osd.removeHandler(e, render); } catch(_){} });
      try { osd.removeHandler('resize', onResize); } catch(_){}
    };
  }, [viewer.current, render, syncCanvasSize]); // eslint-disable-line

  useEffect(() => { render(); }, [annotations, visibleAnnotations, selectedAnnotation, render]);

  // ── Right-click / context menu ──────────────────────────────────────────────
  // Attach to osd.element so it fires even when canvas has pointerEvents:none
  useEffect(() => {
    const osd = viewer.current;
    if (!osd?.element) return;
    const el = osd.element;
    const handler = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const vx = e.clientX - rect.left, vy = e.clientY - rect.top;
      const ann = findAnnotationAtViewer(annotations, vx, vy, osd);
      setCtxMenu({ x: e.clientX, y: e.clientY, ann });
    };
    el.addEventListener('contextmenu', handler);
    return () => el.removeEventListener('contextmenu', handler);
  }, [viewer.current, annotations]); // eslint-disable-line

  // ── Coordinate helper ───────────────────────────────────────────────────────
  const getImgCoords = useCallback((e) => {
    const canvas = canvasRef.current;
    const osd    = viewer.current;
    if (!canvas || !osd) return null;
    const rect = canvas.getBoundingClientRect();
    const img  = viewerToImg(osd, e.clientX - rect.left, e.clientY - rect.top);
    return [img.x, img.y];
  }, [viewer]);

  // ── Save annotation doc to Girder ───────────────────────────────────────────
  const save = useCallback(async (element) => {
    if (!activeItem) return;
    const name  = drawLabel?.trim() || `${(drawGroup || 'Annotation')} ${new Date().toLocaleTimeString()}`;

    const doc = {
      name,
      description: '',
      attributes: { group: drawGroup || 'default' },
      elements: [element],
    };

    try {
      const created = await createAnnotation(activeItem._id, doc);
      // Immediately add to store so canvas renders without waiting for list refetch.
      // createAnnotation (POST /annotation) returns the full annotation with elements.
      if (created?._id) {
        const current = useStore.getState().annotations;
        setAnnotations([created, ...current.filter(a => a._id !== created._id)]);
      }
      qc.invalidateQueries({ queryKey: ['annotations', activeItem._id] });
    } catch (err) {
      console.error('[AnnotationCanvas] Save failed:', err?.response?.data || err.message);
      alert(`Failed to save annotation: ${err?.response?.data?.message || err.message}`);
    }
  }, [activeItem, drawLabel, drawGroup, setAnnotations, qc]);

  // ── Mouse events ────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    if (!drawingMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const xy = getImgCoords(e);
    if (!xy) return;
    const d = ds.current;

    if (drawingMode === 'rectangle' || drawingMode === 'ellipse') {
      d.active = true;
      d.start  = xy;
      d.cursor = xy;
    } else if (drawingMode === 'polygon' || drawingMode === 'polyline') {
      if (!d.active) {
        d.active = true;
        d.points = [xy];
      } else {
        d.points = [...d.points, xy];
      }
    }
    // point is handled entirely in mouseup
    render();
  }, [drawingMode, getImgCoords, render]);

  const onMouseMove = useCallback((e) => {
    if (!drawingMode) return;
    const xy = getImgCoords(e);
    if (!xy) return;
    ds.current.cursor = xy;
    if (ds.current.active || drawingMode === 'polygon' || drawingMode === 'polyline') {
      render();
    }
  }, [drawingMode, getImgCoords, render]);

  const onMouseUp = useCallback(async (e) => {
    if (!drawingMode || e.button !== 0) return;
    e.preventDefault();
    const xy = getImgCoords(e);
    if (!xy) return;
    const d = ds.current;
    const color = drawColor || ANN_COLORS[0];
    const lw    = drawLineWidth || 2;
    const opts  = {
      lineColor: color,
      lineWidth: lw,
      fillColor: hexToRgba(color, 0.15),
      label: drawLabel,
      group: drawGroup,
    };

    if (drawingMode === 'point') {
      d.active = false;
      await save(makePoint(xy[0], xy[1], opts));

    } else if (drawingMode === 'rectangle' && d.active && d.start) {
      const [sx, sy] = d.start;
      const [ex, ey] = xy;
      d.active = false; d.start = null; d.cursor = null;
      if (Math.abs(ex - sx) < 5 && Math.abs(ey - sy) < 5) { render(); return; }
      await save(makeRectangle(sx, sy, ex, ey, opts));

    } else if (drawingMode === 'ellipse' && d.active && d.start) {
      const [sx, sy] = d.start;
      const [ex, ey] = xy;
      d.active = false; d.start = null; d.cursor = null;
      if (Math.abs(ex - sx) < 5 && Math.abs(ey - sy) < 5) { render(); return; }
      await save(makeEllipse(sx, sy, ex, ey, opts));
    }
    render();
  }, [drawingMode, getImgCoords, drawColor, drawLineWidth, drawLabel, drawGroup, save, render]);

  // Double-click finishes polygon / polyline
  const onDblClick = useCallback(async (e) => {
    if (drawingMode !== 'polygon' && drawingMode !== 'polyline') return;
    e.preventDefault();
    e.stopPropagation();
    const d = ds.current;
    // Remove duplicate point added by the second mousedown of the dblclick
    const pts = d.points.length >= 3 ? d.points.slice(0, -1) : d.points;
    if (pts.length < 2) { d.active = false; d.points = []; render(); return; }
    d.active = false; d.points = [];
    const color = drawColor || ANN_COLORS[0];
    const lw    = drawLineWidth || 2;
    const opts  = {
      lineColor: color,
      lineWidth: lw,
      fillColor: hexToRgba(color, 0.15),
      label: drawLabel,
      group: drawGroup,
    };
    render();
    await save(makePolyline(pts, drawingMode === 'polygon', opts));
  }, [drawingMode, drawColor, drawLineWidth, drawLabel, drawGroup, save, render]);

  // Escape cancels drawing
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        ds.current = { active: false, points: [], start: null, cursor: null };
        setDrawingMode(null);
        render();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setDrawingMode, render]);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%', zIndex: 5,
          pointerEvents: drawingMode ? 'all' : 'none',
          cursor: !drawingMode ? 'default'
            : drawingMode === 'point' ? 'crosshair'
            : (drawingMode === 'rectangle' || drawingMode === 'ellipse')
              ? (ds.current.active ? 'crosshair' : 'cell')
            : 'crosshair',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDblClick}
      />

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          ann={ctxMenu.ann}
          viewer={viewer}
          onClose={() => setCtxMenu(null)}
          onAnnotateNuclei={(ann) => { setCtxMenu(null); setNucleiAnn(ann); }}
        />
      )}

      {nucleiAnn && (
        <NucleiDetectionModal
          ann={nucleiAnn}
          item={activeItem}
          onClose={() => setNucleiAnn(null)}
        />
      )}
    </>
  );
}
