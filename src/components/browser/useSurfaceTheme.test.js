import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODE_KEY, useSurfaceTheme } from './useSurfaceTheme.js';

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute('data-surface');
  root().removeAttribute('data-mode');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the surface attribute', () => {
  it('marks the document while mounted', () => {
    renderHook(() => useSurfaceTheme('browser'));
    expect(root().getAttribute('data-surface')).toBe('browser');
  });

  // The cleanup is the safety property, not a tidiness one: App.jsx swaps BrowserPage for
  // ViewerApp, so a leaked attribute would repaint the Viewer in Graphite.
  it('unmarks it on unmount, so the Viewer keeps its own palette', () => {
    const { unmount } = renderHook(() => useSurfaceTheme('browser'));
    unmount();
    expect(root().hasAttribute('data-surface')).toBe(false);
  });

  it('is not named data-theme, which belonged to the deleted bootstrap', () => {
    renderHook(() => useSurfaceTheme('browser'));
    expect(root().hasAttribute('data-theme')).toBe(false);
  });
});

describe('the mode attribute', () => {
  it('opens in light when nothing is remembered', () => {
    const { result } = renderHook(() => useSurfaceTheme());
    expect(result.current.mode).toBe('light');
    expect(root().getAttribute('data-mode')).toBe('light');
  });

  it('opens in the remembered mode', () => {
    localStorage.setItem(MODE_KEY, 'dark');
    const { result } = renderHook(() => useSurfaceTheme());
    expect(result.current.mode).toBe('dark');
    expect(root().getAttribute('data-mode')).toBe('dark');
  });

  it('falls back to light on a value it does not recognise', () => {
    localStorage.setItem(MODE_KEY, 'sepia');
    const { result } = renderHook(() => useSurfaceTheme());
    expect(result.current.mode).toBe('light');
  });

  it('writes and persists a toggle', () => {
    const { result } = renderHook(() => useSurfaceTheme());
    act(() => result.current.toggleMode());
    expect(root().getAttribute('data-mode')).toBe('dark');
    expect(localStorage.getItem(MODE_KEY)).toBe('dark');

    act(() => result.current.toggleMode());
    expect(root().getAttribute('data-mode')).toBe('light');
    expect(localStorage.getItem(MODE_KEY)).toBe('light');
  });

  it('accepts an explicit mode and rejects a bogus one', () => {
    const { result } = renderHook(() => useSurfaceTheme());
    act(() => result.current.setMode('dark'));
    expect(result.current.mode).toBe('dark');
    act(() => result.current.setMode('neon'));
    expect(result.current.mode).toBe('light');
  });

  // The mode is the user's, not the page's: it has to survive walking into a slide and back out,
  // which is exactly where the surface attribute must not.
  it('survives unmount, unlike the surface attribute', () => {
    const { result, unmount } = renderHook(() => useSurfaceTheme('browser'));
    act(() => result.current.toggleMode());
    unmount();
    expect(root().hasAttribute('data-surface')).toBe(false);
    expect(root().getAttribute('data-mode')).toBe('dark');
  });

  it('still renders when localStorage throws, as it does in private mode', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => useSurfaceTheme());
    expect(result.current.mode).toBe('light');
    act(() => result.current.toggleMode());
    expect(result.current.mode).toBe('dark');
    expect(root().getAttribute('data-mode')).toBe('dark');
  });
});
