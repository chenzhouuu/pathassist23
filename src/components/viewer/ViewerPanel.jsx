// src/components/viewer/ViewerPanel.jsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import {
  getTilesInfoSafe, getDziUrl, getItemFiles, getFileDownloadUrl,
  createItemTiles, getJob,
} from '../../api/index.js';
import AnnotationCanvas from '../annotations/AnnotationCanvas.jsx';
import ViewerToolbar from './ViewerToolbar.jsx';
import MagnificationBar from './MagnificationBar.jsx';
import { GIRDER_BASE } from '../../config/girder.js';

const LARGE_IMAGE_EXTS = ['svs','ndpi','scn','czi','lif','qptiff','tiff','tif','btf','tf2','tf8','mrxs','vms','vmu','vsf','ome.tif','ome.tiff'];
const IMAGE_EXTS = ['jpg','jpeg','png','gif','bmp','webp'];

function getExt(name='') { return name.split('.').pop().toLowerCase(); }
function isImageExt(name) { return IMAGE_EXTS.includes(getExt(name)); }
function isWSIExt(name) { return LARGE_IMAGE_EXTS.includes(getExt(name)); }

function StatusBadge({ type, label }) {
  const cfg = {
    wsi:   { bg:'rgba(76,175,130,0.15)', border:'rgba(76,175,130,0.3)', c:'#4caf82' },
    image: { bg:'rgba(77,166,255,0.15)', border:'rgba(77,166,255,0.3)', c:'#4da6ff' },
    file:  { bg:'rgba(245,166,35,0.15)', border:'rgba(245,166,35,0.3)', c:'#f5a623' },
  }[type] || { bg:'rgba(77,166,255,0.15)', border:'rgba(77,166,255,0.3)', c:'#4da6ff' };
  return (
    <span className="text-xs px-2 py-0.5 rounded font-mono"
      style={{ background:cfg.bg, border:`1px solid ${cfg.border}`, color:cfg.c }}>
      {label}
    </span>
  );
}

// Poll a Girder job until it reaches a terminal status.
// Resolves with the final job object; rejects on error/timeout.
async function pollJob(jobId, { onProgress, intervalMs = 2000, maxWaitMs = 300_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const job = await getJob(jobId);
    // Girder job statuses: 0=inactive, 1=queued, 2=running, 3=success, 4=error, 5=canceled
    if (onProgress) onProgress(job);
    if (job.status === 3) return job;
    if (job.status === 4 || job.status === 5) {
      throw new Error(job.log?.slice(-1)[0] || `Job ${job.status === 4 ? 'failed' : 'cancelled'}`);
    }
  }
  throw new Error('Tile creation timed out (5 min). Check Girder jobs.');
}

export default function ViewerPanel() {
  const containerRef = useRef(null);
  const osdRef = useRef(null);
  const osdReady = useRef(false);
  const pendingLoad = useRef(null);

  const { activeItem, setViewer, setTilesInfo, tilesInfo } = useStore();
  const [status, setStatus] = useState({ state:'idle', msg:'', type:null, files:null });
  const [zoom, setZoom] = useState('—');

  // ── Init OSD ────────────────────────────────────────────────────────────────
  const initOSD = useCallback(() => {
    if (osdRef.current || !containerRef.current || !window.OpenSeadragon) return;
    const token = localStorage.getItem('girderToken') || '';
    osdRef.current = window.OpenSeadragon({
      element: containerRef.current,
      prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
      showNavigator: true,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorHeight: '90px',
      navigatorWidth: '130px',
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
      gestureSettingsMouse: { scrollToZoom:true, clickToZoom:false, dblClickToZoom:true, flickEnabled:true },
    });
    setViewer(osdRef.current);
    osdReady.current = true;
    osdRef.current.addHandler('zoom', (e) => setZoom(e.zoom ? e.zoom.toFixed(3) : '—'));
    if (pendingLoad.current) {
      const item = pendingLoad.current;
      pendingLoad.current = null;
      loadSlide(item);
    }
  }, []);

  useEffect(() => {
    if (window.OpenSeadragon) { initOSD(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/openseadragon.min.js';
    s.async = true;
    s.onload = initOSD;
    document.head.appendChild(s);
    return () => { try { document.head.removeChild(s); } catch(_){} };
  }, [initOSD]);

  // ── Helper: open OSD and wait for open/open-failed ──────────────────────────
  const osdOpen = (source, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const osd = osdRef.current;
    let settled = false;
    const ok   = () => { if(settled) return; settled=true; osd.removeHandler('open', ok); osd.removeHandler('open-failed', fail); resolve(); };
    const fail = (e) => { if(settled) return; settled=true; osd.removeHandler('open', ok); osd.removeHandler('open-failed', fail); reject(new Error(e?.message || 'open-failed')); };
    osd.addHandler('open', ok);
    osd.addHandler('open-failed', fail);
    osd.open(source);
    setTimeout(() => { if(!settled) { settled=true; osd.removeHandler('open', ok); osd.removeHandler('open-failed', fail); reject(new Error('timeout')); } }, timeoutMs);
  });

  // ── Try to open a large_image item that already has tiles info ───────────────
  const openWithTiles = useCallback(async (item, info) => {
    const token = localStorage.getItem('girderToken') || '';
    setTilesInfo(info);

    // ZXY custom tileSource — most reliable with Girder auth
    try {
      console.log('[Viewer] Trying ZXY tileSource');
      const zxy = {
        height: info.sizeY,
        width: info.sizeX,
        tileSize: info.tileWidth || 256,
        minLevel: 0,
        maxLevel: (info.levels || 1) - 1,
        getTileUrl(level, x, y) {
          return `${GIRDER_BASE}/item/${item._id}/tiles/zxy/${level}/${x}/${y}${token ? `?token=${token}` : ''}`;
        },
      };
      await osdOpen(zxy, 15000);
      setStatus({ state:'ok', msg:item.name, type:'wsi', files:null });
      return true;
    } catch(e) { console.warn('[Viewer] ZXY failed:', e.message); }

    // DZI fallback
    try {
      console.log('[Viewer] Trying DZI');
      const dziUrl = getDziUrl(item._id);
      await osdOpen(dziUrl, 15000);
      setStatus({ state:'ok', msg:item.name, type:'wsi', files:null });
      return true;
    } catch(e) { console.warn('[Viewer] DZI failed:', e.message); }

    // Large thumbnail last resort
    try {
      console.log('[Viewer] Falling back to large thumbnail');
      const thumbBig = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=4096&height=4096${token ? `&token=${token}` : ''}`;
      await osdOpen({ type:'image', url: thumbBig }, 15000);
      setStatus({ state:'ok', msg:`${item.name} (thumbnail — tiles failed)`, type:'image', files:null });
      return true;
    } catch(e) { console.warn('[Viewer] Large thumbnail failed:', e.message); }

    return false;
  }, [setTilesInfo]);

  // ── Main load function ──────────────────────────────────────────────────────
  const loadSlide = useCallback(async (item) => {
    if (!item) return;

    const osd = osdRef.current;
    if (!osd) { pendingLoad.current = item; return; }

    setStatus({ state:'loading', msg:`Loading ${item.name}…`, type:null, files:null });
    setTilesInfo(null);

    // Keep token fresh in OSD ajax headers
    const token = localStorage.getItem('girderToken') || '';
    if (osd.ajaxHeaders) osd.ajaxHeaders['Girder-Token'] = token;

    // ── STRATEGY 1: large_image tiles ──────────────────────────────────────
    try {
      const info = await getTilesInfoSafe(item._id);

      if (info && info.sizeX > 0 && info.sizeY > 0) {
        console.log('[Viewer] large_image tiles info:', info);
        const ok = await openWithTiles(item, info);
        if (ok) return;
        // Tiles info existed but all open methods failed — fall through
      } else if (isWSIExt(item.name)) {
        // WSI format but no tiles registered yet → show "create tiles" UI
        setStatus({ state:'notiles', msg:item.name, type:'wsi', files:null });
        return;
      }
    } catch(e) {
      console.log('[Viewer] Tiles info error:', e.message);
      if (isWSIExt(item.name)) {
        setStatus({ state:'notiles', msg:item.name, type:'wsi', files:null });
        return;
      }
    }

    // ── STRATEGY 2: thumbnail probe ─────────────────────────────────────────
    const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=2048&height=2048${token ? `&token=${token}` : ''}`;
    try {
      const probe = await fetch(thumbUrl, { headers: { 'Girder-Token': token } });
      if (probe.ok && (probe.headers.get('content-type')||'').startsWith('image/')) {
        await osdOpen({ type:'image', url: thumbUrl }, 10000);
        setStatus({ state:'ok', msg:`${item.name} (thumbnail)`, type:'image', files:null });
        return;
      }
    } catch(e) { console.warn('[Viewer] Thumbnail strategy failed:', e.message); }

    // ── STRATEGY 3: direct file download for plain images ──────────────────
    try {
      const files = await getItemFiles(item._id);
      if (files?.length > 0) {
        for (const f of files) {
          if (isImageExt(f.name) || isWSIExt(f.name)) {
            const url = getFileDownloadUrl(f._id);
            try {
              await osdOpen({ type:'image', url }, 10000);
              setStatus({ state:'ok', msg:`${item.name} → ${f.name}`, type: isWSIExt(f.name) ? 'wsi' : 'image', files:null });
              return;
            } catch(e) { console.warn('[Viewer] Direct file failed:', e.message); }
          }
        }
        setStatus({ state:'nopreview', msg:`Not previewable: ${files.map(f=>f.name).join(', ')}`, type:'file', files });
        return;
      }
    } catch(e) { console.warn('[Viewer] Files endpoint failed:', e.message); }

    setStatus({ state:'error', msg:'No viewable content found. The item may be empty or unsupported.', type:'error', files:null });
  }, [setTilesInfo, openWithTiles]);

  // ── Create large_image tiles and wait for the job ───────────────────────────
  const handleCreateTiles = useCallback(async () => {
    if (!activeItem) return;
    setStatus({ state:'processing', msg:'Requesting tile creation…', type:'wsi', files:null, progress:null });
    try {
      const job = await createItemTiles(activeItem._id);
      const jobId = job?._id;
      if (!jobId) {
        // Some Girder setups return the tiles info directly (already processed)
        loadSlide(activeItem);
        return;
      }

      await pollJob(jobId, {
        onProgress: (j) => {
          const pct = j.progress?.current && j.progress?.total
            ? Math.round((j.progress.current / j.progress.total) * 100)
            : null;
          setStatus(s => ({
            ...s,
            msg: pct != null
              ? `Processing tiles… ${pct}%`
              : `Processing tiles… (${['inactive','queued','running'][j.status] ?? 'working'})`,
            progress: pct,
          }));
        },
        intervalMs: 2500,
        maxWaitMs: 300_000,
      });

      // Job succeeded — reload
      setStatus(s => ({ ...s, msg:'Tiles ready, loading…' }));
      await loadSlide(activeItem);
    } catch(err) {
      console.error('[Viewer] Tile creation failed:', err);
      setStatus({
        state:'error',
        msg: `Tile creation failed: ${err.message}`,
        type:'error',
        files:null,
      });
    }
  }, [activeItem, loadSlide]);

  useEffect(() => {
    if (!activeItem) {
      setStatus({ state:'idle', msg:'', type:null, files:null });
      return;
    }
    loadSlide(activeItem);
  }, [activeItem?._id, loadSlide]);

  const retry = () => activeItem && loadSlide(activeItem);

  const isProcessing = status.state === 'processing';

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background:'#060709' }}>
      <ViewerToolbar viewer={osdRef} />

      <div className="flex-1 relative overflow-hidden">

        {/* Idle */}
        {status.state === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 select-none" style={{ background:'#060709' }}>
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#1a1e2e" strokeWidth="1" className="mb-5">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <circle cx="8" cy="10" r="2"/><polyline points="21 15 16 10 5 21"/>
              <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <p className="text-sm font-medium" style={{ color:'#252a3e' }}>Select a slide to view</p>
            <p className="text-xs mt-1" style={{ color:'#181c2a' }}>Collections → Folders → Items</p>
          </div>
        )}

        {/* Loading */}
        {status.state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
            style={{ background:'rgba(6,7,9,0.9)' }}>
            <div className="flex flex-col items-center gap-3">
              <div className="spinner" style={{ width:32, height:32, borderWidth:3 }}/>
              <span className="text-xs text-gray-400 font-mono max-w-xs text-center">{status.msg}</span>
              <span className="text-xs text-gray-600">Trying tile sources…</span>
            </div>
          </div>
        )}

        {/* No large_image tiles yet — WSI format detected */}
        {status.state === 'notiles' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-4 px-6" style={{ background:'#060709' }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <circle cx="8" cy="10" r="2"/><polyline points="21 15 16 10 5 21"/>
            </svg>
            <div className="text-center space-y-1">
              <p className="text-sm font-semibold text-gray-300">Slide not yet processed</p>
              <p className="text-xs text-gray-500 max-w-xs">
                <span className="font-mono text-gray-400">{status.msg}</span> is a whole-slide image but
                has not been registered as a large image source in Girder.
              </p>
            </div>
            <button
              onClick={handleCreateTiles}
              className="flex items-center gap-2 text-xs px-4 py-2 rounded-lg transition-all"
              style={{ background:'rgba(245,166,35,0.15)', color:'#f5a623', border:'1px solid rgba(245,166,35,0.35)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              Initialize large image tiles
            </button>
            <button onClick={retry} className="text-xs text-gray-600 underline">
              Try loading again (if already processed)
            </button>
          </div>
        )}

        {/* Processing / tile creation in progress */}
        {isProcessing && (
          <div className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background:'rgba(6,7,9,0.95)' }}>
            <div className="flex flex-col items-center gap-4 max-w-xs w-full px-6">
              <div className="spinner" style={{ width:36, height:36, borderWidth:3, borderTopColor:'#f5a623' }}/>
              <p className="text-xs text-gray-400 font-mono text-center">{status.msg}</p>
              {status.progress != null && (
                <div className="w-full">
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background:'rgba(255,255,255,0.08)' }}>
                    <div className="h-full rounded-full transition-all"
                      style={{ width:`${status.progress}%`, background:'#f5a623' }}/>
                  </div>
                  <div className="text-xs text-gray-600 text-right mt-1 font-mono">{status.progress}%</div>
                </div>
              )}
              <p className="text-xs text-gray-700 text-center">
                Large SVS/NDPI files can take several minutes to process. This page will update automatically.
              </p>
            </div>
          </div>
        )}

        {/* No preview */}
        {status.state === 'nopreview' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3" style={{ background:'#060709' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3a4060" strokeWidth="1.5">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <p className="text-sm text-gray-500">No image preview available</p>
            <p className="text-xs text-gray-600 max-w-xs text-center">{status.msg}</p>
            {status.files?.map(f => (
              <a key={f._id} href={getFileDownloadUrl(f._id)} download
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ background:'rgba(77,166,255,0.1)', color:'#4da6ff', border:'1px solid rgba(77,166,255,0.2)' }}>
                ↓ Download {f.name} ({(f.size/1024).toFixed(0)} KB)
              </a>
            ))}
          </div>
        )}

        {/* Error */}
        {status.state === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3" style={{ background:'#060709' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#e94560" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p className="text-sm text-red-400">Failed to load item</p>
            <p className="text-xs text-gray-600 max-w-sm text-center px-4">{status.msg}</p>
            <div className="flex gap-2 mt-1">
              <button onClick={retry}
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ background:'rgba(233,69,96,0.1)', color:'#e94560', border:'1px solid rgba(233,69,96,0.2)' }}>
                Retry
              </button>
              {isWSIExt(activeItem?.name) && (
                <button onClick={handleCreateTiles}
                  className="text-xs px-3 py-1.5 rounded transition-colors"
                  style={{ background:'rgba(245,166,35,0.1)', color:'#f5a623', border:'1px solid rgba(245,166,35,0.2)' }}>
                  Initialize tiles
                </button>
              )}
            </div>
          </div>
        )}

        {/* OSD container — always mounted */}
        <div ref={containerRef} id="osd-viewer" className="w-full h-full"
          style={{ opacity: status.state === 'ok' ? 1 : 0, transition:'opacity 0.3s' }}/>

        {/* Annotation canvas */}
        {activeItem && status.state === 'ok' && <AnnotationCanvas viewer={osdRef}/>}

        {/* Status bar */}
        {status.state === 'ok' && (
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center gap-3 px-3 py-1.5"
            style={{ background:'rgba(6,7,9,0.8)', backdropFilter:'blur(4px)', borderTop:'1px solid rgba(30,33,48,0.6)' }}>
            <StatusBadge type={status.type} label={status.type === 'wsi' ? 'WSI' : status.type === 'image' ? 'Image' : 'File'}/>
            <span className="text-xs text-gray-500 truncate flex-1">{status.msg}</span>
            <span className="text-xs font-mono text-gray-600 shrink-0">z:{zoom}</span>
          </div>
        )}
      </div>

      {tilesInfo && <MagnificationBar viewer={osdRef} tilesInfo={tilesInfo}/>}
    </div>
  );
}
