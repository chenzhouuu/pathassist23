// src/components/browser/useSurfaceTheme.js
// The two attributes that make the landing page Graphite, and the one that remembers which.
//
// Both live on `document.documentElement` rather than on the page's own container, because the
// palette they select has to reach Radix's portals — a dropdown renders into `document.body`,
// outside `.browser-shell` — and because the base `:root` block in index.css is then never
// edited, which is what leaves the Viewer's palette identical by construction. The reasoning is
// written out in full in src/styles/browser/_tokens.css.
//
// `data-surface` is owned by the page's lifetime and is removed on unmount. That cleanup is the
// entire safety property: App.jsx returns BrowserPage *or* ViewerApp and never both, so a leaked
// attribute would repaint the Viewer in Graphite the moment a slide opened. `data-mode` is owned
// by the user and outlives the page, so it is left in place and persisted.
//
// The attribute is deliberately not called `data-theme`. That name belonged to a bootstrap that
// wrote an attribute nothing read; it was deleted, and reusing the name would resurrect the
// ambiguity. The storage key avoids the dead bootstrap's `theme` key for the same reason.
import { useCallback, useEffect, useState } from 'react';

export const SURFACE_ATTR = 'data-surface';
export const MODE_ATTR = 'data-mode';
export const MODE_KEY = 'pathassist.browser.mode';

const MODES = ['light', 'dark'];

/** The remembered mode, or light. Light is the canonical theme: dark is derived from it. */
export function readStoredMode() {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return MODES.includes(raw) ? raw : 'light';
  } catch {
    // Private-mode Safari throws on access rather than returning null.
    return 'light';
  }
}

function writeStoredMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A surface that cannot remember its mode is still a usable surface.
  }
}

/**
 * Mark the document as carrying `surface` for as long as the calling component is mounted, and
 * return the current light/dark mode with a setter that persists it.
 *
 * @param {string} surface value for the surface attribute; 'browser' selects the Graphite block.
 * @returns {{ mode: 'light'|'dark', setMode: (m: string) => void, toggleMode: () => void }}
 */
export function useSurfaceTheme(surface = 'browser') {
  const [mode, setModeState] = useState(readStoredMode);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute(SURFACE_ATTR, surface);
    return () => root.removeAttribute(SURFACE_ATTR);
  }, [surface]);

  // Written on its own effect, and never removed on unmount: the choice is the user's and has to
  // survive walking into a slide and back out again, where the surface attribute must not.
  useEffect(() => {
    document.documentElement.setAttribute(MODE_ATTR, mode);
  }, [mode]);

  const setMode = useCallback((next) => {
    const safe = MODES.includes(next) ? next : 'light';
    writeStoredMode(safe);
    setModeState(safe);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      writeStoredMode(next);
      return next;
    });
  }, []);

  return { mode, setMode, toggleMode };
}
