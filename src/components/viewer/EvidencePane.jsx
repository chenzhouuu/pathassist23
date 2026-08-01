// src/components/viewer/EvidencePane.jsx
// The right-hand pane of the Task panel's "Side By Side" mode (Inc 2c): the SAME slide with the
// evidence map blended in, viewport-locked to the main viewer.
//
// It does not re-resolve the slide. The main viewer already worked through Girder's zxy → dzi →
// thumbnail fallback; this pane reopens whichever TileSource that produced, so the two panes are
// guaranteed to be showing the same image and none of that fallback logic is duplicated.
import React, { useRef, useEffect, useState } from 'react';
import HeatmapOverlay from './HeatmapOverlay.jsx';

const OSD_OPTIONS = {
  prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
  showNavigator: false,
  showNavigationControl: false,
  maxZoomLevel: 128,
  minZoomLevel: 0.001,
  animationTime: 0.25,
  blendTime: 0.1,
  constrainDuringPan: false,
  visibilityRatio: 0.05,
  defaultZoomLevel: 0,
  zoomPerScroll: 1.5,
  maxImageCacheCount: 1000,
  imageLoaderLimit: 12,          // the main pane keeps the larger share of Girder's workers
  immediateRender: true,
  smoothTileEdgesMinZoom: Infinity,
  gestureSettingsMouse: {
    scrollToZoom: true, clickToZoom: false, dblClickToZoom: true, flickEnabled: true,
  },
};

export default function EvidencePane({ mainViewer, sync, alpha, slideKey }) {
  const containerRef = useRef(null);
  const osdRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const main = mainViewer.current;
    const source = main?.world?.getItemAt?.(0)?.source;
    if (!containerRef.current || !window.OpenSeadragon || !source) return undefined;

    const osd = window.OpenSeadragon({ element: containerRef.current, ...OSD_OPTIONS });
    osdRef.current = osd;
    const onOpen = () => {
      sync.alignTo(main, osd);      // land where the user is already looking, not at home
      sync.register(osd);
      setReady(true);
    };
    osd.addHandler('open', onOpen);
    try { osd.open(source); } catch { /* surfaced as a blank pane, not a crash */ }

    return () => {
      sync.unregister(osd);
      try { osd.removeHandler('open', onOpen); } catch { /* already gone */ }
      try { osd.destroy(); } catch { /* already gone */ }
      osdRef.current = null;
      setReady(false);
    };
    // `slideKey` (the item id) is the honest trigger for reopening: a ref's `.current` in a
    // dependency array is not tracked by React and would only re-run by coincidence.
  }, [mainViewer, sync, slideKey]);

  return (
    <div className="relative h-full" style={{ flex: '1 1 0%', minWidth: 0,
      borderLeft: '1px solid var(--border-hex)', background: 'var(--bg-viewer)' }}>
      <div ref={containerRef} className="w-full h-full" />
      {ready && <HeatmapOverlay viewer={osdRef} alpha={alpha} />}
      <span className="viewer-pane-tag">Class evidence</span>
    </div>
  );
}
