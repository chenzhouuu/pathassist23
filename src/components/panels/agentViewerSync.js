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
