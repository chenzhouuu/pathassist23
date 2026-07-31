// src/components/panels/useRegionSelect.js — draw the region a panel works on.
//
// The region is shared app state (`copilotRoi`): whatever you frame is what Copilot attaches, what
// the Markers map builds over, and what the Tissue map segments. But until now the only way to
// *set* it lived inside CopilotPanel, so every other panel could read the region and none could
// ask for one — their "region" buttons sat permanently disabled with a tooltip telling the user to
// draw a box and no way to do it from the tab they were in.
//
// The handshake itself is the viewer's, unchanged: put AnnotationCanvas into `roi-select`, and it
// writes `roiSelectResult` and clears the drawing mode when the drag finishes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';

/** `{ roi, awaiting, start, cancel, clear, show }` — a panel's handle on the shared region. */
export function useRegionSelect() {
  const roi = useStore((s) => s.copilotRoi);
  const setRoi = useStore((s) => s.setCopilotRoi);
  const setShownRoi = useStore((s) => s.setShownRoi);
  const setDrawingMode = useStore((s) => s.setDrawingMode);
  const roiSelectResult = useStore((s) => s.roiSelectResult);
  const clearRoiSelectResult = useStore((s) => s.clearRoiSelectResult);
  const viewer = useStore((s) => s.viewer);
  const [awaiting, setAwaiting] = useState(false);

  const start = useCallback(() => {
    clearRoiSelectResult();
    setAwaiting(true);
    setDrawingMode('roi-select');
  }, [clearRoiSelectResult, setDrawingMode]);

  const cancel = useCallback(() => {
    setAwaiting(false);
    setDrawingMode(null);
  }, [setDrawingMode]);

  const clear = useCallback(() => {
    setRoi(null);
    setShownRoi(null);
  }, [setRoi, setShownRoi]);

  /** Bring the region back into view and paint it — for when it was framed a while ago. */
  const show = useCallback(() => {
    if (!roi) return;
    setShownRoi(roi);
    if (!viewer?.viewport) return;
    try {
      // Through the base image, not the viewport: once a tissue or marker layer is mounted the
      // world is multi-image, and `viewport.imageToViewportRectangle` both warns and silently
      // means "image 0". Naming image 0 says the region is in H&E pixels, which is what it is.
      const base = viewer.world?.getItemAt?.(0);
      const r = base
        ? base.imageToViewportRectangle(roi.x, roi.y, roi.width, roi.height)
        : viewer.viewport.imageToViewportRectangle(roi.x, roi.y, roi.width, roi.height);
      viewer.viewport.fitBounds(r, false);
    } catch { /* the viewer is between slides */ }
  }, [roi, setShownRoi, viewer]);

  // Only claim a result this panel asked for: two panels can be mounted at once, and a stale
  // `roiSelectResult` must not silently become a second panel's region.
  useEffect(() => {
    if (!awaiting || !roiSelectResult) return;
    const { x, y, width, height } = roiSelectResult;
    const next = { x, y, width, height };
    setRoi(next);
    setShownRoi(next);
    setAwaiting(false);
    clearRoiSelectResult();
  }, [awaiting, roiSelectResult, setRoi, setShownRoi, clearRoiSelectResult]);

  // Leaving the panel mid-draw must not strand the viewer in select mode — but only if *we* put
  // it there, or unmounting the panel would cancel someone else's annotation tool.
  const awaitingRef = useRef(false);
  awaitingRef.current = awaiting;
  useEffect(() => () => { if (awaitingRef.current) setDrawingMode(null); }, [setDrawingMode]);

  return { roi, awaiting, start, cancel, clear, show };
}

/** "2,048 × 2,048 px @ (41,984, 26,624)" — the region in slide pixels, where the user drew it. */
export function formatRoi(roi) {
  if (!roi) return '';
  const n = (v) => Math.round(v).toLocaleString();
  return `${n(roi.width)} × ${n(roi.height)} px @ (${n(roi.x)}, ${n(roi.y)})`;
}
