// src/components/viewer/CompareViewer.jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { getTilesInfoSafe } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';

function osdOpen(osd, source, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      osd.removeHandler('open', ok);
      osd.removeHandler('open-failed', fail);
      resolve();
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      osd.removeHandler('open', ok);
      osd.removeHandler('open-failed', fail);
      reject(new Error(e?.message || 'open-failed'));
    };
    osd.addHandler('open', ok);
    osd.addHandler('open-failed', fail);
    osd.open(source);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      osd.removeHandler('open', ok);
      osd.removeHandler('open-failed', fail);
      reject(new Error('timeout'));
    }, timeoutMs);
  });
}

function ComparePane({ item, label, onReady }) {
  const containerRef = useRef(null);
  const osdRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadSlide = useCallback(async (osd) => {
    const token = localStorage.getItem('girderToken') || '';
    const info = await getTilesInfoSafe(item._id);
    if (!info) {
      setError(true);
      setLoading(false);
      return;
    }

    try {
      await osdOpen(osd, {
        height: info.sizeY,
        width: info.sizeX,
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
    } catch (_) {}

    try {
      const dziUrl = `${GIRDER_BASE}/item/${item._id}/tiles/dzi${token ? `?token=${token}` : ''}`;
      await osdOpen(osd, dziUrl);
      setLoading(false);
      onReady(osd);
      return;
    } catch (_) {}

    try {
      const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=4096&height=4096${token ? `&token=${token}` : ''}`;
      await osdOpen(osd, { type: 'image', url: thumbUrl });
      setLoading(false);
      onReady(osd);
      return;
    } catch (_) {}

    setError(true);
    setLoading(false);
  }, [item, onReady]);

  useEffect(() => {
    if (!containerRef.current) return;
    const token = localStorage.getItem('girderToken') || '';

    const init = () => {
      if (osdRef.current) return;
      const osd = window.OpenSeadragon({
        element: containerRef.current,
        prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
        showNavigator: true,
        navigatorPosition: 'BOTTOM_RIGHT',
        navigatorHeight: '76px',
        navigatorWidth: '108px',
        showNavigationControl: false,
        showZoomControl: false,
        showHomeControl: false,
        showFullPageControl: false,
        maxZoomLevel: 128,
        minZoomLevel: 0.001,
        animationTime: 0.25,
        blendTime: 0.1,
        constrainDuringPan: false,
        visibilityRatio: 0.05,
        defaultZoomLevel: 0,
        zoomPerScroll: 1.5,
        smoothTileEdgesMinZoom: Infinity,
        crossOriginPolicy: 'Anonymous',
        ajaxHeaders: { 'Girder-Token': token },
        gestureSettingsMouse: { scrollToZoom: true, clickToZoom: false, dblClickToZoom: true },
      });
      osdRef.current = osd;
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
      try { osdRef.current?.destroy(); } catch (_) {}
      osdRef.current = null;
    };
  }, [item._id, loadSlide]);

  return (
    <div className="compare-pane">
      <div className="compare-pane-header">
        <div className="compare-pane-label">{label}</div>
        <div className="compare-pane-name" title={item.name}>{item.name}</div>
      </div>
      <div ref={containerRef} className="compare-pane-canvas" />

      {loading && (
        <div className="compare-pane-overlay">
          <div className="spinner" style={{ width: 26, height: 26, borderWidth: 2 }} />
          <span>Loading slide...</span>
        </div>
      )}

      {error && (
        <div className="compare-pane-overlay">
          <span>Unable to load slide</span>
        </div>
      )}
    </div>
  );
}

export default function CompareViewer() {
  const { compareItems, clearCompare, user, setPage } = useStore();
  const paneRefs = useRef([]);
  const wiredRef = useRef(false);
  const syncingRef = useRef(false);
  const syncEnabledRef = useRef(true);
  const [syncOn, setSyncOn] = useState(true);

  const items = (compareItems || []).slice(0, 4);
  const labels = ['A', 'B', 'C', 'D'];
  const isDedicatedWindow = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('compare') === '1';

  useEffect(() => {
    wiredRef.current = false;
    paneRefs.current = [];
  }, [items.map((item) => item?._id).join('|')]);

  const closeCompare = () => {
    clearCompare();
    if (isDedicatedWindow && window.opener && !window.opener.closed) {
      window.close();
      return;
    }
    setPage('browse');
  };

  const wireSync = useCallback(() => {
    if (wiredRef.current) return;
    const panes = paneRefs.current.filter(Boolean);
    if (panes.length < 2 || panes.length !== items.length) return;

    panes.forEach((from, index) => {
      from.addHandler('animation', () => {
        if (!syncEnabledRef.current || syncingRef.current) return;
        syncingRef.current = true;
        const center = from.viewport.getCenter();
        const zoom = from.viewport.getZoom();
        panes.forEach((to, toIndex) => {
          if (toIndex === index) return;
          to.viewport.panTo(center, true);
          to.viewport.zoomTo(zoom, null, true);
        });
        requestAnimationFrame(() => { syncingRef.current = false; });
      });
    });

    wiredRef.current = true;
  }, [items.length]);

  const handlePaneReady = useCallback((index, osd) => {
    paneRefs.current[index] = osd;
    wireSync();
  }, [wireSync]);

  const toggleSync = () => {
    syncEnabledRef.current = !syncEnabledRef.current;
    setSyncOn(syncEnabledRef.current);
  };

  if (items.length < 2) {
    return (
      <div className="compare-empty-shell">
        <span>No slides selected for comparison.</span>
        <button onClick={closeCompare} className="compare-action-btn">Back to worklist</button>
      </div>
    );
  }

  return (
    <div className="compare-shell">
      <header className="compare-header">
        <div className="compare-brand">
          <div className="compare-brand-mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2.5">
              <rect x="2" y="3" width="8" height="8" rx="1"/><rect x="14" y="3" width="8" height="8" rx="1"/><rect x="2" y="13" width="8" height="8" rx="1"/><rect x="14" y="13" width="8" height="8" rx="1"/>
            </svg>
          </div>
          <div>
            <div className="compare-brand-title">Compare Workspace</div>
            <div className="compare-brand-subtitle">{items.length} slides opened</div>
          </div>
        </div>

        <div className="compare-header-actions">
          <button onClick={toggleSync} className={`compare-toggle-btn ${syncOn ? 'active' : ''}`}>
            {syncOn ? 'Sync Zoom On' : 'Sync Zoom Off'}
          </button>
          <div className="compare-user-pill">
            {user?.firstName?.[0] || user?.login?.[0]?.toUpperCase() || '?'}
          </div>
          <button onClick={closeCompare} className="compare-close-btn">
            Exit
          </button>
        </div>
      </header>

      <div className={`compare-grid compare-grid-${items.length}`}>
        {items.map((item, index) => (
          <ComparePane
            key={item._id}
            item={item}
            label={labels[index]}
            onReady={(osd) => handlePaneReady(index, osd)}
          />
        ))}
      </div>
    </div>
  );
}
