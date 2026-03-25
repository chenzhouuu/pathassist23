// src/components/annotations/annotationUtils.js
// Matches large_image / HistomicsUI annotation schema exactly
// Ref: https://girder.github.io/large_image/annotations.html

export const ANN_COLORS = [
  '#4da6ff', '#e94560', '#4caf82', '#f5a623',
  '#c27aff', '#ff6b6b', '#00bcd4', '#ff9800',
  '#8bc34a', '#e91e63', '#03a9f4', '#ff5722',
];

// Convert #rrggbb to rgba(r,g,b,alpha)
export function hexToRgba(hex, alpha = 0.2) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Normalize any color value to a valid CSS color string.
// Handles: CSS strings ("#rrggbb", "rgba(...)", etc.) and [r,g,b] / [r,g,b,a] arrays.
export function normalizeColor(color, fallback = '#4da6ff') {
  if (!color) return fallback;
  if (typeof color === 'string') return color;
  if (Array.isArray(color)) {
    const [r, g, b, a] = color;
    if (color.length === 3) return `rgb(${r},${g},${b})`;
    if (color.length >= 4) return `rgba(${r},${g},${b},${a > 1 ? (a / 255).toFixed(3) : a})`;
  }
  return fallback;
}

// Image coords → OSD viewer element pixel coords
export function imgToViewer(osd, x, y) {
  if (!osd || !window.OpenSeadragon) return { x: 0, y: 0 };
  try {
    return osd.viewport.imageToViewerElementCoordinates(
      new window.OpenSeadragon.Point(x, y)
    );
  } catch(_) { return { x: 0, y: 0 }; }
}

// OSD viewer element pixel coords → image coords
export function viewerToImg(osd, px, py) {
  if (!osd || !window.OpenSeadragon) return { x: 0, y: 0 };
  try {
    return osd.viewport.viewerElementToImageCoordinates(
      new window.OpenSeadragon.Point(px, py)
    );
  } catch(_) { return { x: 0, y: 0 }; }
}

// ─── Element builders (large_image schema) ────────────────────────────────────

export function makePoint(x, y, { lineColor, label, group, lineWidth } = {}) {
  return {
    type: 'point',
    center: [x, y, 0],
    lineColor: lineColor || '#4da6ff',
    lineWidth: lineWidth || 2,
    ...(label ? { label: { value: label } } : {}),
    ...(group ? { group } : {}),
  };
}

export function makeRectangle(x1, y1, x2, y2, { lineColor, fillColor, label, group, lineWidth } = {}) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const w  = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  return {
    type: 'rectangle',
    center: [cx, cy, 0],
    width: w,
    height: h,
    rotation: 0,
    lineColor: lineColor || '#4da6ff',
    lineWidth: lineWidth || 2,
    fillColor: fillColor || hexToRgba(lineColor || '#4da6ff', 0.15),
    ...(label ? { label: { value: label } } : {}),
    ...(group ? { group } : {}),
  };
}

export function makePolyline(points, closed, { lineColor, fillColor, label, group, lineWidth } = {}) {
  return {
    type: 'polyline',
    points: points.map(([x, y]) => [x, y, 0]),
    closed: !!closed,
    lineColor: lineColor || '#4da6ff',
    lineWidth: lineWidth || 2,
    fillColor: closed
      ? (fillColor || hexToRgba(lineColor || '#4da6ff', 0.15))
      : 'rgba(0,0,0,0)',
    ...(label ? { label: { value: label } } : {}),
    ...(group ? { group } : {}),
  };
}

export function makeArrow(x0, y0, x1, y1, { lineColor, label, group, lineWidth } = {}) {
  return {
    type: 'arrow',
    points: [[x0, y0, 0], [x1, y1, 0]],
    lineColor: lineColor || '#4da6ff',
    lineWidth: lineWidth || 2,
    ...(label ? { label: { value: label } } : {}),
    ...(group ? { group } : {}),
  };
}

export function makeEllipse(x1, y1, x2, y2, { lineColor, fillColor, label, group, lineWidth } = {}) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const w  = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  return {
    type: 'ellipse',
    center: [cx, cy, 0],
    width: w,
    height: h,
    rotation: 0,
    lineColor: lineColor || '#4da6ff',
    lineWidth: lineWidth || 2,
    fillColor: fillColor || hexToRgba(lineColor || '#4da6ff', 0.15),
    ...(label ? { label: { value: label } } : {}),
    ...(group ? { group } : {}),
  };
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────

// Safely extract [x, y] from a point that may be an array [x,y,z] or object {x,y,z}
function ptXY(p) {
  if (Array.isArray(p)) return [p[0], p[1]];
  return [p.x ?? 0, p.y ?? 0];
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Returns true if the viewer-space click (vx, vy) lands on the given element.
export function hitTestElement(el, vx, vy, osd, threshold = 10) {
  if (!osd) return false;
  try {
    const img = viewerToImg(osd, vx, vy);
    switch (el.type) {
      case 'point': {
        const [cx, cy] = ptXY(el.center);
        const vp = imgToViewer(osd, cx, cy);
        return Math.hypot(vx - vp.x, vy - vp.y) <= threshold;
      }
      case 'rectangle': {
        const [cx, cy] = ptXY(el.center);
        return Math.abs(img.x - cx) <= el.width / 2 && Math.abs(img.y - cy) <= el.height / 2;
      }
      case 'ellipse': {
        const [cx, cy] = ptXY(el.center);
        return ((img.x - cx) ** 2 / (el.width / 2) ** 2) + ((img.y - cy) ** 2 / (el.height / 2) ** 2) <= 1;
      }
      case 'circle': {
        const [cx, cy] = ptXY(el.center);
        return Math.hypot(img.x - cx, img.y - cy) <= (el.radius || 0);
      }
      case 'polyline':
      case 'polygon': {
        if (!el.points?.length) return false;
        const pts = el.points.map(p => { const [x, y] = ptXY(p); return { x, y }; });
        const closed = el.type === 'polygon' || !!el.closed;
        if (closed && pointInPolygon(img.x, img.y, pts)) return true;
        for (let i = 1; i < pts.length; i++) {
          if (distToSegment(img.x, img.y, pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y) < threshold * 2) return true;
        }
        if (closed && pts.length > 1) {
          const last = pts[pts.length - 1];
          if (distToSegment(img.x, img.y, last.x, last.y, pts[0].x, pts[0].y) < threshold * 2) return true;
        }
        return false;
      }
      case 'line':
      case 'arrow': {
        if (!el.points?.length >= 2) return false;
        const [x0, y0] = ptXY(el.points[0]);
        const [x1, y1] = ptXY(el.points[1]);
        return distToSegment(img.x, img.y, x0, y0, x1, y1) <= threshold * 2;
      }
      default: return false;
    }
  } catch (_) { return false; }
}

// Find the topmost annotation under a viewer-space click. Returns the annotation or null.
export function findAnnotationAtViewer(annotations, vx, vy, osd) {
  for (const ann of [...annotations].reverse()) {
    for (const el of ann.annotation?.elements ?? []) {
      if (hitTestElement(el, vx, vy, osd)) return ann;
    }
  }
  return null;
}

// Compute axis-aligned bounding box of all elements. Returns {x, y, width, height} or null.
export function getAnnotationBBox(ann) {
  const xs = [], ys = [];
  for (const el of ann?.annotation?.elements ?? []) {
    if (el.center) {
      const [cx, cy] = ptXY(el.center);
      const rw = ((el.width ?? 0) || (el.radius ?? 0) * 2) / 2;
      const rh = ((el.height ?? 0) || (el.radius ?? 0) * 2) / 2;
      xs.push(cx - rw, cx + rw); ys.push(cy - rh, cy + rh);
    }
    if (el.points?.length) {
      el.points.forEach(p => { const [x, y] = ptXY(p); xs.push(x); ys.push(y); });
    }
  }
  if (!xs.length) return null;
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: Math.round(minX), y: Math.round(minY), width: Math.round(Math.max(...xs) - minX), height: Math.round(Math.max(...ys) - minY) };
}

export function renderElementOnCanvas(ctx, el, fallbackColor, osd, highlighted = false) {
  if (!osd) return;

  const isAiRoi = el.group === 'ai-roi';
  const lc  = normalizeColor(el.lineColor, fallbackColor);
  const fc  = normalizeColor(el.fillColor, null) || hexToRgba(fallbackColor, isAiRoi ? 0.08 : 0.15);
  const lw  = highlighted ? (el.lineWidth || 2) + 1.5 : (el.lineWidth || 2);

  ctx.save();
  ctx.strokeStyle = highlighted ? '#ffffff' : lc;
  ctx.lineWidth   = lw;
  ctx.fillStyle   = fc;
  if (isAiRoi) ctx.setLineDash([10, 6]);

  if (highlighted) {
    ctx.shadowColor = lc;
    ctx.shadowBlur  = 8;
  }

  try {
    if (el.type === 'point') {
      const [cx, cy] = ptXY(el.center);
      const vp = imgToViewer(osd, cx, cy);
      // Outer glow ring
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, highlighted ? 10 : 8, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(lc, 0.25);
      ctx.fill();
      // Colored circle
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, highlighted ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = lc;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Center dot
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

    } else if (el.type === 'rectangle') {
      const [cx, cy] = ptXY(el.center);
      const w = el.width, h = el.height;
      const corners = [
        imgToViewer(osd, cx - w/2, cy - h/2),
        imgToViewer(osd, cx + w/2, cy - h/2),
        imgToViewer(osd, cx + w/2, cy + h/2),
        imgToViewer(osd, cx - w/2, cy + h/2),
      ];
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = fc;
      ctx.fill();
      ctx.strokeStyle = highlighted ? '#ffffff' : lc;
      ctx.lineWidth = lw;
      ctx.stroke();

    } else if (el.type === 'ellipse') {
      const [cx, cy] = ptXY(el.center);
      const vc = imgToViewer(osd, cx, cy);
      const vr = imgToViewer(osd, cx + el.width/2, cy);
      const vb = imgToViewer(osd, cx, cy + el.height/2);
      const rx = Math.abs(vr.x - vc.x);
      const ry = Math.abs(vb.y - vc.y);
      ctx.beginPath();
      ctx.ellipse(vc.x, vc.y, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      ctx.fillStyle = fc;
      ctx.fill();
      ctx.strokeStyle = highlighted ? '#ffffff' : lc;
      ctx.lineWidth = lw;
      ctx.stroke();

    } else if (el.type === 'circle') {
      // circle: { center, radius }
      const [cx, cy] = ptXY(el.center);
      const vc = imgToViewer(osd, cx, cy);
      const ve = imgToViewer(osd, cx + (el.radius || 0), cy);
      const r  = Math.max(Math.abs(ve.x - vc.x), 1);
      ctx.beginPath();
      ctx.arc(vc.x, vc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fc;
      ctx.fill();
      ctx.strokeStyle = highlighted ? '#ffffff' : lc;
      ctx.lineWidth = lw;
      ctx.stroke();

    } else if (
      (el.type === 'polyline' || el.type === 'polygon') && el.points?.length >= 2
    ) {
      // 'polygon' is a closed polyline; 'polyline' respects el.closed flag
      const closed = el.type === 'polygon' || !!el.closed;
      const pts = el.points.map(p => { const [x, y] = ptXY(p); return imgToViewer(osd, x, y); });
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (closed) {
        ctx.closePath();
        ctx.fillStyle = fc;
        ctx.fill();
      }
      ctx.strokeStyle = highlighted ? '#ffffff' : lc;
      ctx.lineWidth = lw;
      ctx.stroke();
      // Vertex handles when highlighted
      if (highlighted) {
        pts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = lc;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.stroke();
        });
      }

    } else if (el.type === 'line' && el.points?.length >= 2) {
      // Simple two-point line (no arrowhead) — common in HistomicsUI
      const [x0, y0] = ptXY(el.points[0]);
      const [x1, y1] = ptXY(el.points[1]);
      const from = imgToViewer(osd, x0, y0);
      const to   = imgToViewer(osd, x1, y1);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = highlighted ? '#ffffff' : lc;
      ctx.lineWidth = lw;
      ctx.stroke();

    } else if (el.type === 'arrow' && el.points?.length >= 2) {
      // arrow: line from points[0] to points[1] with arrowhead at points[1]
      const [x0, y0] = ptXY(el.points[0]);
      const [x1, y1] = ptXY(el.points[1]);
      const from = imgToViewer(osd, x0, y0);
      const to   = imgToViewer(osd, x1, y1);
      const angle   = Math.atan2(to.y - from.y, to.x - from.x);
      const headLen = Math.max(lw * 4, 10);
      // Shaft
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = highlighted ? '#ffffff' : lc;
      ctx.lineWidth = lw;
      ctx.stroke();
      // Arrowhead
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI/6), to.y - headLen * Math.sin(angle - Math.PI/6));
      ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI/6), to.y - headLen * Math.sin(angle + Math.PI/6));
      ctx.closePath();
      ctx.fillStyle = lc;
      ctx.fill();

    } else if (el.type) {
      // Unknown type — log so it can be diagnosed
      console.warn('[Annotation] Unhandled element type:', el.type);
    }

    // Label tooltip
    if (el.label?.value) {
      const refPt = el.center
        ? el.center
        : el.points?.[0] ?? null;
      const ref = refPt ? imgToViewer(osd, ...ptXY(refPt)) : null;
      if (ref) {
        const txt = el.label.value;
        ctx.font = 'bold 11px "IBM Plex Mono", monospace';
        ctx.shadowBlur = 0;
        const m = ctx.measureText(txt);
        const px2 = ref.x + 8, py2 = ref.y - 14;
        ctx.fillStyle = isAiRoi ? hexToRgba(lc, 0.92) : 'rgba(0,0,0,0.75)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px2 - 3, py2 - 10, m.width + 8, 16, 3);
        else ctx.rect(px2 - 3, py2 - 10, m.width + 8, 16);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(txt, px2 + 1, py2 + 1);
      }
    }
  } catch (err) {
    console.warn('[Annotation] Render error for element type', el.type, err);
  }
  ctx.restore();
}

// Dashed preview during drawing
export function renderDrawingPreview(ctx, mode, ds, osd, color) {
  if (!ds.active || !osd) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = hexToRgba(color, 0.12);
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);

  try {
    if (mode === 'rectangle' && ds.start && ds.cursor) {
      const s = imgToViewer(osd, ds.start[0], ds.start[1]);
      const e = imgToViewer(osd, ds.cursor[0], ds.cursor[1]);
      ctx.beginPath();
      ctx.rect(s.x, s.y, e.x - s.x, e.y - s.y);
      ctx.fill(); ctx.stroke();
      // Dimension hint
      const w = Math.abs(ds.cursor[0] - ds.start[0]).toFixed(0);
      const h = Math.abs(ds.cursor[1] - ds.start[1]).toFixed(0);
      ctx.setLineDash([]);
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(e.x + 4, e.y - 14, 80, 14);
      ctx.fillStyle = color;
      ctx.fillText(`${w} × ${h}px`, e.x + 6, e.y - 3);

    } else if (mode === 'ellipse' && ds.start && ds.cursor) {
      const s = imgToViewer(osd, ds.start[0], ds.start[1]);
      const e = imgToViewer(osd, ds.cursor[0], ds.cursor[1]);
      const cx = (s.x + e.x) / 2, cy = (s.y + e.y) / 2;
      const rx = Math.abs(e.x - s.x) / 2, ry = Math.abs(e.y - s.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

    } else if (mode === 'arrow' && ds.start && ds.cursor) {
      const from = imgToViewer(osd, ds.start[0], ds.start[1]);
      const to   = imgToViewer(osd, ds.cursor[0], ds.cursor[1]);
      const angle   = Math.atan2(to.y - from.y, to.x - from.x);
      const headLen = 14;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI/6), to.y - headLen * Math.sin(angle - Math.PI/6));
      ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI/6), to.y - headLen * Math.sin(angle + Math.PI/6));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

    } else if ((mode === 'polygon' || mode === 'polyline') && ds.points?.length > 0) {
      const pts = ds.points.map(([x, y]) => imgToViewer(osd, x, y));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (ds.cursor) {
        const cur = imgToViewer(osd, ds.cursor[0], ds.cursor[1]);
        ctx.lineTo(cur.x, cur.y);
      }
      if (mode === 'polygon' && pts.length >= 2) ctx.closePath();
      ctx.stroke();
      // Vertex dots
      ctx.setLineDash([]);
      pts.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? color : hexToRgba(color, 0.8);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
      // Point count
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      if (ds.cursor) {
        const cur = imgToViewer(osd, ds.cursor[0], ds.cursor[1]);
        ctx.fillRect(cur.x + 10, cur.y - 22, 60, 14);
        ctx.fillStyle = color;
        ctx.fillText(`${ds.points.length} pts`, cur.x + 13, cur.y - 11);
      }
    }
  } catch (_) {}
  ctx.restore();
}
