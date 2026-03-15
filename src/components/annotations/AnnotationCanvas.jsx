// src/components/annotations/AnnotationCanvas.jsx
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useQueryClient } from '@tanstack/react-query';
import { createAnnotation, getRegionImageBlob, getTilesInfo } from '../../api/index.js';
import { analyzeKi67WithOpus, AI_MODEL_LABEL } from '../../api/claudeApi.js';
import { analyzeKi67WithGemini, GEMINI_MODEL_LABEL } from '../../api/geminiApi.js';
import { analyzeWholeSlide, analyzeRoiGrid } from '../../api/wsiAnalysis.js';
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
    roiSelectResult, setRoiSelectResult, clearRoiSelectResult,
    ki67RoiPending, setKi67RoiPending,
    ki67PendingModel, setKi67PendingModel,
    setKi67Analyzing,
    roiWsiPending, setRoiWsiPending,
    setWsiAnalyzing, setWsiProgress,
    addAiResult,
    setRightPanelTab,
  } = useStore();

  // mutable draw state (not React state — avoids re-renders on mouse move)
  const ds = useRef({ active: false, points: [], start: null, cursor: null });

  // Context menu + nuclei detection modal state
  const [ctxMenu, setCtxMenu]     = useState(null); // { x, y, ann }
  const [nucleiAnn, setNucleiAnn] = useState(null); // annotation to run nuclei detection on

  // Save-error notification (replaces browser alert)
  const [saveError, setSaveError] = useState(null); // { msg, hint } | null
  const saveErrorTimer = useRef(null);
  const showSaveError = useCallback((msg, hint) => {
    setSaveError({ msg, hint });
    clearTimeout(saveErrorTimer.current);
    saveErrorTimer.current = setTimeout(() => setSaveError(null), 7000);
  }, []);

  // ── Ki67 analysis ───────────────────────────────────────────────────────────
  // Called when user picks "Analyze Ki67 %" from the context menu.
  // Switches to roi-select mode; when the user finishes drawing the ROI,
  // the useEffect below detects ki67RoiPending + roiSelectResult and fires Opus.
  const handleAnalyzeKi67 = useCallback((model = 'claude') => {
    setKi67PendingModel(model);
    setKi67RoiPending(true);
    setDrawingMode('roi-select');
  }, [setKi67PendingModel, setKi67RoiPending, setDrawingMode]);

  const handleAnalyzeWsi = useCallback(async () => {
    if (!activeItem) return;
    setRightPanelTab('ai');
    setWsiAnalyzing(true);
    setWsiProgress({ current: 0, total: 16, patchGrid: Array(16).fill('pending') });
    try {
      const tilesInfo = await getTilesInfo(activeItem._id);
      const { aggregate, patchResults, gridN, slideWidth, slideHeight, modelLabel, usage } =
        await analyzeWholeSlide(activeItem._id, tilesInfo, setWsiProgress);
      addAiResult({
        id: Date.now().toString(),
        type: 'wsi',
        timestamp: Date.now(),
        itemId: activeItem._id,
        itemName: activeItem.name,
        modelLabel,
        aggregate,
        patchResults,
        gridN,
        slideWidth,
        slideHeight,
        usage,
      });
    } catch (err) {
      console.error('[WSI] Analysis failed:', err);
      addAiResult({
        id: Date.now().toString(),
        type: 'wsi',
        timestamp: Date.now(),
        itemId: activeItem._id,
        itemName: activeItem.name,
        aggregate: null,
        result: { error: err.message || 'WSI analysis failed' },
      });
    } finally {
      setWsiAnalyzing(false);
      setWsiProgress(null);
    }
  }, [activeItem, setRightPanelTab, setWsiAnalyzing, setWsiProgress, addAiResult]);

  // Watch for a completed ROI while a Ki67 analysis is pending.
  useEffect(() => {
    if (!ki67RoiPending || !roiSelectResult || !activeItem) return;

    const { x, y, width, height } = roiSelectResult;
    setKi67RoiPending(false);
    clearRoiSelectResult();
    setKi67Analyzing(true);
    setRightPanelTab('ai');

    // Capture the current ROI as a data-URL for the thumbnail shown in the panel.
    let thumbnailUrl = null;
    try {
      const osd = viewer.current;
      if (osd) {
        const canvas = document.createElement('canvas');
        const THUMB = 120;
        canvas.width = THUMB; canvas.height = THUMB;
        const ctx = canvas.getContext('2d');
        // draw from the OSD internal canvas (first canvas child of the OSD element)
        const osdCanvas = osd.element?.querySelector('canvas');
        if (osdCanvas) {
          // compute the viewport rect of the ROI so we can crop the OSD canvas
          const tl = osd.viewport.imageToViewerElementCoordinates(
            new window.OpenSeadragon.Point(x, y)
          );
          const br = osd.viewport.imageToViewerElementCoordinates(
            new window.OpenSeadragon.Point(x + width, y + height)
          );
          const sw = br.x - tl.x, sh = br.y - tl.y;
          if (sw > 0 && sh > 0) {
            ctx.drawImage(osdCanvas, tl.x, tl.y, sw, sh, 0, 0, THUMB, THUMB);
            thumbnailUrl = canvas.toDataURL('image/jpeg', 0.8);
          }
        }
      }
    } catch (_) { /* thumbnail is optional */ }

    const model = useStore.getState().ki67PendingModel ?? 'claude';
    const modelLabel = model === 'gemini' ? GEMINI_MODEL_LABEL : AI_MODEL_LABEL;
    const baseEntry = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      roi: { x, y, width, height },
      thumbnailUrl,
      itemId: activeItem._id,
      itemName: activeItem.name,
      modelLabel,
    };

    (async () => {
      try {
        const blob = await getRegionImageBlob(activeItem._id, x, y, width, height, 40);
        const analyze = model === 'gemini' ? analyzeKi67WithGemini : analyzeKi67WithOpus;
        const { result, usage } = await analyze(blob);
        addAiResult({ ...baseEntry, result, usage });
      } catch (err) {
        console.error('[Ki67] Analysis failed:', err);
        addAiResult({ ...baseEntry, result: { error: err.message || 'Analysis failed' } });
      } finally {
        setKi67Analyzing(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ki67RoiPending, roiSelectResult]);

  // ── ROI grid analysis ────────────────────────────────────────────────────────
  const handleAnalyzeRoiGrid = useCallback(() => {
    setRoiWsiPending(true);
    setDrawingMode('roi-select');
  }, [setRoiWsiPending, setDrawingMode]);

  useEffect(() => {
    if (!roiWsiPending || !roiSelectResult || !activeItem) return;
    const { x, y, width, height } = roiSelectResult;
    setRoiWsiPending(false);
    clearRoiSelectResult();
    setWsiAnalyzing(true);
    setWsiProgress({ current: 0, total: 9, patchGrid: Array(9).fill('pending') });
    setRightPanelTab('ai');

    (async () => {
      try {
        const { aggregate, patchResults, gridN, modelLabel, usage } =
          await analyzeRoiGrid(activeItem._id, { x, y, width, height }, setWsiProgress);
        addAiResult({
          id: Date.now().toString(),
          type: 'roi-grid',
          timestamp: Date.now(),
          itemId: activeItem._id,
          itemName: activeItem.name,
          roi: { x, y, width, height },
          modelLabel, aggregate, patchResults, gridN, usage,
        });
      } catch (err) {
        console.error('[ROI Grid] Analysis failed:', err);
        addAiResult({
          id: Date.now().toString(),
          type: 'roi-grid',
          timestamp: Date.now(),
          itemId: activeItem._id,
          itemName: activeItem.name,
          result: { error: err.message || 'ROI grid analysis failed' },
        });
      } finally {
        setWsiAnalyzing(false);
        setWsiProgress(null);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roiWsiPending, roiSelectResult]);

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
    // roi-select renders as a blue dashed rectangle (same shape as rectangle mode)
    if (drawingMode && ds.current.active) {
      const previewMode  = drawingMode === 'roi-select' ? 'rectangle' : drawingMode;
      const previewColor = drawingMode === 'roi-select' ? '#4da6ff'   : (drawColor || ANN_COLORS[0]);
      renderDrawingPreview(ctx, previewMode, ds.current, osd, previewColor);
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
      const status = err?.response?.status;
      const serverMsg = err?.response?.data?.message || err.message;
      console.error('[AnnotationCanvas] Save failed:', status, serverMsg);
      if (status === 403) {
        showSaveError(
          'Permission denied — cannot annotate this slide.',
          'Ask your Girder admin to grant Write access on this collection or folder.'
        );
      } else {
        showSaveError(`Failed to save annotation: ${serverMsg}`);
      }
    }
  }, [activeItem, drawLabel, drawGroup, setAnnotations, qc, showSaveError]);

  // ── Mouse events ────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    if (!drawingMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const xy = getImgCoords(e);
    if (!xy) return;
    const d = ds.current;

    if (drawingMode === 'rectangle' || drawingMode === 'ellipse' || drawingMode === 'roi-select') {
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

    } else if (drawingMode === 'roi-select' && d.active && d.start) {
      // ROI selection — store coordinates, don't create an annotation
      const [sx, sy] = d.start;
      const [ex, ey] = xy;
      d.active = false; d.start = null; d.cursor = null;
      if (Math.abs(ex - sx) < 5 && Math.abs(ey - sy) < 5) { render(); return; }
      const x = Math.round(Math.min(sx, ex));
      const y = Math.round(Math.min(sy, ey));
      const w = Math.round(Math.abs(ex - sx));
      const h = Math.round(Math.abs(ey - sy));
      setRoiSelectResult({ x, y, width: w, height: h });
      setDrawingMode(null);
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
            : (drawingMode === 'rectangle' || drawingMode === 'ellipse') ? (ds.current.active ? 'crosshair' : 'cell')
            : drawingMode === 'roi-select' ? (ds.current.active ? 'crosshair' : 'crosshair')
            : 'crosshair',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDblClick}
      />

      {/* Save-error notification banner */}
      {saveError && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 20, maxWidth: 420, width: 'calc(100% - 32px)',
          background: 'rgba(233,69,96,0.15)', border: '1px solid rgba(233,69,96,0.4)',
          borderRadius: 10, padding: '10px 14px',
          backdropFilter: 'blur(8px)', boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e94560" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#e94560', fontSize: 12, fontWeight: 600 }}>{saveError.msg}</div>
            {saveError.hint && <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 3 }}>{saveError.hint}</div>}
          </div>
          <button onClick={() => setSaveError(null)} style={{ color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          ann={ctxMenu.ann}
          viewer={viewer}
          onClose={() => setCtxMenu(null)}
          onAnnotateNuclei={(ann) => { setCtxMenu(null); setNucleiAnn(ann); }}
          onAnalyzeKi67={handleAnalyzeKi67}
          onAnalyzeRoiGrid={handleAnalyzeRoiGrid}
          onAnalyzeWsi={handleAnalyzeWsi}
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
