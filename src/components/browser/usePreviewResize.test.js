// The preview pane's width, its collapse and the drag that changes them (Graphite · 08).
//
// The handlers are invoked directly rather than through a rendered element, and that is the point
// of the hook existing: `separatorProps` IS the contract, so calling `onPointerMove` with a
// `clientX` is testing the arithmetic and the clamp rather than jsdom's opinion of a 5px div — and
// jsdom does not implement pointer capture at all, so a rendered drag would be asserting against a
// stub either way. The capture calls are checked by handing the handlers a `currentTarget` that
// records them, which is exactly as much fidelity as there is to have here.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLLAPSED_KEY, DEFAULT_WIDTH, WIDTH_KEY, clampWidth, usePreviewResize,
} from './usePreviewResize.js';

// jsdom's default. Stated rather than assumed, because every clamp expectation below is derived
// from it: 15% is 154px and 50% is 512px.
const VIEWPORT = 1024;
const MIN = 154;
const MAX = 512;

/** jsdom defines `innerWidth` as a plain property, so a resize is a redefinition plus the event. */
function setViewport(px) {
  Object.defineProperty(window, 'innerWidth', { value: px, writable: true, configurable: true });
}

/** A pointer event with the two fields the handlers read, plus spies for the capture calls. */
function pointer(clientX, extra = {}) {
  return {
    clientX,
    pointerId: 1,
    button: 0,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() },
    ...extra,
  };
}

function key(k, extra = {}) {
  return { key: k, shiftKey: false, preventDefault: vi.fn(), ...extra };
}

/** Press the edge, move it to `clientX`, let go. */
function drag(result, clientX) {
  const down = pointer(clientX);
  const move = pointer(clientX);
  const up = pointer(clientX);
  act(() => result.current.separatorProps.onPointerDown(down));
  act(() => result.current.separatorProps.onPointerMove(move));
  act(() => result.current.separatorProps.onPointerUp(up));
  return { down, move, up };
}

beforeEach(() => {
  localStorage.clear();
  setViewport(VIEWPORT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the width the pane opens at', () => {
  it('is 320px when nothing is remembered', () => {
    const { result } = renderHook(() => usePreviewResize());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
    expect(DEFAULT_WIDTH).toBe(320);
  });

  it('is the remembered one when there is one', () => {
    localStorage.setItem(WIDTH_KEY, '440');
    const { result } = renderHook(() => usePreviewResize());
    expect(result.current.width).toBe(440);
  });

  // The three shapes a corrupted entry actually takes. None of them may produce a pane with no
  // width, which is a 5px draggable edge against the window frame and no way to tell what it is.
  it.each([['a word', 'wide'], ['a negative', '-200'], ['an empty string', '']])(
    'falls back to the default on %s',
    (_label, stored) => {
      localStorage.setItem(WIDTH_KEY, stored);
      const { result } = renderHook(() => usePreviewResize());
      expect(result.current.width).toBe(DEFAULT_WIDTH);
    },
  );

  it('clamps a remembered width that is too wide for this window', () => {
    localStorage.setItem(WIDTH_KEY, '900');
    const { result } = renderHook(() => usePreviewResize());
    expect(result.current.width).toBe(MAX);
  });

  // The reason the stored number and the rendered one are separate. A visit on a laptop must not
  // silently overwrite a width chosen on a monitor.
  it('keeps the stored choice intact while clamping it, so a wider window gets it back', () => {
    localStorage.setItem(WIDTH_KEY, '900');
    const narrow = renderHook(() => usePreviewResize());
    expect(narrow.result.current.width).toBe(MAX);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('900');
    narrow.unmount();

    setViewport(2560);
    const wide = renderHook(() => usePreviewResize());
    expect(wide.result.current.width).toBe(900);
  });
});

describe('dragging the leading edge', () => {
  it('sets the width to the distance from the pointer to the right of the window', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, 700);
    expect(result.current.width).toBe(VIEWPORT - 700);   // 324
  });

  it('follows the pointer across several moves', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onPointerDown(pointer(700)));
    act(() => result.current.separatorProps.onPointerMove(pointer(700)));
    expect(result.current.width).toBe(324);
    act(() => result.current.separatorProps.onPointerMove(pointer(650)));
    expect(result.current.width).toBe(374);
    act(() => result.current.separatorProps.onPointerUp(pointer(650)));
    expect(result.current.width).toBe(374);
  });

  it('takes pointer capture on the way down and releases it on the way up', () => {
    const { result } = renderHook(() => usePreviewResize());
    const { down, up } = drag(result, 700);
    expect(down.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(up.currentTarget.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(result.current.dragging).toBe(false);
  });

  it('reports itself dragging in between, which is what paints the line', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onPointerDown(pointer(700)));
    expect(result.current.dragging).toBe(true);
    expect(result.current.separatorProps['data-dragging']).toBe('');
    act(() => result.current.separatorProps.onPointerUp(pointer(700)));
    expect(result.current.separatorProps['data-dragging']).toBeUndefined();
  });

  it('ignores a move with no button held, so a passing pointer cannot resize the pane', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onPointerMove(pointer(700)));
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });

  it('ignores a secondary button, which is opening a context menu rather than dragging', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onPointerDown(pointer(700, { button: 2 })));
    expect(result.current.dragging).toBe(false);
    act(() => result.current.separatorProps.onPointerMove(pointer(700)));
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });

  // A gesture the system takes away mid-drag keeps whatever the last move produced. Losing the
  // work the user could see happening would be the worse of the two failures.
  it('ends cleanly when the pointer is cancelled', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onPointerDown(pointer(700)));
    act(() => result.current.separatorProps.onPointerMove(pointer(650)));
    act(() => result.current.separatorProps.onPointerCancel(pointer(650)));
    expect(result.current.dragging).toBe(false);
    expect(result.current.width).toBe(374);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('374');
  });

  it('ends cleanly when capture is taken away without a pointerup', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onPointerDown(pointer(700)));
    act(() => result.current.separatorProps.onPointerMove(pointer(650)));
    act(() => result.current.separatorProps.onLostPointerCapture(pointer(650)));
    expect(result.current.dragging).toBe(false);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('374');
  });
});

describe('the clamp', () => {
  it('holds at 15% when the edge is dragged to the right of the window', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, VIEWPORT - 10);
    expect(result.current.width).toBe(MIN);
    expect(result.current.width / VIEWPORT).toBeCloseTo(0.15, 2);
  });

  it('holds at 50% when the edge is dragged past the middle of the window', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, 20);
    expect(result.current.width).toBe(MAX);
    expect(result.current.width / VIEWPORT).toBeCloseTo(0.5, 2);
  });

  // Dragging off the right of the window asks for a negative width. The pane must pin at its
  // minimum: the one thing it must NOT do is jump back outwards, which is what happens if a
  // negative is treated as a nonsense value and answered with the default.
  it('never lets the pane vanish, even dragged past the right edge of the window', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, VIEWPORT + 400);
    expect(result.current.width).toBe(MIN);
  });

  it('pins at the minimum rather than the default for any width at or below zero', () => {
    expect(clampWidth(0, VIEWPORT)).toBe(MIN);
    expect(clampWidth(-900, VIEWPORT)).toBe(MIN);
  });

  // The limits are proportions, not pixels — which is the whole reason for copying OHIF's shape
  // rather than picking two round numbers.
  it('moves with the window: the same fractions, different pixels', () => {
    expect(clampWidth(50, 2560)).toBe(384);
    expect(clampWidth(5000, 2560)).toBe(1280);
    expect(clampWidth(50, 800)).toBe(120);
    expect(clampWidth(5000, 800)).toBe(400);
  });

  it('re-clamps what is on screen when the window shrinks, without touching the choice', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, 520);                       // 504px, inside 1024's 50%
    expect(result.current.width).toBe(504);

    act(() => {
      setViewport(800);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.width).toBe(400);  // 50% of 800
    expect(localStorage.getItem(WIDTH_KEY)).toBe('504');

    act(() => {
      setViewport(1024);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.width).toBe(504);
  });
});

describe('collapsing', () => {
  it('opens showing, collapses, and restores', () => {
    const { result } = renderHook(() => usePreviewResize());
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
  });

  it('takes an explicit state as well as a toggle', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);
  });

  it('keeps the width across a collapse, so restoring gives back the pane that was there', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, 600);
    expect(result.current.width).toBe(424);
    act(() => result.current.toggle());
    expect(result.current.width).toBe(424);
    act(() => result.current.toggle());
    expect(result.current.width).toBe(424);
  });

  it('reads anything but a literal true as open, so a corrupted entry is not a lost pane', () => {
    localStorage.setItem(COLLAPSED_KEY, 'yes');
    const { result } = renderHook(() => usePreviewResize());
    expect(result.current.collapsed).toBe(false);
  });
});

describe('what survives a reload', () => {
  it('remembers a dragged width', () => {
    const first = renderHook(() => usePreviewResize());
    drag(first.result, 600);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('424');
    first.unmount();

    const second = renderHook(() => usePreviewResize());
    expect(second.result.current.width).toBe(424);
  });

  it('remembers being collapsed', () => {
    const first = renderHook(() => usePreviewResize());
    act(() => first.result.current.toggle());
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
    first.unmount();

    const second = renderHook(() => usePreviewResize());
    expect(second.result.current.collapsed).toBe(true);
  });

  it('remembers both at once', () => {
    const first = renderHook(() => usePreviewResize());
    drag(first.result, 640);
    act(() => first.result.current.toggle());
    first.unmount();

    const second = renderHook(() => usePreviewResize());
    expect(second.result.current.width).toBe(384);
    expect(second.result.current.collapsed).toBe(true);
  });

  it('still gives a usable pane when localStorage throws, as it does in private mode', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => usePreviewResize());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
    expect(result.current.collapsed).toBe(false);
    drag(result, 600);
    expect(result.current.width).toBe(424);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
  });
});

describe('the resizer without a pointer', () => {
  it('carries the separator semantics, quoted as a percentage of the window', () => {
    const { result } = renderHook(() => usePreviewResize({ controls: 'browser-preview' }));
    const p = result.current.separatorProps;
    expect(p.role).toBe('separator');
    expect(p['aria-orientation']).toBe('vertical');
    expect(p['aria-label']).toBe('Resize preview');
    expect(p['aria-controls']).toBe('browser-preview');
    expect(p.tabIndex).toBe(0);
    expect(p['aria-valuemin']).toBe(15);
    expect(p['aria-valuemax']).toBe(50);
    expect(p['aria-valuenow']).toBe(31);          // 320 / 1024
    expect(p['aria-valuetext']).toBe('320 pixels');
  });

  it('keeps aria-valuenow in step with the width', () => {
    const { result } = renderHook(() => usePreviewResize());
    drag(result, 512);
    expect(result.current.separatorProps['aria-valuenow']).toBe(50);
    expect(result.current.separatorProps['aria-valuetext']).toBe('512 pixels');
  });

  // The pane is on the right, so its leading edge moves LEFT to make it wider. Getting this the
  // wrong way round is the one thing a keyboard user cannot work around.
  it('widens on ArrowLeft and narrows on ArrowRight', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onKeyDown(key('ArrowLeft')));
    expect(result.current.width).toBe(336);
    act(() => result.current.separatorProps.onKeyDown(key('ArrowRight')));
    act(() => result.current.separatorProps.onKeyDown(key('ArrowRight')));
    expect(result.current.width).toBe(304);
  });

  it('takes a bigger step with Shift held', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onKeyDown(key('ArrowLeft', { shiftKey: true })));
    expect(result.current.width).toBe(384);
  });

  it('goes to the ends of the clamp with Home and End', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onKeyDown(key('End')));
    expect(result.current.width).toBe(MAX);
    act(() => result.current.separatorProps.onKeyDown(key('Home')));
    expect(result.current.width).toBe(MIN);
  });

  it('holds the clamp under repeated arrow presses', () => {
    const { result } = renderHook(() => usePreviewResize());
    for (let i = 0; i < 40; i += 1) {
      act(() => result.current.separatorProps.onKeyDown(key('ArrowLeft')));
    }
    expect(result.current.width).toBe(MAX);
    for (let i = 0; i < 40; i += 1) {
      act(() => result.current.separatorProps.onKeyDown(key('ArrowRight')));
    }
    expect(result.current.width).toBe(MIN);
  });

  it('collapses and restores on Enter', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onKeyDown(key('Enter')));
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.separatorProps.onKeyDown(key('Enter')));
    expect(result.current.collapsed).toBe(false);
  });

  it('persists a keyboard resize immediately — there is no gesture end to wait for', () => {
    const { result } = renderHook(() => usePreviewResize());
    act(() => result.current.separatorProps.onKeyDown(key('ArrowLeft')));
    expect(localStorage.getItem(WIDTH_KEY)).toBe('336');
  });

  it('leaves keys it does not handle to the page', () => {
    const { result } = renderHook(() => usePreviewResize());
    const tab = key('Tab');
    act(() => result.current.separatorProps.onKeyDown(tab));
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });
});
