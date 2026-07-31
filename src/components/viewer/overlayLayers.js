// src/components/viewer/overlayLayers.js — the viewer's overlay stack (Inc 4, D4).
//
// Generalises Inc 3b's single-overlay manager into an ORDERED SET. Inc 3b could get away with one
// layer because its three modes were mutually exclusive; a tissue map is a *base map* rather than a
// competing view, and "cytotoxic T cells inside the tumour region" is only visible when tissue and
// phenotype are on at once.
//
// Everything Inc 3b learned still applies and is preserved:
//
// 1. **Registration.** Layers are stored at different resolutions (tissue and markers at 1 µm/px,
//    phenotype at native), so each tileSource declares its OWN raster size and `maxLevel`, and
//    alignment comes from the world: every layer is added at `x:0, y:0, width:1`, the extent the
//    base H&E occupies. Same aspect ratio + same extent = registered, whatever the resolution.
//    Declaring the slide's dimensions and offsetting the level in getTileUrl does NOT work — OSD
//    then asks for levels finer than the layer stores, those map to a negative stored level, and
//    the map renders permanently blurred.
//
// 2. **Auth.** Tiles go through the gateway, which requires a Girder-Token header. An <img> cannot
//    set headers, so layers are mounted with `loadTilesWithAjax` and no token appears in a URL.
//
// 3. **A missing tile is a transparent PNG, never a 204** — enforced server-side; noted here
//    because it is why partial coverage does not produce a retry storm.

const TILE = 256;

// Bottom → top. Not user-controllable: tissue is areal and would bury the point-like layers.
export const LAYER_ORDER = ['tissue', 'markers', 'pheno'];

// Per-viewer state. WeakMap so a discarded viewer takes its bookkeeping with it.
const basePrefs = new WeakMap();

function orderIndex(key) {
  const i = LAYER_ORDER.indexOf(key);
  return i < 0 ? LAYER_ORDER.length : i;
}

/** A custom OSD tile source over a stored pyramid, in the LAYER's own pixel grid. */
export function buildTileSource({ slideWidth, slideHeight, levelOffset, levels, tileUrlFor }) {
  if (!slideWidth || !slideHeight || !levels) return null;
  const scale = 2 ** (levelOffset || 0);          // slide px per layer px
  return {
    width: Math.ceil(slideWidth / scale),
    height: Math.ceil(slideHeight / scale),
    tileSize: TILE,
    tileOverlap: 0,
    minLevel: 0,
    // OSD levels run 0 (coarsest, one tile) → maxLevel (1:1); ours run 0 (finest) → levels-1.
    maxLevel: levels - 1,
    getTileUrl(level, x, y) {
      return tileUrlFor(levels - 1 - level, x, y);
    },
  };
}

/** Every overlay this module currently has mounted, keyed by layer name. */
function mountedItems(viewer) {
  const out = {};
  if (!viewer?.world) return out;
  for (let i = 0; i < viewer.world.getItemCount(); i++) {
    const item = viewer.world.getItemAt(i);
    if (item?._pathassistLayerKey) out[item._pathassistLayerKey] = item;
  }
  return out;
}

/**
 * Reconcile ONE layer of the stack with what its panel is asking for.
 *
 * Idempotent by `signature`: called on every render, it does nothing unless that layer's picture
 * actually changed — which is what keeps a pan, or an unrelated panel's state update, from tearing
 * down and refetching a pyramid.
 *
 * Returns the signature now mounted for `key`.
 */
export function syncLayer(viewer, {
  key, signature, mounted, tileSource, opacity = 1, ajaxHeaders,
}) {
  if (!viewer || !viewer.world || !key) return mounted;

  const items = mountedItems(viewer);
  const existing = items[key];

  // Opacity is not part of the signature: changing it must not refetch a single tile.
  if (signature === mounted) {
    if (existing && typeof existing.setOpacity === 'function') existing.setOpacity(opacity);
    return mounted;
  }

  if (existing) viewer.world.removeItem(existing);
  if (!tileSource) return signature;

  // Insert so the world stays in LAYER_ORDER: index 0 is the H&E, then whatever is mounted that
  // sorts before this key.
  const before = Object.keys(mountedItems(viewer))
    .filter((k) => orderIndex(k) < orderIndex(key)).length;

  viewer.addTiledImage({
    tileSource,
    x: 0,
    y: 0,
    width: 1,
    index: before + 1,
    opacity,
    loadTilesWithAjax: true,
    ajaxHeaders: ajaxHeaders || {},
    success: (ev) => { if (ev?.item) ev.item._pathassistLayerKey = key; },
  });
  return signature;
}

/** Remove one layer, leaving the rest of the stack (and the H&E) alone. */
export function removeLayer(viewer, key) {
  const item = mountedItems(viewer)[key];
  if (item) viewer.world.removeItem(item);
}

/** Remove every overlay this module added, leaving the H&E (world index 0) alone. */
export function removeAllLayers(viewer) {
  if (!viewer?.world) return;
  for (let i = viewer.world.getItemCount() - 1; i >= 1; i--) {
    const item = viewer.world.getItemAt(i);
    if (item?._pathassistLayerKey) viewer.world.removeItem(item);
  }
}

/**
 * Declare how one panel would like the H&E underneath to look, and apply the resolution.
 *
 * Two panels can now be open at once, so this cannot be a plain setter — whoever rendered last
 * would win. The rule is **the dimmest request wins**: if any panel wants the histology hidden it
 * is hidden, and a panel that is the only one asking still gets exactly its own slider value.
 * Backdrop follows the same shape: the first panel in LAYER_ORDER that asks for one gets it.
 *
 * Pass `pref = null` to withdraw a panel's request (on unmount).
 */
export function setBasePreference(viewer, key, pref) {
  if (!viewer) return;
  const prefs = basePrefs.get(viewer) || {};
  if (pref === null || pref === undefined) delete prefs[key];
  else prefs[key] = pref;
  basePrefs.set(viewer, prefs);

  const keys = Object.keys(prefs).sort((a, b) => orderIndex(a) - orderIndex(b));
  const opacity = keys.reduce((m, k) => Math.min(m, prefs[k].opacity ?? 1), 1);
  const backdrop = keys.map((k) => prefs[k].backdrop).find(Boolean) || '';

  const base = viewer?.world?.getItemAt?.(0);
  if (base && typeof base.setOpacity === 'function') base.setOpacity(opacity);
  const el = viewer?.canvas || viewer?.element;
  if (el) el.style.background = backdrop;
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
