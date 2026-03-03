// src/components/viewer/CompareViewer.jsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { getTilesInfoSafe } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';
import ThemeSwitcher from '../ThemeSwitcher.jsx';

// ── Open OSD with a source; handlers registered BEFORE open() call ────────────
function osdOpen(osd, source, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok   = () => { if (settled) return; settled = true; osd.removeHandler('open', ok); osd.removeHandler('open-failed', fail); resolve(); };
    const fail = (e) => { if (settled) return; settled = true; osd.removeHandler('open', ok); osd.removeHandler('open-failed', fail); reject(new Error(e?.message || 'open-failed')); };
    osd.addHandler('open', ok);
    osd.addHandler('open-failed', fail);
    osd.open(source);
    setTimeout(() => { if (!settled) { settled = true; osd.removeHandler('open', ok); osd.removeHandler('open-failed', fail); reject(new Error('timeout')); } }, timeoutMs);
  });
}

// ── Single synchronized OSD pane ───────────────────────────────────────────────
function OSDPane({ item, label, paneRef, onReady }) {
  const containerRef = useRef(null);
  const [slideInfo, setSlideInfo] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);

  const loadSlide = useCallback(async (osd) => {
    const token = localStorage.getItem('girderToken') || '';
    const info  = await getTilesInfoSafe(item._id);
    if (!info) { setError(true); setLoading(false); return; }
    setSlideInfo(info);

    // 1. ZXY (same as ViewerPanel — most reliable with Girder auth)
    try {
      await osdOpen(osd, {
        height:   info.sizeY,
        width:    info.sizeX,
        tileSize: info.tileWidth || 256,
        minLevel: 0,
        maxLevel: (info.levels || 1) - 1,
        getTileUrl(level, x, y) {
          return `${GIRDER_BASE}/item/${item._id}/tiles/zxy/${level}/${x}/${y}${token ? `?token=${token}` : ''}`;
        },
      });
      setLoading(false);
      onReady(osd);
      return;
    } catch (_) { /* fall through */ }

    // 2. DZI fallback
    try {
      const dziUrl = `${GIRDER_BASE}/item/${item._id}/tiles/dzi${token ? `?token=${token}` : ''}`;
      await osdOpen(osd, dziUrl);
      setLoading(false);
      onReady(osd);
      return;
    } catch (_) { /* fall through */ }

    // 3. Large thumbnail last resort
    try {
      const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=4096&height=4096${token ? `&token=${token}` : ''}`;
      await osdOpen(osd, { type: 'image', url: thumbUrl });
      setLoading(false);
      onReady(osd);
      return;
    } catch (_) { /* fall through */ }

    setError(true);
    setLoading(false);
  }, [item._id, onReady]); // eslint-disable-line

  useEffect(() => {
    if (!containerRef.current) return;
    const token = localStorage.getItem('girderToken') || '';

    const init = () => {
      if (paneRef.current) return; // already created
      const osd = window.OpenSeadragon({
        element:               containerRef.current,
        prefixUrl:             'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
        showNavigator:         true,
        navigatorPosition:     'BOTTOM_RIGHT',
        navigatorHeight:       '70px',
        navigatorWidth:        '100px',
        showNavigationControl: false,
        showZoomControl:       false,
        showHomeControl:       false,
        showFullPageControl:   false,
        maxZoomLevel:          128,
        minZoomLevel:          0.001,
        animationTime:         0.25,
        blendTime:             0.1,
        constrainDuringPan:    false,
        visibilityRatio:       0.05,
        defaultZoomLevel:      0,
        zoomPerScroll:         1.5,
        smoothTileEdgesMinZoom: Infinity,
        crossOriginPolicy:     'Anonymous',
        ajaxHeaders:           { 'Girder-Token': token },
        gestureSettingsMouse:  { scrollToZoom: true, clickToZoom: false, dblClickToZoom: true },
      });
      paneRef.current = osd;
      loadSlide(osd);
    };

    if (window.OpenSeadragon) {
      init();
    } else {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/openseadragon.min.js';
      s.async = true;
      s.onload = init;
      document.head.appendChild(s);
    }

    return () => {
      try { paneRef.current?.destroy(); } catch (_) {}
      paneRef.current = null;
    };
  }, [item._id]); // eslint-disable-line

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden" style={{ minWidth: 0 }}>
      {/* Label bar */}
      <div className="flex items-center justify-between px-3 shrink-0"
        style={{ height: 32, background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold px-1.5 py-0.5 rounded"
            style={{
              background: label === 'A' ? 'rgba(77,166,255,0.2)' : 'rgba(76,175,130,0.2)',
              color:      label === 'A' ? '#4da6ff'              : '#4caf82',
              border:     `1px solid ${label === 'A' ? 'rgba(77,166,255,0.35)' : 'rgba(76,175,130,0.35)'}`,
            }}>
            {label}
          </span>
          <span className="text-xs truncate" style={{ color: 'var(--muted)' }} title={item.name}>
            {item.name}
          </span>
        </div>
        {slideInfo && (
          <div className="flex items-center gap-2 shrink-0">
            {slideInfo.magnification && <span className="tag">{slideInfo.magnification}×</span>}
            {slideInfo.sizeX && slideInfo.sizeY && (
              <span className="text-xs font-mono hidden lg:block" style={{ color: 'var(--muted)' }}>
                {slideInfo.sizeX.toLocaleString()}×{slideInfo.sizeY.toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      {/* OSD container */}
      <div ref={containerRef} className="flex-1" style={{ background: 'var(--bg-viewer)' }}/>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 top-8 flex flex-col items-center justify-center gap-3"
          style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }}/>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading slide…</span>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 top-8 flex flex-col items-center justify-center gap-2"
          style={{ background: 'var(--bg-viewer)' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--muted)' }} strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Unable to load slide</span>
        </div>
      )}
    </div>
  );
}

// ── CompareViewer ──────────────────────────────────────────────────────────────
export default function CompareViewer() {
  const { compareItems, clearCompare, user } = useStore();
  const osdA    = useRef(null);
  const osdB    = useRef(null);
  const syncing = useRef(false);
  const readyCount  = useRef(0);
  const syncEnabled = useRef(true);

  const [syncOn, setSyncOn] = useState(true);

  const toggleSync = () => {
    syncEnabled.current = !syncEnabled.current;
    setSyncOn(syncEnabled.current);
  };

  const handleReady = useCallback((osd) => {
    readyCount.current += 1;
    if (readyCount.current < 2) return;

    // Both viewers loaded — wire up bidirectional sync
    const sync = (from, to) => {
      from.addHandler('animation', () => {
        if (!syncEnabled.current || syncing.current) return;
        syncing.current = true;
        to.viewport.panTo(from.viewport.getCenter(), true);
        to.viewport.zoomTo(from.viewport.getZoom(), null, true);
        requestAnimationFrame(() => { syncing.current = false; });
      });
    };
    sync(osdA.current, osdB.current);
    sync(osdB.current, osdA.current);
  }, []); // eslint-disable-line

  const [itemA, itemB] = compareItems;

  if (!itemA || !itemB) {
    return (
      <div className="flex flex-col items-center justify-center gap-3"
        style={{ height: '100dvh', background: 'var(--bg)' }}>
        <span className="text-sm" style={{ color: 'var(--muted)' }}>No slides selected for comparison.</span>
        <button onClick={clearCompare}
          className="text-xs px-4 py-2 rounded"
          style={{ background: 'rgba(77,166,255,0.15)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.3)' }}>
          Back to Worklist
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: '100dvh', background: 'var(--bg)' }}>

      {/* ── Header ── */}
      <header className="flex items-center gap-3 px-4 shrink-0"
        style={{ height: 'var(--header-h)', background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border)' }}>

        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: 'rgba(77,166,255,0.15)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <span className="font-semibold text-sm" style={{ color: 'var(--text)' }}>PathAssist</span>
        </div>

        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
          style={{ background: 'rgba(77,166,255,0.1)', border: '1px solid rgba(77,166,255,0.25)', color: '#4da6ff' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="9" height="18" rx="1"/><rect x="13" y="3" width="9" height="18" rx="1"/>
          </svg>
          Compare Mode
        </div>

        <div className="flex-1"/>

        {/* Sync toggle */}
        <button onClick={toggleSync}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-all"
          style={{
            background: syncOn ? 'rgba(76,175,130,0.12)' : 'var(--highlight)',
            color:      syncOn ? '#4caf82' : 'var(--muted)',
            border:     `1px solid ${syncOn ? 'rgba(76,175,130,0.3)' : 'var(--border)'}`,
          }}
          title="Toggle synchronized pan/zoom">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
            <path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
          </svg>
          {syncOn ? 'Sync On' : 'Sync Off'}
        </button>

        <ThemeSwitcher/>
        <div className="w-px h-5" style={{ background: 'var(--border)' }}/>

        <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
          style={{ background: 'rgba(77,166,255,0.2)', color: '#4da6ff' }}>
          {user?.firstName?.[0] || user?.login?.[0]?.toUpperCase() || '?'}
        </div>

        <button onClick={clearCompare}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-medium transition-all"
          style={{ background: 'rgba(233,69,96,0.1)', color: '#e94560', border: '1px solid rgba(233,69,96,0.25)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          Exit
        </button>
      </header>

      {/* ── Viewers side by side ── */}
      <div className="flex flex-1 overflow-hidden">
        <OSDPane item={itemA} label="A" paneRef={osdA} onReady={handleReady}/>
        <div style={{ width: 2, background: 'var(--border)', flexShrink: 0 }}/>
        <OSDPane item={itemB} label="B" paneRef={osdB} onReady={handleReady}/>
      </div>

    </div>
  );
}
