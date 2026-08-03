// The scan query's two load-bearing properties, both of which are invisible in a screenshot and
// both of which a reasonable-looking edit elsewhere can destroy.
//
// One: three surfaces share a single cache entry, so switching table -> grid -> preview costs no
// request. That used to depend on three string literals staying in agreement; it now depends on
// one module, and this asserts the module actually delivers it.
//
// Two: the key is deliberately NOT under the `['browser', …]` prefix that the rest of the page
// uses. Creating a folder invalidates that whole prefix, and with no virtualisation a folder
// scrolled to the bottom holds five hundred live scan observers — so a key under it turns one
// click into five hundred simultaneous /tiles requests. The last case is the regression net for
// exactly that, because moving the key back would look like a tidy-up.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../api/index.js', () => ({
  getTilesInfoSafe: vi.fn(),
}));

import { getTilesInfoSafe } from '../../api/index.js';
import { useScanFacts } from './useScanFacts.js';

const SLIDE = {
  id: 's1', name: 'BRACS_1403.svs', kind: 'slide',
  raw: { _id: 's1', largeImage: { fileId: 'f1' } },
};
const NON_SLIDE = { id: 's2', name: 'cellpose_test.anot', kind: 'slide', raw: { _id: 's2' } };
const FOLDER = { id: 'f1', name: 'slides', kind: 'folder', raw: { _id: 'f1' } };

// staleTime mirrors main.jsx; whether a second observer revalidates is a property of that number.
const client = () => new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

function wrapperFor(qc) {
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  getTilesInfoSafe.mockReset();
  getTilesInfoSafe.mockResolvedValue({ magnification: 40, mm_x: 0.0002519, sizeX: 1, sizeY: 1, levels: 10 });
});

describe('useScanFacts — one request for however many surfaces are looking', () => {
  it('serves a second caller from the cache rather than asking again', async () => {
    const qc = client();
    const wrapper = wrapperFor(qc);

    const a = renderHook(() => useScanFacts(SLIDE), { wrapper });
    await waitFor(() => expect(a.result.current.tiles).toBeTruthy());
    expect(getTilesInfoSafe).toHaveBeenCalledTimes(1);

    // The grid card, then the preview pane, on the same row.
    const b = renderHook(() => useScanFacts(SLIDE), { wrapper });
    const c = renderHook(() => useScanFacts(SLIDE), { wrapper });
    await waitFor(() => expect(b.result.current.text).toBe('40× · 0.25 µm'));
    await waitFor(() => expect(c.result.current.text).toBe('40× · 0.25 µm'));

    expect(getTilesInfoSafe).toHaveBeenCalledTimes(1);
  });

  it('holds the request back when the caller says the row is not on screen yet', async () => {
    const qc = client();
    renderHook(() => useScanFacts(SLIDE, { enabled: false }), { wrapper: wrapperFor(qc) });
    await new Promise((r) => setTimeout(r, 0));
    expect(getTilesInfoSafe).not.toHaveBeenCalled();
  });

  it('never asks about a row that cannot answer', async () => {
    const qc = client();
    const wrapper = wrapperFor(qc);
    renderHook(() => useScanFacts(NON_SLIDE), { wrapper });
    renderHook(() => useScanFacts(FOLDER), { wrapper });
    renderHook(() => useScanFacts(null), { wrapper });
    await new Promise((r) => setTimeout(r, 0));
    // `largeImage` is on the item the table already holds, so both answers are free.
    expect(getTilesInfoSafe).not.toHaveBeenCalled();
  });
});

describe('useScanFacts — out of reach of the browser prefix', () => {
  it('survives the invalidation that a New folder or an Import fires', async () => {
    const qc = client();
    const wrapper = wrapperFor(qc);

    const { result } = renderHook(() => useScanFacts(SLIDE), { wrapper });
    await waitFor(() => expect(result.current.tiles).toBeTruthy());
    expect(getTilesInfoSafe).toHaveBeenCalledTimes(1);

    // Exactly what NewEntryDialog's onCreated and ImportModal's onImported do. With the key under
    // ['browser', …] this refetches once per mounted row — five hundred of them on TCGA-BRCA.
    await qc.invalidateQueries({ queryKey: ['browser'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(getTilesInfoSafe).toHaveBeenCalledTimes(1);
  });

  it('is still reachable on its own terms, so a real slide change can clear it', async () => {
    const qc = client();
    const wrapper = wrapperFor(qc);

    const { result } = renderHook(() => useScanFacts(SLIDE), { wrapper });
    await waitFor(() => expect(result.current.tiles).toBeTruthy());

    await qc.invalidateQueries({ queryKey: ['tiles', SLIDE.id] });
    await waitFor(() => expect(getTilesInfoSafe).toHaveBeenCalledTimes(2));
  });
});
