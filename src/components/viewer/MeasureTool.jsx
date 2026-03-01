// src/components/viewer/MeasureTool.jsx
// Click two points on the slide to measure distance in μm (or mm / px).
// Disable OSD mouse navigation while active so clicks don't pan.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../store/index.js';

export default function MeasureTool({ viewer }) {
  const { tilesInfo, drawingMode, setDrawingMode } = useStore();

  // Use a ref for p1 so the click handler always sees the latest value
  // without needing to re-register the event listener on every state change.
  const p1Ref = useRef(null);
  const [p1, setP1] = useState(null);        // { svgX, svgY, imgX, imgY }
  const [mouse, setMouse] = useState(null);  // { svgX, svgY, imgX, imgY }
  const [result, setResult] = useState(null);// { label, ax, ay, bx, by, mx, my }

  const mppRef = useRef(null); // keep mpp accessible in stable callbacks
  mppRef.current = tilesInfo?.mm_x ? tilesInfo.mm_x * 1000 : null;

  // ── Coordinate helper ───────────────────────────────────────────────────────
  const getCoords = useCallback((e) => {
    const osd = viewer.current;
    if (!osd?.element) return null;
    const rect = osd.element.getBoundingClientRect();
    const svgX = e.clientX - rect.left;
    const svgY = e.clientY - rect.top;
    const OSD = window.OpenSeadragon;
    if (!OSD) return { svgX, svgY, imgX: svgX, imgY: svgY };
    try {
      const imgPt = osd.viewport.viewerElementToImageCoordinates(new OSD.Point(svgX, svgY));
      return { svgX, svgY, imgX: imgPt.x, imgY: imgPt.y };
    } catch (_) {
      return { svgX, svgY, imgX: svgX, imgY: svgY };
    }
  }, [viewer]);

  // ── Disable OSD panning while measure mode is active ───────────────────────
  useEffect(() => {
    const osd = viewer.current;
    if (!osd) return;
    if (drawingMode === 'measure') {
      osd.setMouseNavEnabled(false);
    } else {
      osd.setMouseNavEnabled(true);
      // Reset all state when exiting measure mode
      p1Ref.current = null;
      setP1(null);
      setMouse(null);
      setResult(null);
    }
    return () => { osd.setMouseNavEnabled(true); };
  }, [drawingMode, viewer]);

  // ── Mouse / click / keyboard event listeners ───────────────────────────────
  useEffect(() => {
    if (drawingMode !== 'measure') return;
    const osd = viewer.current;
    if (!osd?.element) return;
    const el = osd.element;

    const onMove = (e) => {
      const c = getCoords(e);
      if (c) setMouse(c);
    };

    const onClick = (e) => {
      if (e.button !== 0) return;
      const c = getCoords(e);
      if (!c) return;

      if (!p1Ref.current) {
        // First click → set start point
        p1Ref.current = c;
        setP1(c);
        setResult(null);
      } else {
        // Second click → compute & display distance
        const prev = p1Ref.current;
        const dx = c.imgX - prev.imgX;
        const dy = c.imgY - prev.imgY;
        const pixDist = Math.hypot(dx, dy);
        const mpp = mppRef.current;
        let label;
        if (mpp) {
          const um = pixDist * mpp;
          label = um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${um.toFixed(1)} μm`;
        } else {
          label = `${Math.round(pixDist)} px`;
        }
        setResult({
          label,
          ax: prev.svgX, ay: prev.svgY,
          bx: c.svgX,    by: c.svgY,
          mx: (prev.svgX + c.svgX) / 2,
          my: (prev.svgY + c.svgY) / 2,
        });
        p1Ref.current = null;
        setP1(null);
      }
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { setDrawingMode(null); }
      // 'c' clears last result and resets for a new measurement
      if (e.key === 'c' || e.key === 'C') {
        p1Ref.current = null;
        setP1(null);
        setResult(null);
      }
    };

    el.addEventListener('mousemove', onMove);
    el.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawingMode, viewer, getCoords, setDrawingMode]);

  if (drawingMode !== 'measure') return null;

  // ── Live distance label while dragging ─────────────────────────────────────
  const liveLabel = (() => {
    if (!p1 || !mouse) return null;
    const dx = mouse.imgX - p1.imgX;
    const dy = mouse.imgY - p1.imgY;
    const pixDist = Math.hypot(dx, dy);
    const mpp = mppRef.current;
    if (!mpp || pixDist < 1) return null;
    const um = pixDist * mpp;
    return um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${um.toFixed(1)} μm`;
  })();

  return (
    <div className="absolute inset-0 z-30" style={{ pointerEvents: 'none' }}>

      {/* SVG overlay — lines, circles, labels */}
      <svg className="absolute inset-0 w-full h-full" style={{ overflow: 'visible' }}>

        {/* ── Rubber-band line (point 1 set, waiting for point 2) ── */}
        {p1 && mouse && (
          <>
            <line x1={p1.svgX} y1={p1.svgY} x2={mouse.svgX} y2={mouse.svgY}
              stroke="#f5a623" strokeWidth="1.5" strokeDasharray="6 3" strokeLinecap="round"/>
            {/* Start dot */}
            <circle cx={p1.svgX} cy={p1.svgY} r="5" fill="#f5a623"/>
            <circle cx={p1.svgX} cy={p1.svgY} r="8" fill="none" stroke="#f5a623" strokeWidth="1" opacity="0.4"/>
            {/* Cursor dot */}
            <circle cx={mouse.svgX} cy={mouse.svgY} r="3" fill="#f5a623" opacity="0.8"/>
            {/* Live distance badge at midpoint */}
            {liveLabel && (() => {
              const mx = (p1.svgX + mouse.svgX) / 2;
              const my = (p1.svgY + mouse.svgY) / 2;
              return (
                <>
                  <rect x={mx - 44} y={my - 13} width="88" height="22" rx="5"
                    fill="rgba(10,12,20,0.85)" stroke="#f5a623" strokeWidth="0.7"/>
                  <text x={mx} y={my + 5} textAnchor="middle"
                    fill="#f5a623" fontSize="12" fontFamily="monospace">{liveLabel}</text>
                </>
              );
            })()}
          </>
        )}

        {/* ── First point placed, no mouse move yet ── */}
        {p1 && !mouse && (
          <>
            <circle cx={p1.svgX} cy={p1.svgY} r="5" fill="#f5a623"/>
            <circle cx={p1.svgX} cy={p1.svgY} r="9" fill="none" stroke="#f5a623" strokeWidth="1.2" opacity="0.5"/>
          </>
        )}

        {/* ── Completed measurement ── */}
        {result && (
          <>
            {/* Main line */}
            <line x1={result.ax} y1={result.ay} x2={result.bx} y2={result.by}
              stroke="#4caf82" strokeWidth="2" strokeLinecap="round"/>
            {/* End-cap ticks (perpendicular) */}
            {(() => {
              const dx = result.bx - result.ax, dy = result.by - result.ay;
              const len = Math.hypot(dx, dy) || 1;
              const nx = -dy / len * 6, ny = dx / len * 6;
              return (
                <>
                  <line x1={result.ax + nx} y1={result.ay + ny}
                        x2={result.ax - nx} y2={result.ay - ny}
                    stroke="#4caf82" strokeWidth="2" strokeLinecap="round"/>
                  <line x1={result.bx + nx} y1={result.by + ny}
                        x2={result.bx - nx} y2={result.by - ny}
                    stroke="#4caf82" strokeWidth="2" strokeLinecap="round"/>
                </>
              );
            })()}
            {/* Endpoint dots */}
            <circle cx={result.ax} cy={result.ay} r="4" fill="#4caf82"/>
            <circle cx={result.bx} cy={result.by} r="4" fill="#4caf82"/>
            {/* Distance label */}
            <rect x={result.mx - 48} y={result.my - 14} width="96" height="26" rx="6"
              fill="rgba(10,12,20,0.92)" stroke="#4caf82" strokeWidth="1"/>
            <text x={result.mx} y={result.my + 6} textAnchor="middle"
              fill="#4caf82" fontSize="13" fontFamily="monospace" fontWeight="600">
              {result.label}
            </text>
          </>
        )}
      </svg>

      {/* ── Cursor tooltip ── */}
      {mouse && (
        <div style={{
          position: 'absolute',
          left: mouse.svgX + 16,
          top:  mouse.svgY - 28,
          background: 'rgba(0,0,0,0.7)',
          color: p1 ? '#f5a623' : '#9ca3af',
          fontSize: 10,
          padding: '2px 8px',
          borderRadius: 4,
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}>
          {p1 ? 'Click endpoint · C=clear · Esc=exit' : 'Click start point'}
        </div>
      )}

      {/* ── Result badge with clear button (bottom of screen) ── */}
      {result && (
        <div style={{
          position: 'absolute', bottom: 48, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(10,15,25,0.9)', border: '1px solid rgba(76,175,130,0.4)',
          borderRadius: 8, padding: '6px 14px', pointerEvents: 'auto',
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2">
            <line x1="2" y1="12" x2="22" y2="12"/>
            <line x1="2" y1="7" x2="2" y2="17"/>
            <line x1="22" y1="7" x2="22" y2="17"/>
          </svg>
          <span style={{ color: '#4caf82', fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>
            {result.label}
          </span>
          {mppRef.current == null && (
            <span style={{ color: '#6b7280', fontSize: 10, fontFamily: 'monospace' }}>(no μm/px calibration)</span>
          )}
          <button
            onClick={() => { p1Ref.current = null; setP1(null); setResult(null); }}
            style={{ color: '#6b7280', fontSize: 12, marginLeft: 4, cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
            title="Clear measurement (C)">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
