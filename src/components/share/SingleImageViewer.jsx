import React, { useEffect, useRef, useState } from 'react';
import OpenSeadragon from 'openseadragon';

function SingleViewerPanel({ item, girderToken, apiBase }) {
  const containerRef = useRef(null);
  const fallbackViewportRef = useRef(null);
  const osdRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [statusText, setStatusText] = useState('Loading image...');
  const [usingFallbackImage, setUsingFallbackImage] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadName, setDownloadName] = useState('');
  const dragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  useEffect(() => {
    if (!containerRef.current || !item?._id) return;

    setLoaded(false);
    setLoadError(false);
    setImageUrl('');
    setStatusText('Loading image...');
    setUsingFallbackImage(false);
    setImageZoom(1);
    setImageOffset({ x: 0, y: 0 });
    setDownloadUrl('');
    setDownloadName(item.name || '');
    let destroyed = false;

    const osd = OpenSeadragon({
      element: containerRef.current,
      showNavigator: true,
      navigatorPosition: 'BOTTOM_LEFT',
      navigatorSizeRatio: 0.15,
      showNavigationControl: false,
      crossOriginPolicy: false,
      defaultZoomLevel: 0,
      animationTime: 0.3,
      blendTime: 0.1,
      minZoomImageRatio: 0.3,
      maxZoomPixelRatio: 16,
      visibilityRatio: 0.2,
      zoomPerScroll: 1.3,
      smoothTileEdgesMinZoom: Infinity,
    });
    osdRef.current = osd;

    const osdOpen = (source, timeoutMs = 15000) => new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      const done = (fn) => () => {
        if (settled) return;
        settled = true;
        osd.removeHandler('open', onOpen);
        osd.removeHandler('open-failed', onFail);
        osd.removeHandler('tile-drawn', onDrawn);
        fn();
      };
      const onOpen = () => {
        opened = true;
        try {
          osd.viewport?.goHome(true);
          osd.forceRedraw?.();
        } catch (_) {}
      };
      const onDrawn = () => { if (opened) done(resolve)(); };
      const onFail = done(reject);

      osd.addHandler('open', onOpen);
      osd.addHandler('open-failed', onFail);
      osd.addHandler('tile-drawn', onDrawn);
      try { osd.open(source); } catch (_) { done(reject)(); }
      setTimeout(done(reject), timeoutMs);
    });

    async function loadItem() {
      try {
        const thumbUrl = `${apiBase}/item/${item._id}/tiles/thumbnail?width=4096&height=4096&token=${girderToken}`;
        setStatusText('Loading preview...');
        const probe = await fetch(thumbUrl, { headers: { 'Girder-Token': girderToken } });
        if (probe.ok && (probe.headers.get('content-type') || '').startsWith('image/')) {
          if (!destroyed) {
            setImageUrl(thumbUrl);
            setUsingFallbackImage(true);
            setLoaded(true);
          }
          try {
            await osdOpen({ type: 'image', url: thumbUrl }, 8000);
          } catch (_) {}
          return;
        }
      } catch (_) {}

      if (destroyed) return;

      try {
        setStatusText('Loading tiled image...');
        const res = await fetch(`${apiBase}/item/${item._id}/tiles`, { headers: { 'Girder-Token': girderToken } });
        if (res.ok) {
          const info = await res.json();
          if (info?.sizeX > 0 && info?.sizeY > 0) {
            await osdOpen(`${apiBase}/item/${item._id}/tiles/dzi?token=${girderToken}`, 15000);
            if (!destroyed) { setLoaded(true); return; }
          }
        }
      } catch (_) {}

      if (destroyed) return;

      try {
        setStatusText('Trying alternate tile source...');
        const res = await fetch(`${apiBase}/item/${item._id}/tiles`, { headers: { 'Girder-Token': girderToken } });
        if (res.ok) {
          const info = await res.json();
          if (info?.sizeX > 0 && info?.sizeY > 0) {
            await osdOpen({
              height: info.sizeY,
              width: info.sizeX,
              tileSize: info.tileWidth || 256,
              minLevel: 0,
              maxLevel: (info.levels || 1) - 1,
              getTileUrl(level, x, y) {
                return `${apiBase}/item/${item._id}/tiles/zxy/${level}/${x}/${y}?token=${girderToken}`;
              },
            }, 15000);
            if (!destroyed) { setLoaded(true); return; }
          }
        }
      } catch (_) {}

      if (!destroyed) {
        setLoadError(true);
        setLoaded(true);
        setStatusText('Could not load image');
      }
    }

    loadItem();

    (async () => {
      try {
        const res = await fetch(`${apiBase}/item/${item._id}/files?limit=20`, {
          headers: { 'Girder-Token': girderToken },
        });
        if (!res.ok) return;
        const files = await res.json();
        if (!Array.isArray(files) || files.length === 0 || destroyed) return;

        const preferred =
          files.find((f) => f.name === item.name) ||
          files.find((f) => /\.ome\.tiff?$/i.test(f.name)) ||
          files[0];

        if (preferred?._id) {
          setDownloadUrl(`${apiBase}/file/${preferred._id}/download?token=${girderToken}`);
          setDownloadName(preferred.name || item.name || 'slide');
        }
      } catch (_) {}
    })();

    return () => {
      destroyed = true;
      if (osdRef.current) {
        osdRef.current.destroy();
        osdRef.current = null;
      }
    };
  }, [apiBase, girderToken, item]);

  const clampZoom = (next) => Math.min(12, Math.max(1, next));
  const zoom = (factor) => {
    if (usingFallbackImage) {
      setImageZoom((prev) => clampZoom(prev * factor));
      return;
    }
    osdRef.current?.viewport?.zoomBy(factor, null, true);
  };
  const home = () => {
    if (usingFallbackImage) {
      setImageZoom(1);
      setImageOffset({ x: 0, y: 0 });
      return;
    }
    osdRef.current?.viewport?.goHome(true);
  };
  const fullscreen = () => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  const resolvedDownloadUrl = downloadUrl || imageUrl || `${apiBase}/item/${item._id}/tiles/thumbnail?width=4096&height=4096&token=${girderToken}`;
  const resolvedDownloadName = downloadName || item.name;

  const onFallbackWheel = (e) => {
    if (!usingFallbackImage) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    setImageZoom((prev) => clampZoom(prev * factor));
  };

  const onPointerDown = (e) => {
    if (!usingFallbackImage || imageZoom <= 1) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: imageOffset.x,
      originY: imageOffset.y,
    };
  };

  const onPointerMove = (e) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setImageOffset({
      x: dragRef.current.originX + dx,
      y: dragRef.current.originY + dy,
    });
  };

  const endDrag = () => {
    dragRef.current.active = false;
  };

  return (
    <div className="h-screen flex flex-col" style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <div className="flex items-center justify-between px-4 h-12 shrink-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #1e2537' }}>
        <div className="text-sm font-bold" style={{ color: '#4da6ff' }}>PathAssist</div>
        <div className="text-xs truncate ml-4" style={{ color: '#9ca3af' }}>{item.name}</div>
      </div>

      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, touchAction: 'none' }}/>
        {imageUrl && (
          <div
            ref={fallbackViewportRef}
            className="absolute inset-0 flex items-center justify-center overflow-hidden"
            style={{ background: '#08090f', cursor: usingFallbackImage && imageZoom > 1 ? 'grab' : 'default' }}
            onWheel={onFallbackWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
          >
            <img
              src={imageUrl}
              alt={item.name}
              className="max-w-full max-h-full object-contain select-none"
              draggable={false}
              style={{
                display: loaded && !loadError ? 'block' : 'none',
                transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageZoom})`,
                transformOrigin: 'center center',
                transition: dragRef.current.active ? 'none' : 'transform 0.12s ease-out',
                pointerEvents: 'none',
              }}
            />
          </div>
        )}
        {!loaded && (
          <div className="absolute top-0 left-0 right-0 h-10 flex items-center justify-center text-xs"
            style={{ color: '#6b7280', background: 'rgba(13,17,23,0.85)' }}>
            {statusText}
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-sm mb-1" style={{ color: '#6b7280' }}>Could not load this image</div>
              <div className="text-xs" style={{ color: '#374151' }}>This link may have expired or the slide is unavailable.</div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-2 px-4 h-12 shrink-0"
        style={{ background: '#0d1117', borderTop: '1px solid #1e2537' }}>
        {[
          { title: 'Zoom in', fn: () => zoom(1.5), d: 'M11 8v6M8 11h6M21 21l-4.35-4.35M11 11m-8 0a8 8 0 1 0 16 0 8 8 0 0 0-16 0' },
          { title: 'Fit', fn: home, d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10' },
          { title: 'Zoom out', fn: () => zoom(0.67), d: 'M8 11h6M21 21l-4.35-4.35M11 11m-8 0a8 8 0 1 0 16 0 8 8 0 0 0-16 0' },
          { title: 'Fullscreen', fn: fullscreen, d: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3' },
        ].map(({ title, fn, d }) => (
          <button key={title} onClick={fn} title={title}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #1e2537', color: '#6b7280' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d={d}/>
            </svg>
          </button>
        ))}
        <a
          href={resolvedDownloadUrl}
          download={resolvedDownloadName}
          title="Download"
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #1e2537', color: '#6b7280' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>
          </svg>
        </a>
      </div>
    </div>
  );
}

export default function SingleImageViewer({ encodedData }) {
  const [shareData, setShareData] = useState(null);
  const [parseError, setParseError] = useState('');

  useEffect(() => {
    try {
      const json = atob(encodedData);
      const data = JSON.parse(json);
      if (!data.itemId || !data.gt || !data.api || !data.expiry) throw new Error('Invalid share link');
      if (Date.now() > data.expiry) throw new Error('Expired');
      setShareData({
        item: { _id: data.itemId, name: data.itemName || 'Shared image' },
        gt: data.gt,
        api: data.api,
      });
    } catch (_) {
      setParseError('This image link is invalid or expired.');
    }
  }, [encodedData]);

  if (parseError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6"
        style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
        <div className="text-center max-w-sm">
          <div className="text-base font-semibold text-white mb-2">Link unavailable</div>
          <div className="text-sm" style={{ color: '#6b7280' }}>{parseError}</div>
        </div>
      </div>
    );
  }

  if (!shareData) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0d16' }}>
        <div className="w-6 h-6 border-2 border-gray-700 border-t-blue-400 rounded-full animate-spin"/>
      </div>
    );
  }

  return <SingleViewerPanel item={shareData.item} girderToken={shareData.gt} apiBase={shareData.api} />;
}
