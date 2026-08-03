// src/components/browser/usePreviewResize.js
// How wide the preview pane is, whether it is showing at all, and the drag that changes the first
// of those.
//
// WHY THIS IS A HOOK AND NOT STATE IN BrowserPage. None of it is about the page. It is pointer
// arithmetic, a clamp and two storage keys, and all three are miserable to verify through a
// component: proving the clamp holds at 15% of the window means either a real layout engine or a
// mocked one, and a mocked layout only ever proves the mock. Lifted out, every rule below is a
// function call in a test, and BrowserPage is left with one line and a spread.
//
// THE RECIPE IS OHIF'S, for the same pane in its StudyList (`platform/app/src/routes/WorkList`,
// MIT) — one default width, a clamp expressed as a *fraction of the viewport* rather than in
// pixels, and the choice remembered between visits. The fraction is the part worth copying. A pane
// clamped to "at least 200px" is a third of a 640px window and a rounding error on a 3840px one;
// what the user is choosing is the proportion, so that is what the limits are written in.
//
// WHY THE USER'S NUMBER IS STORED AND THE CLAMP IS DERIVED. The two are separate on purpose. A
// width chosen at 1920px can be half the window at 1280px, so the *rendered* width is clamped
// against whatever the window is now — but the stored number is left alone, and widening the
// window back gives the original choice back. Clamping on the way into storage instead would let a
// single visit on a laptop quietly shrink a choice the user made on a monitor, with nothing on
// screen to say it had happened. A commit (a drag, an arrow key) does clamp before it stores,
// because that gesture was aimed at the window that is actually there.
//
// WHY POINTER EVENTS AND CAPTURE, NOT mousemove ON window. `setPointerCapture` redirects every
// later event for that pointer to the element that took it, so the drag survives the pointer
// leaving the 5px strip, entering an iframe, or crossing the OpenSeadragon canvas — none of which a
// listener on the resizer alone survives, and all of which a listener on `window` has to be torn
// down by hand afterwards. Capture also releases itself on `pointercancel` and on the pointer being
// stolen, which is the case the hand-rolled version in the Viewer's `RightPanel` gets wrong: it
// leaves a stuck drag if the gesture is interrupted. That one is out of scope here and stays.
//
// WHY localStorage AND NOT OHIF's sessionStorage. Upstream forgets the pane between tabs; the
// choice here is a workstation preference sitting beside the light/dark mode, and it is remembered
// the same way and under the same namespace — see useSurfaceTheme.js for the key convention.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const WIDTH_KEY = 'pathassist.browser.previewWidth';
export const COLLAPSED_KEY = 'pathassist.browser.previewCollapsed';

export const DEFAULT_WIDTH = 320;
export const MIN_FRACTION = 0.15;
export const MAX_FRACTION = 0.5;

// One arrow press moves the edge by a step a user can see landing; holding Shift moves it by the
// distance a pointer drag covers in one flick. Both are round numbers rather than tokens because
// they are a gesture's granularity, not a layout measurement.
const STEP = 16;
const STEP_COARSE = 64;

function viewportWidth() {
  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

/**
 * The pane's width, held between 15% and 50% of the window.
 *
 * Zero and negative widths are clamped up to the minimum rather than rejected, and the difference
 * matters: dragging the edge past the right of the window asks for a negative width, and the honest
 * answer to that gesture is the narrowest pane the clamp allows. Treating it as nonsense and
 * falling back to the default would make the pane jump *outward* at the exact moment the user is
 * pushing it closed. Deciding that a number is nonsense at all is `readStoredWidth`'s job, because
 * only storage can hand this a value that was never a gesture.
 *
 * @param {number} width  the wanted width in CSS pixels.
 * @param {number} viewport  the window's current width.
 * @returns {number} the width to render.
 */
export function clampWidth(width, viewport) {
  const wanted = Number.isFinite(width) ? width : DEFAULT_WIDTH;
  const min = Math.round(viewport * MIN_FRACTION);
  const max = Math.round(viewport * MAX_FRACTION);
  return Math.min(Math.max(wanted, min), max);
}

/** The remembered width, or the default. Unclamped — the clamp belongs to the current window. */
export function readStoredWidth() {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = Number(raw);
    // `Number(null)` and `Number('')` are both 0, so the positive test catches a missing entry and
    // a blank one along with `Number('wide')`'s NaN.
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WIDTH;
  } catch {
    // Private-mode Safari throws on access rather than returning null.
    return DEFAULT_WIDTH;
  }
}

/** Whether the pane was left collapsed. Anything but a literal `true` reads as open. */
export function readStoredCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // A pane that cannot remember its width is still a usable pane.
  }
}

/**
 * The resizable preview pane's state, and the props its resizer needs.
 *
 * @param {object}  options
 * @param {string?} options.controls  the id of the element being resized, for `aria-controls`.
 * @returns {{
 *   width: number, collapsed: boolean, dragging: boolean,
 *   toggle: () => void, setCollapsed: (next: boolean) => void,
 *   separatorProps: object,
 * }}
 */
export function usePreviewResize({ controls } = {}) {
  const [stored, setStored] = useState(readStoredWidth);
  const [collapsed, setCollapsedState] = useState(readStoredCollapsed);
  const [viewport, setViewport] = useState(viewportWidth);
  const [dragging, setDragging] = useState(false);

  const width = clampWidth(stored, viewport);

  // The keyboard steps from wherever the pane is *rendered*, not from the number in storage: if a
  // narrow window has already clamped the pane to 512px, an arrow press has to move from 512 and
  // not from the 900 the user once chose on a monitor, or the first four presses would do nothing
  // visible at all.
  const widthRef = useRef(width);
  widthRef.current = width;

  // Re-clamping is all a resize does. The stored number is deliberately not touched — see the file
  // header for why a laptop must not be able to shrink a choice made on a monitor.
  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Commit a new width. `persist` is false during a drag, where sixty synchronous writes a second
  // would be the only expensive thing in the gesture; the write happens once, when the pointer is
  // released.
  const commit = useCallback((next, persist) => {
    const safe = clampWidth(next, viewportWidth());
    widthRef.current = safe;
    setStored(safe);
    if (persist) write(WIDTH_KEY, safe);
  }, []);

  const setCollapsed = useCallback((next) => {
    write(COLLAPSED_KEY, !!next);
    setCollapsedState(!!next);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      write(COLLAPSED_KEY, !prev);
      return !prev;
    });
  }, []);

  // Reading the width from the pointer rather than accumulating a delta is what stops the edge
  // drifting away from the cursor over a long drag, and it means a drag that starts while the
  // clamp is already engaged snaps to the pointer instead of moving by an offset that is no
  // longer true.
  //
  // THE PANE IS NO LONGER FLUSH AGAINST THE WINDOW. It was when this was written, which is what
  // made "distance from the pointer to the right edge" exactly the width being asked for. Ticket
  // 02 put the pane inside a frame inset 8px, and widened the grab strip from 5px to 9px, so the
  // divider now sits a measured 12.5px left of the cursor — `--gap` plus half the strip. It is a
  // constant, not a drift: the pane still tracks the pointer 1:1 and lands where it is released.
  //
  // Left uncorrected deliberately. Subtracting the offset means either hard-coding a number that
  // duplicates `--gap` and would silently rot when the frame's inset changes, or reading the
  // pane's rect — and this hook is DOM-free on purpose, which is the whole reason its clamp can be
  // tested at 640px and 3840px without a layout engine. Recorded in .scratch/browser-shell-d2 as
  // its own decision rather than folded into 02.
  const widthFrom = useCallback((clientX) => viewportWidth() - clientX, []);

  const separatorProps = useMemo(() => ({
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize preview',
    'aria-controls': controls,
    // Quoted as a percentage of the window, because that is what the limits are: telling a screen
    // reader "320 of a minimum 154 and a maximum 512" would be three numbers that mean nothing
    // without knowing the window. `aria-valuetext` carries the pixels for anyone who wants them.
    'aria-valuenow': viewport ? Math.round((width / viewport) * 100) : undefined,
    'aria-valuemin': Math.round(MIN_FRACTION * 100),
    'aria-valuemax': Math.round(MAX_FRACTION * 100),
    'aria-valuetext': `${Math.round(width)} pixels`,
    tabIndex: 0,
    'data-dragging': dragging ? '' : undefined,

    onPointerDown(e) {
      // Secondary buttons open context menus; starting a drag under one leaves the pane following
      // the pointer with no button held down to end it.
      if (typeof e.button === 'number' && e.button !== 0) return;
      // Cancelling the pointerdown suppresses the compatibility mousedown, and with it the text
      // selection that would otherwise sweep across the table for the length of the drag.
      e.preventDefault();
      e.currentTarget?.setPointerCapture?.(e.pointerId);
      setDragging(true);
    },

    onPointerMove(e) {
      if (!dragging) return;
      commit(widthFrom(e.clientX), false);
    },

    onPointerUp(e) {
      if (!dragging) return;
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
      setDragging(false);
      write(WIDTH_KEY, widthRef.current);
    },

    // A cancelled pointer — a system gesture taking over, the tab losing focus mid-drag — keeps
    // whatever width the last move produced. The alternative is to restore the width the drag
    // started at, which loses work the user could see happening.
    onPointerCancel() {
      if (!dragging) return;
      setDragging(false);
      write(WIDTH_KEY, widthRef.current);
    },

    // The browser fires this whether capture ended by release or by being taken away, so it is the
    // one guaranteed end of the gesture. It is idempotent with the two handlers above.
    onLostPointerCapture() {
      setDragging((was) => {
        if (was) write(WIDTH_KEY, widthRef.current);
        return false;
      });
    },

    // The pane is on the right, so its leading edge moves left to make it wider. Home and End are
    // handed a number past each end of the clamp rather than the limits themselves, because the
    // limits are the clamp's business and computing them a second time here is how the two
    // eventually disagree. They land on aria-valuemin and aria-valuemax, which is where the
    // semantics announced above said they would.
    onKeyDown(e) {
      const step = e.shiftKey ? STEP_COARSE : STEP;
      switch (e.key) {
        case 'ArrowLeft': commit(widthRef.current + step, true); break;
        case 'ArrowRight': commit(widthRef.current - step, true); break;
        case 'Home': commit(0, true); break;
        case 'End': commit(viewportWidth(), true); break;
        case 'Enter': toggle(); break;
        default: return;
      }
      e.preventDefault();
    },
  }), [commit, controls, dragging, toggle, viewport, width, widthFrom]);

  return { width, collapsed, dragging, toggle, setCollapsed, separatorProps };
}
