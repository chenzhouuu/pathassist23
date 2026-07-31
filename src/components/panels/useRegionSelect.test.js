import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  copilotRoi: null,
  roiSelectResult: null,
  drawingMode: null,
  shownRoi: null,
  viewer: null,
  setCopilotRoi: vi.fn((r) => { state.copilotRoi = r; }),
  setShownRoi: vi.fn((r) => { state.shownRoi = r; }),
  setDrawingMode: vi.fn((m) => { state.drawingMode = m; }),
  clearRoiSelectResult: vi.fn(() => { state.roiSelectResult = null; }),
};

vi.mock('../../store/index.js', () => ({
  useStore: (sel) => sel(state),
}));

const { formatRoi, useRegionSelect } = await import('./useRegionSelect.js');

beforeEach(() => {
  state.copilotRoi = null;
  state.roiSelectResult = null;
  state.drawingMode = null;
  state.shownRoi = null;
  Object.values(state).forEach((v) => { if (vi.isMockFunction(v)) v.mockClear(); });
});

describe('useRegionSelect', () => {
  it('puts the viewer into select mode, which is what the panel could not do before', () => {
    const { result } = renderHook(() => useRegionSelect());
    expect(result.current.awaiting).toBe(false);
    act(() => result.current.start());
    expect(state.setDrawingMode).toHaveBeenCalledWith('roi-select');
    expect(result.current.awaiting).toBe(true);
  });

  it('clears any stale result before waiting, so an old box is not adopted as the new one', () => {
    const { result } = renderHook(() => useRegionSelect());
    act(() => result.current.start());
    expect(state.clearRoiSelectResult).toHaveBeenCalled();
  });

  it('adopts the drawn box as the shared region and paints it', () => {
    const { result, rerender } = renderHook(() => useRegionSelect());
    act(() => result.current.start());
    state.roiSelectResult = { x: 10.4, y: 20, width: 2048, height: 2048, extra: 'ignored' };
    rerender();
    expect(state.setCopilotRoi).toHaveBeenCalledWith({ x: 10.4, y: 20, width: 2048, height: 2048 });
    expect(state.setShownRoi).toHaveBeenCalled();
    expect(result.current.awaiting).toBe(false);
  });

  it('ignores a result it did not ask for — two panels can be mounted at once', () => {
    const { rerender } = renderHook(() => useRegionSelect());
    state.roiSelectResult = { x: 1, y: 2, width: 3, height: 4 };
    rerender();
    expect(state.setCopilotRoi).not.toHaveBeenCalled();
  });

  it('cancelling leaves the viewer usable rather than stuck in select mode', () => {
    const { result } = renderHook(() => useRegionSelect());
    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(state.setDrawingMode).toHaveBeenLastCalledWith(null);
    expect(result.current.awaiting).toBe(false);
  });

  it('unmounting mid-draw releases the viewer', () => {
    const { result, unmount } = renderHook(() => useRegionSelect());
    act(() => result.current.start());
    unmount();
    expect(state.setDrawingMode).toHaveBeenLastCalledWith(null);
  });

  it('unmounting when it was NOT drawing leaves another tool alone', () => {
    const { unmount } = renderHook(() => useRegionSelect());
    unmount();
    expect(state.setDrawingMode).not.toHaveBeenCalled();
  });

  it('clearing drops both the attachment and the painted box', () => {
    const { result } = renderHook(() => useRegionSelect());
    act(() => result.current.clear());
    expect(state.setCopilotRoi).toHaveBeenCalledWith(null);
    expect(state.setShownRoi).toHaveBeenCalledWith(null);
  });

  it('showing a region fits the viewport to it', () => {
    const fitBounds = vi.fn();
    state.copilotRoi = { x: 100, y: 200, width: 2048, height: 2048 };
    state.viewer = {
      viewport: { imageToViewportRectangle: vi.fn(() => 'rect'), fitBounds },
    };
    const { result } = renderHook(() => useRegionSelect());
    act(() => result.current.show());
    expect(fitBounds).toHaveBeenCalledWith('rect', false);
    state.viewer = null;
  });
});

describe('formatRoi', () => {
  it('reads as slide pixels where the user drew them', () => {
    expect(formatRoi({ x: 41984, y: 26624, width: 2048, height: 2048 }))
      .toBe('2,048 × 2,048 px @ (41,984, 26,624)');
    expect(formatRoi(null)).toBe('');
  });
});
