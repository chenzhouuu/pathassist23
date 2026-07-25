// src/components/viewer/markerLayers.js — mounts the marker / phenotype pyramid on OpenSeadragon.
//
// The whole point of Inc 3b is that the virtual proteome is an *image*, not an annotation: it is a
// tile pyramid served by the biomarker service and handed to OSD exactly like the H&E, so pan,
// zoom, LOD selection and tile caching are OSD's problem and not ours. That is why there is no
// canvas, no per-frame reprojection and no vector geometry anywhere in this file.
//
// Two subtleties earn their comments:
//
// 1. **Registration (review S1).** The marker pyramid is stored at 1 µm/px and the phenotype
//    pyramid at the slide's native 0.25 µm/px, so their level-0 rasters differ by 4x. Each
//    tileSource declares its OWN raster size and its own `maxLevel`, and alignment comes from the
//    world instead: every layer is added at `x:0, y:0, width:1`, the same viewport extent the
//    base H&E occupies. Same aspect ratio + same extent = registered, whatever the resolution.
//
//    The tempting alternative — declare the slide's dimensions on both and offset the level in
//    getTileUrl — does not work: OSD then believes it can ask for levels finer than the layer
//    actually stores, those requests map to a negative stored level, and every one of them fails.
//    OSD falls back to a coarse level and the map renders permanently blurred.
//
// 2. **Auth.** Tiles go through the gateway, which requires a Girder-Token header. An <img> cannot
//    set headers, so the layer is mounted with `loadTilesWithAjax` — OSD then fetches tiles with
//    XHR and our headers, and no token ever appears in a URL.
import { tileAjaxHeaders, tileUrl } from '../../api/biomarkerApi.js';
import { layerLevels, levelOffsetFor } from '../panels/markerUtils.js';

const TILE = 256;

// A custom OSD tile source over the biomarker pyramid, in the LAYER's own pixel grid.
function buildTileSource({ itemId, artHash, layer, meta, params }) {
  const slideW = meta?.slide?.width;
  const slideH = meta?.slide?.height;
  if (!slideW || !slideH) return null;

  const scale = 2 ** levelOffsetFor(meta, layer);   // slide px per layer px
  const width = Math.ceil(slideW / scale);
  const height = Math.ceil(slideH / scale);
  const stored = layerLevels(meta, layer);

  return {
    width,
    height,
    tileSize: TILE,
    tileOverlap: 0,
    minLevel: 0,
    // OSD levels run 0 (coarsest, one tile) → maxLevel (1:1); ours run 0 (finest) → stored-1.
    maxLevel: stored - 1,
    getTileUrl(level, x, y) {
      return tileUrl(itemId, artHash, layer, stored - 1 - level, x, y, params);
    },
  };
}

/**
 * Reconcile the viewer's data layer with what the panel is asking for.
 *
 * Idempotent by `signature`: called on every render, it does nothing unless the picture actually
 * changed. That is what keeps a pan or an unrelated state update from tearing down and refetching
 * the pyramid.
 *
 * Returns the signature that is now mounted.
 */
export function syncMarkerLayer(viewer, {
  signature, mounted, itemId, artHash, layer, meta, params, opacity = 1,
}) {
  if (!viewer || !viewer.world) return mounted;
  if (signature === mounted) return mounted;

  // Drop whatever we put there before. Index 0 is the H&E, which we never touch — this panel
  // changes what is drawn ON the slide, never the slide itself.
  removeMarkerLayers(viewer);

  if (!artHash || !layer || !meta) return signature;

  const tileSource = buildTileSource({ itemId, artHash, layer, meta, params });
  if (!tileSource) return signature;

  viewer.addTiledImage({
    tileSource,
    // Same viewport extent as the base H&E (which OSD normalises to width 1) — this, not the
    // raster size, is what registers the layers against the histology.
    x: 0,
    y: 0,
    width: 1,
    opacity,
    loadTilesWithAjax: true,
    ajaxHeaders: tileAjaxHeaders(),
    success: (ev) => { if (ev?.item) ev.item._pathassistMarkerLayer = true; },
  });
  return signature;
}

/** Remove every layer this module added, leaving the H&E (world index 0) alone. */
export function removeMarkerLayers(viewer) {
  if (!viewer?.world) return;
  for (let i = viewer.world.getItemCount() - 1; i >= 1; i--) {
    const item = viewer.world.getItemAt(i);
    if (item?._pathassistMarkerLayer) viewer.world.removeItem(item);
  }
}

/** Fade the H&E itself — "remove the background" is opacity 0 on world item 0, not a new layer. */
export function setBaseOpacity(viewer, opacity) {
  const base = viewer?.world?.getItemAt?.(0);
  if (base && typeof base.setOpacity === 'function') base.setOpacity(opacity);
}

/**
 * Paint the viewer's backdrop. With the H&E faded out, an unpainted canvas shows the page
 * background through the tissue's holes; black is what makes a fluorescence composite read
 * correctly (and matches the reference figure).
 */
export function setBackdrop(viewer, colour) {
  const el = viewer?.canvas || viewer?.element;
  if (el) el.style.background = colour || '';
}

/** Level-0 slide coordinate under a viewport point — used for hover lookups. */
export function slidePointFromEvent(viewer, clientX, clientY) {
  if (!viewer?.element) return null;
  const rect = viewer.element.getBoundingClientRect();
  const pt = new window.OpenSeadragon.Point(clientX - rect.left, clientY - rect.top);
  const vp = viewer.viewport.pointFromPixel(pt);
  const img = viewer.viewport.viewportToImageCoordinates(vp);
  return { x: img.x, y: img.y };
}
