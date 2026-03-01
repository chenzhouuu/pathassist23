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

export function renderElementOnCanvas(ctx, el, fallbackColor, osd, highlighted = false) {
  if (!osd) return;

  const lc  = el.lineColor || fallbackColor;
  const fc  = el.fillColor || hexToRgba(fallbackColor, 0.15);
  const lw  = highlighted ? (el.lineWidth || 2) + 1.5 : (el.lineWidth || 2);

  ctx.save();
  ctx.strokeStyle = highlighted ? '#ffffff' : lc;
  ctx.lineWidth   = lw;
  ctx.fillStyle   = fc;

  if (highlighted) {
    ctx.shadowColor = lc;
    ctx.shadowBlur  = 8;
  }

  try {
    if (el.type === 'point') {
      const c  = el.center;
      const vp = imgToViewer(osd, c[0], c[1]);
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
      const [cx, cy] = el.center;
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
      const [cx, cy] = el.center;
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

    } else if (el.type === 'polyline' && el.points?.length >= 2) {
      const pts = el.points.map(([x, y]) => imgToViewer(osd, x, y));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (el.closed) {
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
    }

    // Label tooltip
    if (el.label?.value) {
      const ref = el.center
        ? imgToViewer(osd, el.center[0], el.center[1])
        : el.points
          ? imgToViewer(osd, el.points[0][0], el.points[0][1])
          : null;
      if (ref) {
        const txt = el.label.value;
        ctx.font = 'bold 11px "IBM Plex Mono", monospace';
        ctx.shadowBlur = 0;
        const m = ctx.measureText(txt);
        const px2 = ref.x + 8, py2 = ref.y - 14;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px2 - 3, py2 - 10, m.width + 8, 16, 3);
        else ctx.rect(px2 - 3, py2 - 10, m.width + 8, 16);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(txt, px2 + 1, py2 + 1);
      }
    }
  } catch (_) {}
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
