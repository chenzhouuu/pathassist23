// src/components/share/PatientViewer.jsx
// Mobile-optimized, no-auth slide viewer for patients.
// Accessed via: {origin}/#/patient/{base64(shareData)}
// Patient enters OTP from SMS → sees gallery of all slides in their folder → taps to view.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import OpenSeadragon from 'openseadragon';

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
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      inputRefs.current[i - 1]?.focus();
    }
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

      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="text-lg font-bold tracking-tight" style={{ color: '#4da6ff' }}>PathAssist</div>
        <div className="text-xs mt-1" style={{ color: '#4b5563' }}>Secure Patient Viewer</div>
      </div>

      <div className="w-full max-w-sm rounded-2xl p-6 flex flex-col gap-6"
        style={{ background: '#12151f', border: '1px solid #1e2537' }}>

        {/* Greeting */}
        <div className="text-center">
          <div className="text-base font-semibold" style={{ color: '#e2e8f0' }}>
            Hello, {patientName}
          </div>
          <div className="text-sm mt-1" style={{ color: '#4b5563' }}>
            {folderName}
          </div>
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
            {/* OTP inputs */}
            <div className="flex gap-2 justify-center" onPaste={handlePaste}>
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={el => inputRefs.current[i] = el}
                  value={d}
                  onChange={e => handleChange(i, e.target.value)}
                  onKeyDown={e => handleKeyDown(i, e)}
                  maxLength={1}
                  inputMode="numeric"
                  autoFocus={i === 0}
                  className="w-12 h-14 text-center text-xl font-bold rounded-xl outline-none transition-all"
                  style={{
                    background: d ? 'rgba(77,166,255,0.1)' : '#0a0d16',
                    border: `2px solid ${d ? '#4da6ff' : '#1e2537'}`,
                    color: '#e2e8f0',
                    fontSize: 22,
                  }}
                />
              ))}
            </div>

            {error && (
              <div className="text-center text-sm" style={{ color: '#e94560' }}>{error}</div>
            )}

            <button
              onClick={handleVerify}
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

// ─── Slide OSD Viewer ─────────────────────────────────────────────────────────
function SlideViewer({ item, girderToken, apiBase, onBack }) {
  const containerRef = useRef(null);
  const osdRef       = useRef(null);
  const [loaded, setLoaded]   = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !item) return;

    const osd = OpenSeadragon({
      element: containerRef.current,
      prefixUrl: 'https://openseadragon.github.io/openseadragon/images/',
      showNavigator: true,
      navigatorPosition: 'BOTTOM_LEFT',
      navigatorSizeRatio: 0.18,
      showNavigationControl: false,
      // Pass auth token via header for all OSD ajax requests (tile fetches)
      ajaxHeaders: { 'Girder-Token': girderToken },
      crossOriginPolicy: 'Anonymous',
      gestureSettingsTouch: {
        pinchToZoom:    true,
        flickEnabled:   true,
        scrollToZoom:   false,
        clickToZoom:    false,
        dblClickToZoom: true,
      },
      gestureSettingsMouse: {
        scrollToZoom:   true,
        clickToZoom:    false,
        dblClickToZoom: true,
      },
      animationTime: 0.3,
      minZoomImageRatio: 0.3,
      maxZoomPixelRatio: 16,
      visibilityRatio: 0.2,
      zoomPerScroll: 1.3,
      zoomPerClick: 2,
    });
    osdRef.current = osd;

    // `destroyed` prevents state updates after cleanup (React Strict Mode double-invoke safe)
    let destroyed = false;

    // Promise wrapper — settled flag + timeout mirrors ViewerPanel's osdOpen
    const osdOpen = (source, timeoutMs = 15000) => new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn) => () => {
        if (settled) return;
        settled = true;
        osd.removeHandler('open', onOk);
        osd.removeHandler('open-failed', onFail);
        fn();
      };
      const onOk   = done(resolve);
      const onFail = done(reject);
      osd.addHandler('open', onOk);
      osd.addHandler('open-failed', onFail);
      try { osd.open(source); } catch (e) { done(reject)(); }
      setTimeout(done(reject), timeoutMs);
    });

    async function loadSlide() {
      // Strategy 1: ZXY custom tile source (mirrors ViewerPanel — most reliable with Girder auth)
      // DZI is NOT used: OSD constructs tile URLs from XML without appending the auth token.
      try {
        const res = await fetch(`${apiBase}/item/${item._id}/tiles`, {
          headers: { 'Girder-Token': girderToken },
        });
        if (!destroyed && res.ok) {
          const info = await res.json();
          if (info?.sizeX > 0 && info?.sizeY > 0) {
            const zxy = {
              height:   info.sizeY,
              width:    info.sizeX,
              tileSize: info.tileWidth || 256,
              minLevel: 0,
              maxLevel: (info.levels || 1) - 1,
              getTileUrl(level, x, y) {
                return `${apiBase}/item/${item._id}/tiles/zxy/${level}/${x}/${y}?token=${girderToken}`;
              },
            };
            await osdOpen(zxy);
            if (!destroyed) { setLoaded(true); return; }
          }
        }
      } catch (e) { console.warn('[PatientViewer] ZXY strategy failed:', e?.message); }

      if (destroyed) return;

      // Strategy 2: large thumbnail fallback
      try {
        const thumbUrl = `${apiBase}/item/${item._id}/tiles/thumbnail?width=2048&height=2048&token=${girderToken}`;
        await osdOpen({ type: 'image', url: thumbUrl });
        if (!destroyed) { setLoaded(true); return; }
      } catch (e) { console.warn('[PatientViewer] Thumbnail strategy failed:', e?.message); }

      if (!destroyed) { setLoadError(true); setLoaded(true); }
    }

    loadSlide();
    return () => { destroyed = true; osd.destroy(); };
  }, [item, girderToken, apiBase]);

  const zoom = (f) => osdRef.current?.viewport?.zoomBy(f, null, true);
  const home = () => osdRef.current?.viewport?.goHome(true);
  const fullscreen = () => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: '#000', zIndex: 100 }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-12 shrink-0 z-10"
        style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(10px)' }}>
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all"
          style={{ color: '#9ca3af', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          All Slides
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-white truncate">{item.name}</div>
        </div>
        {!loaded && (
          <div className="flex items-center gap-2 text-xs" style={{ color: '#9ca3af' }}>
            <div className="w-3 h-3 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin"/>
            Loading…
          </div>
        )}
      </div>

      {/* OSD Container */}
      <div className="flex-1 relative">
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, touchAction: 'none' }}/>
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-gray-500 text-sm">Could not load this slide</div>
              <button onClick={onBack} className="mt-3 text-xs text-blue-400">← Back to gallery</button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="flex items-center justify-center gap-3 px-4 h-14 shrink-0"
        style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)' }}>
        {[
          { title: 'Zoom in',  fn: () => zoom(1.5), icon: 'M11 8v6M8 11h6M21 21l-4.35-4.35M11 11m-8 0a8 8 0 1 0 16 0 8 8 0 0 0-16 0' },
          { title: 'Fit',      fn: home,            icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10' },
          { title: 'Zoom out', fn: () => zoom(0.67),icon: 'M8 11h6M21 21l-4.35-4.35M11 11m-8 0a8 8 0 1 0 16 0 8 8 0 0 0-16 0' },
          { title: 'Fullscreen',fn: fullscreen,     icon: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3' },
        ].map(({ title, fn, icon }) => (
          <button key={title} onClick={fn} title={title}
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-95"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: '#e2e8f0' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d={icon}/>
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Slide Gallery ────────────────────────────────────────────────────────────
function SlideGallery({ items, patientName, folderName, girderToken, apiBase, onSelectSlide }) {
  const [imgErrors, setImgErrors] = useState({});

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0a0d16', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      {/* Header */}
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-sm font-bold" style={{ color: '#4da6ff' }}>PathAssist</div>
          <div className="text-gray-700 text-xs">·</div>
          <div className="text-xs" style={{ color: '#4b5563' }}>Patient Viewer</div>
        </div>
        <h1 className="text-xl font-bold mt-2" style={{ color: '#e2e8f0' }}>
          Hi, {patientName}
        </h1>
        <p className="text-sm mt-1" style={{ color: '#6b7280' }}>
          {folderName}
          <span className="ml-2 font-mono" style={{ color: '#374151' }}>{items.length} slide{items.length !== 1 ? 's' : ''}</span>
        </p>
      </div>

      {/* Slides grid */}
      <div className="flex-1 px-4 pb-8">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#1e2537' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <circle cx="8.5" cy="9" r="1.5"/><polyline points="21 15 16 10 5 21"/>
              </svg>
            </div>
            <p className="text-sm text-center" style={{ color: '#4b5563' }}>No slides in this case</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {items.map((item, idx) => {
              const thumbUrl = `${apiBase}/item/${item._id}/tiles/thumbnail?width=400&height=300&token=${girderToken}`;
              const hasError = imgErrors[item._id];
              return (
                <div key={item._id}
                  className="relative rounded-2xl overflow-hidden cursor-pointer active:scale-95 transition-transform"
                  style={{ background: '#12151f', border: '1px solid #1e2537', aspectRatio: '4/3' }}
                  onClick={() => onSelectSlide(item)}>
                  {!hasError ? (
                    <img src={thumbUrl} alt={item.name}
                      onError={() => setImgErrors(e => ({ ...e, [item._id]: true }))}
                      className="w-full h-full object-cover"/>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.5">
                        <rect x="2" y="3" width="20" height="14" rx="2"/>
                        <circle cx="8.5" cy="9" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                      </svg>
                    </div>
                  )}

                  {/* Slide number badge */}
                  <div className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                    style={{ background: 'rgba(0,0,0,0.6)', color: '#9ca3af', border: '1px solid rgba(255,255,255,0.1)' }}>
                    {idx + 1}
                  </div>

                  {/* Open icon overlay */}
                  <div className="absolute inset-0 flex items-end justify-end p-2 opacity-0 hover:opacity-100 transition-opacity"
                    style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)' }}>
                    <div className="flex items-center gap-1 text-xs text-white px-2 py-1 rounded-lg"
                      style={{ background: 'rgba(77,166,255,0.3)', border: '1px solid rgba(77,166,255,0.4)' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                      </svg>
                      View
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="pb-6 text-center text-xs" style={{ color: '#1e2537' }}>
        Powered by PathAssist · IMPART
      </div>
    </div>
  );
}

// ─── PatientViewer (root) ─────────────────────────────────────────────────────
export default function PatientViewer({ encodedData }) {
  const [shareData, setShareData] = useState(null);
  const [parseError, setParseError] = useState('');
  const [verified, setVerified]   = useState(false);
  const [items, setItems]         = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [fetchError, setFetchError]     = useState('');
  const [selectedSlide, setSelectedSlide] = useState(null);

  // Parse share data from URL
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

  // Recursively collect all items from a folder and its sub-folders.
  // Mirrors the WorklistPage's 2-level folder loading strategy.
  async function fetchAllItems(folderId, gt, api, depth = 0) {
    const headers = { 'Girder-Token': gt };
    // Items directly in this folder
    const itemsRes = await fetch(`${api}/item?folderId=${folderId}&limit=500&sort=name`, { headers });
    const directItems = itemsRes.ok ? await itemsRes.json() : [];
    const collected = Array.isArray(directItems) ? directItems : [];

    // Sub-folders (go 2 levels deep — same as worklist)
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

  // Load items after OTP verification
  useEffect(() => {
    if (!verified || !shareData) return;
    const { folderId, gt, api } = shareData;
    setLoadingItems(true);
    setFetchError('');
    fetchAllItems(folderId, gt, api)
      .then(all => setItems(all))
      .catch(e => {
        console.error('PatientViewer: failed to load slides', e);
        setFetchError('Could not load slides. The link may have expired or the session ended.');
        setItems([]);
      })
      .finally(() => setLoadingItems(false));
  }, [verified, shareData]); // eslint-disable-line

  const handleVerify = useCallback((enteredOtp) => {
    if (!shareData) return false;
    if (enteredOtp === shareData.otp) {
      setVerified(true);
      return true;
    }
    return false;
  }, [shareData]);

  // Error state
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

  // OTP entry
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

  // Loading items
  if (loadingItems) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4"
        style={{ background: '#0a0d16' }}>
        <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-400 rounded-full animate-spin"/>
        <div className="text-sm" style={{ color: '#6b7280' }}>Loading your slides…</div>
      </div>
    );
  }

  // Single slide viewer
  if (selectedSlide) {
    return (
      <SlideViewer
        item={selectedSlide}
        girderToken={shareData.gt}
        apiBase={shareData.api}
        onBack={() => setSelectedSlide(null)}
      />
    );
  }

  // Fetch error
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

  // Gallery
  return (
    <SlideGallery
      items={items}
      patientName={shareData.patientName}
      folderName={shareData.folderName}
      girderToken={shareData.gt}
      apiBase={shareData.api}
      onSelectSlide={setSelectedSlide}
    />
  );
}
