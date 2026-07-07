// Co-navigation + overlays for the PathAgent panel. All geometry in is level-0 image px.
import { heatmapUrl } from '../../api/wsiAgentApi.js';

function OSD() { return window.OpenSeadragon; }

// Pan+zoom the viewer to a level-0 px rect (with a little padding around it).
export function focusRegion(viewer, { x, y, width, height }, pad = 0.15) {
  if (!viewer?.viewport || !OSD()) return;
  const px = Math.max(0, x - width * pad);
  const py = Math.max(0, y - height * pad);
  const rect = viewer.viewport.imageToViewportRectangle(
    new (OSD().Rect)(px, py, width * (1 + 2 * pad), height * (1 + 2 * pad)));
  viewer.viewport.fitBounds(rect, false); // animated
}

// Add the heatmap PNG as a tiled image at its level-0 extent (read from the X-Level0-* headers).
// Returns { item, blobUrl } handle for later removal, or null on failure.
export async function addHeatmapOverlay(viewer, itemId, taskId, cacheKey) {
  if (!viewer?.viewport || !OSD()) return null;
  const token = localStorage.getItem('girderToken');
  const resp = await fetch(heatmapUrl(itemId, taskId, cacheKey),
                           { headers: token ? { 'Girder-Token': token } : {} });
  if (!resp.ok) throw new Error(`heatmap ${resp.status}`);
  const ext = {
    x: Number(resp.headers.get('X-Level0-X')),
    y: Number(resp.headers.get('X-Level0-Y')),
    width: Number(resp.headers.get('X-Level0-Width')),
    height: Number(resp.headers.get('X-Level0-Height')),
  };
  const blobUrl = URL.createObjectURL(await resp.blob());
  const vpRect = viewer.viewport.imageToViewportRectangle(
    new (OSD().Rect)(ext.x, ext.y, ext.width, ext.height));
  return new Promise((resolve, reject) => {
    viewer.addTiledImage({
      tileSource: { type: 'image', url: blobUrl },
      x: vpRect.x, y: vpRect.y, width: vpRect.width, opacity: 0.5,
      success: (ev) => resolve({ item: ev.item, blobUrl }),
      error: (e) => { URL.revokeObjectURL(blobUrl); reject(e); },
    });
  });
}

export function removeHeatmapOverlay(viewer, handle) {
  try { if (handle?.item && viewer?.world) viewer.world.removeItem(handle.item); } catch { /* */ }
  try { if (handle?.blobUrl) URL.revokeObjectURL(handle.blobUrl); } catch { /* */ }
}
