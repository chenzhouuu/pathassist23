// src/components/annotations/AnnotationCanvas.jsx
import React, { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnnotations, createAnnotation } from '../../api/index.js';

const COLORS = ['#e94560', '#4da6ff', '#4caf82', '#f5a623', '#c27aff', '#ff6b6b', '#00bcd4'];

export default function AnnotationCanvas({ viewer }) {
  const canvasRef = useRef(null);
  const { activeItem, drawingMode, setDrawingMode, annotations, setAnnotations, visibleAnnotations } = useStore();
  const qc = useQueryClient();

  // Drawing state
  const drawing = useRef({ active: false, points: [], colorIdx: 0 });

  // Load annotations for current item
  const { data } = useQuery({
    queryKey: ['annotations', activeItem?._id],
    queryFn: () => getAnnotations(activeItem._id),
    enabled: !!activeItem?._id,
    onSuccess: (data) => setAnnotations(data),
  });

  useEffect(() => {
    if (data) setAnnotations(data);
  }, [data]);

  // Render annotations on canvas whenever viewer pans/zooms
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const v = viewer.current;
    if (!canvas || !v) return;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    annotations.forEach((ann, ai) => {
      if (visibleAnnotations[ann._id] === false) return;
      const color = COLORS[ai % COLORS.length];
      const elements = ann.annotation?.elements || [];

      elements.forEach((el) => {
        ctx.strokeStyle = el.lineColor || color;
        ctx.fillStyle = el.fillColor || color.replace(')', ', 0.15)').replace('rgb', 'rgba');
        ctx.lineWidth = el.lineWidth || 1.5;

        if (el.type === 'point') {
          const pt = el.center || el.points?.[0];
          if (!pt) return;
          const vp = v.viewport.imageToViewerElementCoordinates(
            new window.OpenSeadragon.Point(pt[0], pt[1])
          );
          ctx.beginPath();
          ctx.arc(vp.x, vp.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (el.points?.length > 1) {
          const pts = el.points.map(([x, y]) =>
            v.viewport.imageToViewerElementCoordinates(new window.OpenSeadragon.Point(x, y))
          );
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
          if (el.closed !== false && el.type !== 'polyline') ctx.closePath();
          ctx.fill();
          ctx.lineWidth = el.lineWidth || 1.5;
          ctx.strokeStyle = el.lineColor || color;
          ctx.stroke();
        }

        // Label
        if (el.label?.value) {
          const pt = el.points?.[0] || el.center;
          if (pt) {
            const vp = v.viewport.imageToViewerElementCoordinates(
              new window.OpenSeadragon.Point(pt[0], pt[1])
            );
            ctx.font = '10px IBM Plex Mono, monospace';
            ctx.fillStyle = '#fff';
            ctx.fillText(el.label.value, vp.x + 4, vp.y - 4);
          }
        }
      });
    });
  }, [annotations, visibleAnnotations, viewer]);

  // Resize canvas and attach OSD handlers
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;

    const resize = () => {
      const container = v.element;
      if (!canvasRef.current || !container) return;
      canvasRef.current.width = container.clientWidth;
      canvasRef.current.height = container.clientHeight;
      render();
    };

    const handlers = ['open', 'animation', 'animation-finish', 'pan', 'zoom', 'resize'];
    handlers.forEach((h) => v.addHandler(h, render));
    v.addHandler('resize', resize);
    resize();

    return () => {
      handlers.forEach((h) => v.removeAllHandlers(h));
    };
  }, [viewer, render]);

  // Re-render when annotations/visibility change
  useEffect(() => { render(); }, [annotations, visibleAnnotations, render]);

  // ── Drawing interaction ──────────────────────────────────────────────────
  const getImageCoords = (e) => {
    const v = viewer.current;
    if (!v) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const vp = new window.OpenSeadragon.Point(e.clientX - rect.left, e.clientY - rect.top);
    return v.viewport.viewerElementToImageCoordinates(vp);
  };

  const handleClick = async (e) => {
    if (!drawingMode || !activeItem) return;
    const coord = getImageCoords(e);
    if (!coord) return;

    const d = drawing.current;

    if (drawingMode === 'point') {
      // Save immediately
      await saveAnnotation([coord.x, coord.y, 0], 'point');
      return;
    }

    if (drawingMode === 'rectangle') {
      if (!d.active) {
        d.active = true;
        d.start = [coord.x, coord.y, 0];
      } else {
        const [sx, sy] = d.start;
        const ex = coord.x, ey = coord.y;
        await saveAnnotation([
          [sx, sy, 0], [ex, sy, 0], [ex, ey, 0], [sx, ey, 0]
        ], 'polyline');
        d.active = false;
        d.points = [];
      }
      return;
    }

    d.points.push([coord.x, coord.y, 0]);

    if (drawingMode === 'polygon' || drawingMode === 'polyline') {
      // Double-click to finish (handled in onDoubleClick)
    }
  };

  const handleDblClick = async (e) => {
    const d = drawing.current;
    if (!drawingMode || d.points.length < 2) return;
    e.preventDefault();
    await saveAnnotation([...d.points], drawingMode);
    d.points = [];
    d.active = false;
  };

  const saveAnnotation = async (points, type) => {
    const color = COLORS[drawing.current.colorIdx % COLORS.length];
    drawing.current.colorIdx++;

    const element = type === 'point'
      ? { type: 'point', center: points, fillColor: color, lineColor: color }
      : {
          type: 'polyline',
          points,
          closed: type === 'polygon',
          fillColor: color + '33',
          lineColor: color,
          lineWidth: 2,
        };

    const payload = {
      name: `Annotation ${new Date().toLocaleTimeString()}`,
      description: '',
      elements: [element],
    };

    try {
      await createAnnotation(activeItem._id, payload);
      qc.invalidateQueries(['annotations', activeItem._id]);
    } catch (err) {
      console.error('Failed to save annotation', err);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      id="annotation-overlay"
      className={drawingMode ? 'drawing' : ''}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      style={{
        position: 'absolute',
        top: 0, left: 0,
        pointerEvents: drawingMode ? 'all' : 'none',
      }}
    />
  );
}
