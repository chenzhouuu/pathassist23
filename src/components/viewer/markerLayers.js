// src/components/viewer/markerLayers.js — the biomarker (Inc 3b) binding onto the overlay stack.
//
// The general machinery moved to `overlayLayers.js` when Inc 4 made the viewer host more than one
// data layer at a time (D4). What stays here is only what is specific to the biomarker pyramids:
// which API builds their tile URLs, and the fact that Markers and Phenotype remain mutually
// exclusive *with each other* — they are both dense saturated pictures, so stacking the two makes
// neither readable. Either may now be stacked with the tissue map, which is areal and sits under
// both.
import { tileAjaxHeaders, tileUrl } from '../../api/biomarkerApi.js';
import { layerLevels, levelOffsetFor } from '../workspace/markers.js';
import {
  buildTileSource, removeLayer, setBasePreference, syncLayer,
} from './overlayLayers.js';

const SIBLING = { markers: 'pheno', pheno: 'markers' };

/**
 * Reconcile the biomarker layer with what the Markers panel is asking for.
 *
 * Idempotent by `signature`. Returns the signature that is now mounted.
 */
export function syncMarkerLayer(viewer, {
  signature, mounted, itemId, artHash, layer, meta, params, opacity = 1,
}) {
  if (!viewer?.world) return mounted;

  // Markers and Phenotype never coexist; whichever is not being asked for goes away.
  if (layer) removeLayer(viewer, SIBLING[layer]);
  else { removeLayer(viewer, 'markers'); removeLayer(viewer, 'pheno'); }

  if (!layer || !artHash || !meta) {
    return signature;
  }

  const tileSource = buildTileSource({
    slideWidth: meta?.slide?.width,
    slideHeight: meta?.slide?.height,
    levelOffset: levelOffsetFor(meta, layer),
    levels: layerLevels(meta, layer),
    tileUrlFor: (level, x, y) => tileUrl(itemId, artHash, layer, level, x, y, params),
  });

  return syncLayer(viewer, {
    key: layer, signature, mounted, tileSource, opacity,
    ajaxHeaders: tileAjaxHeaders(),
  });
}

/**
 * How the Markers panel would like the H&E underneath to look.
 *
 * Routed through the shared resolver rather than set directly: with a Tissue panel able to be open
 * at the same time, a plain setter would mean whichever panel rendered last won.
 */
export function setMarkersBase(viewer, pref) {
  setBasePreference(viewer, 'markers', pref);
}

/** Drop this panel's layers and withdraw its base request — on unmount or slide change. */
export function clearMarkerLayers(viewer) {
  if (!viewer?.world) return;
  removeLayer(viewer, 'markers');
  removeLayer(viewer, 'pheno');
  setBasePreference(viewer, 'markers', null);
}

export { slidePointFromEvent } from './overlayLayers.js';
