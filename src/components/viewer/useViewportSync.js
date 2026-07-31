// src/components/viewer/useViewportSync.js
// Keep N OpenSeadragon viewports locked together (Inc 2c). Extracted from CompareViewer's
// `wireSync` so the compare page and the Task panel's Side-By-Side pane share one implementation.
//
// Each viewer is wired once on registration; the handler reads the roster at call time, so a pane
// that mounts later joins without re-wiring anything (CompareViewer's original version could only
// wire after every pane was ready, and reset a `wiredRef` whenever the slide list changed).
// `syncing` is a re-entrancy guard: panning a follower fires its own `animation`, which would
// otherwise bounce straight back.
import { useCallback, useMemo, useRef } from 'react';

export default function useViewportSync() {
  const viewers = useRef([]);
  const syncing = useRef(false);
  const enabled = useRef(true);

  const broadcast = useCallback((from) => {
    if (!enabled.current || syncing.current) return;
    const others = viewers.current.filter((v) => v && v !== from);
    if (!others.length) return;
    syncing.current = true;
    try {
      const center = from.viewport.getCenter();
      const zoom = from.viewport.getZoom();
      for (const to of others) {
        try {
          to.viewport.panTo(center, true);
          to.viewport.zoomTo(zoom, null, true);
        } catch { /* a pane closing mid-animation is not an error */ }
      }
    } catch { /* the source pane closed mid-animation */ }
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  const register = useCallback((osd) => {
    if (!osd || viewers.current.includes(osd)) return;
    viewers.current.push(osd);
    osd.addHandler('animation', () => broadcast(osd));
  }, [broadcast]);

  const unregister = useCallback((osd) => {
    viewers.current = viewers.current.filter((v) => v !== osd);
  }, []);

  const reset = useCallback(() => { viewers.current = []; }, []);

  const setEnabled = useCallback((on) => { enabled.current = !!on; }, []);

  // Align a freshly-opened follower to whoever is already on screen, so a pane that mounts after
  // the user has panned doesn't start at the home position.
  const alignTo = useCallback((leader, follower) => {
    if (!leader || !follower) return;
    try {
      follower.viewport.panTo(leader.viewport.getCenter(), true);
      follower.viewport.zoomTo(leader.viewport.getZoom(), null, true);
    } catch { /* not open yet — the first animation event will sync it */ }
  }, []);

  // Stable identity: callers put this object in effect dependency arrays, and a fresh object each
  // render would tear down and rebuild their viewers on every state change.
  return useMemo(
    () => ({ register, unregister, reset, setEnabled, alignTo }),
    [register, unregister, reset, setEnabled, alignTo],
  );
}
