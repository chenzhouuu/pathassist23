// src/components/browser/useResponsiveColumns.js
// The measuring half of the column priority ladder. `responsiveColumns.js` decides what to drop;
// this decides how much room there is to drop it for.
//
// WHAT IS OBSERVED, AND WHY IT IS NOT THE PREVIEW. The element handed to the ref is the table's own
// container, which is `flex: 1` between the rail and the preview pane. Measuring it is what makes
// every way of changing the table's width work without this hook knowing any of them exist:
// collapsing the preview, dragging the resizer, resizing the window, and the 1100px media query
// that drops the pane entirely all arrive here as the same number changing. A hook that listened
// for the collapse instead would answer one of those four and silently miss the rest.
//
// WHY THERE IS NO FEEDBACK LOOP. The container's width is set by its siblings and its own
// `min-width: 0`, never by its contents, so hiding a column cannot change the number that decided
// to hide it. This is worth stating because it is the failure mode a ResizeObserver invites: the
// observed element must be upstream of what the observation changes.
//
// WHY THE FIRST READ IS SYNCHRONOUS. `ResizeObserver` fires its first callback after layout but
// before paint in a real browser, so an initial `null` would usually be invisible — but only
// usually, and the ref callback runs during commit where `clientWidth` is already correct. Reading
// it there costs one forced layout on mount and removes the class of bug where the table shows all
// seven columns for a frame and then sheds three.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hiddenByWidth } from './responsiveColumns.js';

/**
 * Measure a container and say which columns it has no room for.
 *
 * @param {{ id: string, min?: number, priority?: number }[]} spec the columns that would otherwise
 *   be showing; memoise it, since it is the identity this hook recomputes on.
 * @returns {[(node: HTMLElement|null) => void, string[]]} a ref callback for the container, and the
 *   ids to hide.
 */
export function useResponsiveColumns(spec) {
  const [available, setAvailable] = useState(null);
  const observer = useRef(null);

  // `clientWidth` rather than the observation's `contentRect`, so the one place the width is read
  // is the same in both paths — and because it is the number that already excludes a vertical
  // scrollbar, which a 500-row folder always has.
  const measure = useCallback((node) => {
    if (node) setAvailable(node.clientWidth);
  }, []);

  const ref = useCallback((node) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    measure(node);
    // jsdom has no ResizeObserver of its own and the test setup's stub never calls back, so the
    // width stays at the mount reading there. That is the honest answer for a headless DOM with no
    // layout: `hiddenByWidth` treats 0 as "not measured" and hides nothing.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure(node));
    ro.observe(node);
    observer.current = ro;
  }, [measure]);

  useEffect(() => () => observer.current?.disconnect(), []);

  const hidden = useMemo(() => hiddenByWidth(available, spec), [available, spec]);
  return [ref, hidden];
}
