// Co-navigation for the viewer copilot. All geometry in is level-0 image px.

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

// The current viewport as a level-0 px rect { x, y, width, height }, injected with a turn so
// a client viewer tool can ground a deictic ask ("what's here") on where the user is looking
// (D8). Returns null if the viewer isn't ready. Mirrors ViewerToolbar's bounds→image mapping.
export function currentViewportBbox(viewer) {
  if (!viewer?.viewport) return null;
  const b = viewer.viewport.getBounds(true);
  const tl = viewer.viewport.viewportToImageCoordinates(b.x, b.y);
  const br = viewer.viewport.viewportToImageCoordinates(b.x + b.width, b.y + b.height);
  const x = Math.max(0, tl.x);
  const y = Math.max(0, tl.y);
  return { x, y, width: Math.max(0, br.x - tl.x), height: Math.max(0, br.y - tl.y) };
}
