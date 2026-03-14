// src/components/share/PatientViewer.jsx
// No-auth slide viewer for patients shared via PIN-protected link.
// Layout: left panel = slide list, right panel = OSD viewer (no annotation/AI tools).
import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── OTP Form ─────────────────────────────────────────────────────────────────
function OtpForm({ patientName, folderName, onVerify, isExpired }) {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [error, setError]   = useState('');
  const [attempts, setAttempts] = useState(0);
  const inputRefs           = useRef([]);

  const handleChange = (i, val) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[i] = val.slice(-1);
    setDigits(next);
    setError('');
    if (val && i < 5) inputRefs.current[i + 1]?.focus();
  };

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) inputRefs.current[i - 1]?.focus();
  };

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (text.length === 6) {
      setDigits(text.split(''));
      setError('');
      inputRefs.current[5]?.focus();
    }
  };

  const handleVerify = () => {
    const code = digits.join('');
    if (code.length < 6) { setError('Enter all 6 digits'); return; }
    const valid = onVerify(code);
    if (!valid) {
      setAttempts(a => a + 1);
      setError(attempts >= 2 ? 'Too many attempts. Please contact your provider.' : 'Incorrect code. Try again.');
      setDigits(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6"
      style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <div className="mb-8 text-center">
        <div className="text-lg font-bold tracking-tight" style={{ color: '#4da6ff' }}>PathAssist</div>
        <div className="text-xs mt-1" style={{ color: '#4b5563' }}>Secure Patient Viewer</div>
      </div>

      <div className="w-full max-w-sm rounded-2xl p-6 flex flex-col gap-6"
        style={{ background: '#12151f', border: '1px solid #1e2537' }}>
        <div className="text-center">
          <div className="text-base font-semibold" style={{ color: '#e2e8f0' }}>Hello, {patientName}</div>
          <div className="text-sm mt-1" style={{ color: '#4b5563' }}>{folderName}</div>
          {isExpired ? (
            <div className="mt-3 px-3 py-2 rounded-lg text-sm"
              style={{ background: '#e9456018', color: '#e94560', border: '1px solid #e9456033' }}>
              This link has expired. Please contact your healthcare provider for a new link.
            </div>
          ) : (
            <div className="text-xs mt-2" style={{ color: '#4b5563' }}>
              Enter the 6-digit code from your SMS to view your slides
            </div>
          )}
        </div>

        {!isExpired && (
          <>
            <div className="flex gap-2 justify-center" onPaste={handlePaste}>
              {digits.map((d, i) => (
                <input key={i} ref={el => inputRefs.current[i] = el}
                  value={d} onChange={e => handleChange(i, e.target.value)}
                  onKeyDown={e => handleKeyDown(i, e)}
                  maxLength={1} inputMode="numeric" autoFocus={i === 0}
                  className="w-12 h-14 text-center text-xl font-bold rounded-xl outline-none transition-all"
                  style={{
                    background: d ? 'rgba(77,166,255,0.1)' : '#0a0d16',
                    border: `2px solid ${d ? '#4da6ff' : '#1e2537'}`,
                    color: '#e2e8f0', fontSize: 22,
                  }}
                />
              ))}
            </div>
            {error && <div className="text-center text-sm" style={{ color: '#e94560' }}>{error}</div>}
            <button onClick={handleVerify}
              disabled={digits.join('').length < 6 || attempts >= 3}
              className="w-full py-3 rounded-xl text-sm font-semibold transition-all"
              style={{
                background: digits.join('').length === 6 ? '#4da6ff' : '#1e2537',
                color: digits.join('').length === 6 ? '#fff' : '#4b5563',
              }}>
              View My Slides
            </button>
          </>
        )}
      </div>

      <div className="mt-8 text-xs text-center" style={{ color: '#1e2537' }}>
        PathAssist — IMPART · Secure Medical Imaging
      </div>
    </div>
  );
}

// ─── OSD Viewer Panel (embedded, not full-screen) ─────────────────────────────
function ViewerPanel({ item, girderToken, apiBase }) {
  const containerRef = useRef(null);
  const osdRef       = useRef(null);
  const [loaded, setLoaded]     = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !item) return;
    setLoaded(false);
    setLoadError(false);

    let destroyed = false;

    function initViewer() {
      if (destroyed || !containerRef.current || !window.OpenSeadragon) return;
      const osd = window.OpenSeadragon({
        element: containerRef.current,
        prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
        showNavigator: true,
        navigatorPosition: 'BOTTOM_LEFT',
        navigatorSizeRatio: 0.15,
        showNavigationControl: false,
        ajaxHeaders: { 'Girder-Token': girderToken },
        crossOriginPolicy: 'Anonymous',
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
        const done = (fn) => () => {
          if (settled) return;
          settled = true;
          osd.removeHandler('open', onOk);
          osd.removeHandler('open-failed', onFail);
          fn();
        };
        const onOk = done(resolve), onFail = done(reject);
        osd.addHandler('open', onOk);
        osd.addHandler('open-failed', onFail);
        try { osd.open(source); } catch (e) { done(reject)(); }
        setTimeout(done(reject), timeoutMs);
      });

      async function loadSlide() {
        // ── Strategy 1: ZXY tile source ──────────────────────────────────────
        try {
          const res = await fetch(`${apiBase}/item/${item._id}/tiles`, { headers: { 'Girder-Token': girderToken } });
          if (!destroyed && res.ok) {
            const info = await res.json();
            if (info?.sizeX > 0 && info?.sizeY > 0) {
              console.log('[PatientViewer] Tiles info ok, trying ZXY. sizeX:', info.sizeX, 'levels:', info.levels);
              // Probe first tile to verify actual tile serving works
              const tileProbeUrl = `${apiBase}/item/${item._id}/tiles/zxy/0/0/0?token=${girderToken}`;
              const probe = await fetch(tileProbeUrl, { headers: { 'Girder-Token': girderToken } });
              if (probe.ok && (probe.headers.get('content-type') || '').startsWith('image/')) {
                await osdOpen({
                  height: info.sizeY, width: info.sizeX,
                  tileSize: info.tileWidth || 256,
                  minLevel: 0, maxLevel: (info.levels || 1) - 1,
                  getTileUrl(level, x, y) {
                    return `${apiBase}/item/${item._id}/tiles/zxy/${level}/${x}/${y}?token=${girderToken}`;
                  },
                });
                if (!destroyed) { console.log('[PatientViewer] ZXY ok'); setLoaded(true); return; }
              } else {
                console.warn('[PatientViewer] ZXY tile probe failed, status:', probe.status);
              }
            } else {
              console.warn('[PatientViewer] No tile dimensions, sizeX:', info?.sizeX);
            }
          } else {
            console.warn('[PatientViewer] /tiles endpoint status:', res.status);
          }
        } catch (e) { console.warn('[PatientViewer] ZXY strategy failed:', e?.message); }

        if (destroyed) return;

        // ── Strategy 2: DZI ──────────────────────────────────────────────────
        try {
          console.log('[PatientViewer] Trying DZI');
          const dziUrl = `${apiBase}/item/${item._id}/tiles/dzi?token=${girderToken}`;
          await osdOpen(dziUrl);
          if (!destroyed) { console.log('[PatientViewer] DZI ok'); setLoaded(true); return; }
        } catch (e) { console.warn('[PatientViewer] DZI failed:', e?.message); }

        if (destroyed) return;

        // ── Strategy 3: Large thumbnail ───────────────────────────────────────
        try {
          console.log('[PatientViewer] Trying thumbnail fallback');
          const thumbUrl = `${apiBase}/item/${item._id}/tiles/thumbnail?width=2048&height=2048&token=${girderToken}`;
          const thumbProbe = await fetch(thumbUrl, { headers: { 'Girder-Token': girderToken } });
          if (thumbProbe.ok && (thumbProbe.headers.get('content-type') || '').startsWith('image/')) {
            await osdOpen({ type: 'image', url: thumbUrl });
            if (!destroyed) { console.log('[PatientViewer] Thumbnail ok'); setLoaded(true); return; }
          } else {
            console.warn('[PatientViewer] Thumbnail probe failed, status:', thumbProbe.status);
          }
        } catch (e) { console.warn('[PatientViewer] Thumbnail fallback failed:', e?.message); }

        if (!destroyed) { setLoadError(true); setLoaded(true); }
      }

      loadSlide();
    }

    // Load OSD from CDN if not already loaded, then init
    if (window.OpenSeadragon) {
      initViewer();
    } else {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/openseadragon.min.js';
      s.async = true;
      s.onload = initViewer;
      document.head.appendChild(s);
    }

    return () => {
      destroyed = true;
      if (osdRef.current) { osdRef.current.destroy(); osdRef.current = null; }
    };
  }, [item, girderToken, apiBase]);


  const zoom = (f) => osdRef.current?.viewport?.zoomBy(f, null, true);
  const home = () => osdRef.current?.viewport?.goHome(true);
  const fullscreen = () => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  if (!item) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3"
        style={{ background: '#08090f' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#1e2537" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <circle cx="8.5" cy="9" r="1.5"/><polyline points="21 15 16 10 5 21"/>
        </svg>
        <p className="text-sm" style={{ color: '#374151' }}>Select a slide to view</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col" style={{ background: '#08090f', minHeight: 0 }}>
      {/* Slide name bar */}
      <div className="flex items-center justify-between px-4 h-10 shrink-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #1e2537' }}>
        <span className="text-xs font-medium truncate" style={{ color: '#9ca3af' }}>{item.name}</span>
        {!loaded && (
          <div className="flex items-center gap-2 text-xs shrink-0 ml-3" style={{ color: '#4b5563' }}>
            <div className="w-3 h-3 border-2 border-gray-700 border-t-blue-400 rounded-full animate-spin"/>
            Loading…
          </div>
        )}
      </div>

      {/* OSD canvas */}
      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, touchAction: 'none' }}/>
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-sm mb-1" style={{ color: '#6b7280' }}>Could not load this slide</div>
              <div className="text-xs" style={{ color: '#374151' }}>Thumbnail or tile source unavailable</div>
            </div>
          </div>
        )}
      </div>

      {/* Zoom toolbar */}
      <div className="flex items-center justify-center gap-2 px-4 h-12 shrink-0"
        style={{ background: '#0d1117', borderTop: '1px solid #1e2537' }}>
        {[
          { title: 'Zoom in',   fn: () => zoom(1.5),  d: 'M11 8v6M8 11h6M21 21l-4.35-4.35M11 11m-8 0a8 8 0 1 0 16 0 8 8 0 0 0-16 0' },
          { title: 'Fit',       fn: home,             d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10' },
          { title: 'Zoom out',  fn: () => zoom(0.67), d: 'M8 11h6M21 21l-4.35-4.35M11 11m-8 0a8 8 0 1 0 16 0 8 8 0 0 0-16 0' },
          { title: 'Fullscreen',fn: fullscreen,       d: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3' },
        ].map(({ title, fn, d }) => (
          <button key={title} onClick={fn} title={title}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #1e2537', color: '#6b7280' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(77,166,255,0.1)'; e.currentTarget.style.color = '#4da6ff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#6b7280'; }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d={d}/>
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Split-Panel Viewer (after OTP) ───────────────────────────────────────────
function SplitViewer({ items, patientName, folderName, girderToken, apiBase }) {
  const [selected, setSelected] = useState(items[0] || null);
  const [imgErrors, setImgErrors] = useState({});

  return (
    <div className="h-screen flex flex-col" style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>

      {/* Top nav bar */}
      <div className="flex items-center gap-3 px-4 h-12 shrink-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #1e2537' }}>
        <div className="text-sm font-bold" style={{ color: '#4da6ff' }}>PathAssist</div>
        <div style={{ color: '#1e2537', fontSize: 12 }}>·</div>
        <div className="text-xs" style={{ color: '#4b5563' }}>Patient Viewer</div>
        <div className="flex-1"/>
        <div className="text-xs" style={{ color: '#374151' }}>
          Hi, <span style={{ color: '#9ca3af' }}>{patientName}</span>
        </div>
      </div>

      {/* Body: left panel + right viewer */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left panel: slide list ── */}
        <div className="flex flex-col shrink-0 overflow-hidden"
          style={{ width: 240, background: '#0d1117', borderRight: '1px solid #1e2537' }}>

          {/* Panel header */}
          <div className="px-3 py-3 shrink-0" style={{ borderBottom: '1px solid #1e2537' }}>
            <div className="text-xs font-semibold" style={{ color: '#6b7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Slides
            </div>
            <div className="text-xs mt-0.5" style={{ color: '#374151' }}>
              {folderName} · {items.length} slide{items.length !== 1 ? 's' : ''}
            </div>
          </div>

          {/* Slide list */}
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 px-3">
                <div className="text-xs text-center" style={{ color: '#374151' }}>No slides in this case</div>
              </div>
            ) : items.map((item, idx) => {
              const isActive = selected?._id === item._id;
              const thumbUrl = `${apiBase}/item/${item._id}/tiles/thumbnail?width=160&height=120&token=${girderToken}`;
              const hasErr   = imgErrors[item._id];

              return (
                <div key={item._id}
                  onClick={() => setSelected(item)}
                  className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-all"
                  style={{
                    background: isActive ? 'rgba(77,166,255,0.1)' : 'transparent',
                    borderLeft: `2px solid ${isActive ? '#4da6ff' : 'transparent'}`,
                    borderBottom: '1px solid #12151f',
                  }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>

                  {/* Thumbnail */}
                  <div className="shrink-0 rounded overflow-hidden"
                    style={{ width: 44, height: 34, background: '#12151f', border: '1px solid #1e2537' }}>
                    {!hasErr ? (
                      <img src={thumbUrl} alt="" className="w-full h-full object-cover"
                        onError={() => setImgErrors(e => ({ ...e, [item._id]: true }))}/>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.5">
                          <rect x="2" y="3" width="20" height="14" rx="2"/>
                          <circle cx="8.5" cy="9" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Name + number */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: isActive ? '#e2e8f0' : '#9ca3af' }}>
                      {item.name}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#374151', fontSize: 10 }}>
                      Slide {idx + 1}
                    </div>
                  </div>

                  {/* Active indicator */}
                  {isActive && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2.5" className="shrink-0">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 shrink-0 text-center" style={{ borderTop: '1px solid #1e2537' }}>
            <div className="text-xs" style={{ color: '#1e2537', fontSize: 10 }}>Powered by PathAssist · IMPART</div>
          </div>
        </div>

        {/* ── Right panel: viewer ── */}
        <ViewerPanel
          item={selected}
          girderToken={girderToken}
          apiBase={apiBase}
        />
      </div>
    </div>
  );
}

// ─── PatientViewer (root) ─────────────────────────────────────────────────────
export default function PatientViewer({ encodedData }) {
  const [shareData, setShareData]   = useState(null);
  const [parseError, setParseError] = useState('');
  const [verified, setVerified]     = useState(false);
  const [items, setItems]           = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [fetchError, setFetchError]     = useState('');

  useEffect(() => {
    try {
      const json = atob(encodedData);
      const data = JSON.parse(json);
      if (!data.folderId || !data.otp || !data.gt || !data.api) throw new Error('Invalid share link');
      setShareData(data);
    } catch (e) {
      setParseError('This link is invalid or has been corrupted. Please contact your healthcare provider.');
    }
  }, [encodedData]);

  async function fetchAllItems(folderId, gt, api, depth = 0) {
    const headers = { 'Girder-Token': gt };
    const itemsRes = await fetch(`${api}/item?folderId=${folderId}&limit=500&sort=name`, { headers });
    const directItems = itemsRes.ok ? await itemsRes.json() : [];
    const collected = Array.isArray(directItems) ? directItems : [];
    if (depth < 2) {
      const foldersRes = await fetch(`${api}/folder?parentType=folder&parentId=${folderId}&limit=200`, { headers });
      if (foldersRes.ok) {
        const subFolders = await foldersRes.json();
        if (Array.isArray(subFolders) && subFolders.length > 0) {
          const nested = await Promise.all(subFolders.map(sf => fetchAllItems(sf._id, gt, api, depth + 1)));
          collected.push(...nested.flat());
        }
      }
    }
    return collected;
  }

  useEffect(() => {
    if (!verified || !shareData) return;
    const { folderId, gt, api } = shareData;
    setLoadingItems(true);
    setFetchError('');
    fetchAllItems(folderId, gt, api)
      .then(all => setItems(all))
      .catch(e => {
        console.error('PatientViewer: failed to load slides', e);
        setFetchError('Could not load slides. The link may have expired.');
        setItems([]);
      })
      .finally(() => setLoadingItems(false));
  }, [verified, shareData]); // eslint-disable-line

  const handleVerify = useCallback((enteredOtp) => {
    if (!shareData) return false;
    if (enteredOtp === shareData.otp) { setVerified(true); return true; }
    return false;
  }, [shareData]);

  if (parseError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6"
        style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
        <div className="text-center max-w-sm">
          <div className="text-4xl mb-4">⚠️</div>
          <div className="text-base font-semibold text-white mb-2">Invalid Link</div>
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

  const isExpired = Date.now() > shareData.expiry;

  if (!verified) {
    return (
      <OtpForm
        patientName={shareData.patientName}
        folderName={shareData.folderName}
        onVerify={handleVerify}
        isExpired={isExpired}
      />
    );
  }

  if (loadingItems) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4"
        style={{ background: '#0a0d16' }}>
        <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-400 rounded-full animate-spin"/>
        <div className="text-sm" style={{ color: '#6b7280' }}>Loading your slides…</div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6"
        style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
        <div className="text-3xl">⚠️</div>
        <div className="text-center max-w-sm">
          <div className="text-sm font-semibold text-white mb-2">Could not load slides</div>
          <div className="text-xs" style={{ color: '#6b7280' }}>{fetchError}</div>
        </div>
        <button onClick={() => { setFetchError(''); setVerified(false); }}
          className="text-xs px-4 py-2 rounded-lg mt-2"
          style={{ background: '#1e2537', color: '#9ca3af', border: '1px solid #374151' }}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <SplitViewer
      items={items}
      patientName={shareData.patientName}
      folderName={shareData.folderName}
      girderToken={shareData.gt}
      apiBase={shareData.api}
    />
  );
}
