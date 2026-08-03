// The preview pane's field set (Graphite · 08).
//
// What is worth asserting here is the *absence* rule, and it is worth asserting because it is
// invisible when it works: the 14 MDA `.tiff` files are real slides with a full pyramid and a
// thumbnail that record no magnification and no pixel pitch, and a pane that renders a labelled
// empty row for each of them is claiming the scanner reported a blank. Two rows fewer is the
// correct rendering, and nothing but a test distinguishes it from two rows the pane forgot to draw.
//
// The pane is rendered on its own rather than through BrowserPage, unlike SlideGrid's tests: there
// is no wiring claim here — the width and the collapse are `usePreviewResize`'s and are tested
// there — only what one row plus one tiles document produces.
import React from 'react';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getTilesInfoSafe: vi.fn(),
  getThumbnailUrl: vi.fn(() => 'blob:thumb'),
}));

import PreviewPane from './PreviewPane.jsx';
import { getTilesInfoSafe } from '../../api/index.js';
import { toFolderRow, toSlideRow } from './browseUtils.js';

// BRACS_1403.svs as the live Girder actually answers for it.
const BRACS = toSlideRow({
  _id: 'i1',
  name: 'BRACS_1403.svs',
  size: 1_240_000_000,
  updated: '2026-07-01T00:00:00Z',
  largeImage: { fileId: 'f1' },
});
const BRACS_TILES = {
  sizeX: 83664, sizeY: 58852, levels: 10, magnification: 40, mm_x: 0.00025, mm_y: 0.00025,
};

// One of the MDA `.tiff` files: a slide, with a pyramid and a thumbnail, and no recorded optics.
const MDA_TILES = {
  sizeX: 30720, sizeY: 27904, levels: 8, magnification: null, mm_x: null, mm_y: null,
};

// An annotation file sitting in a slide folder — a Girder item with no tile source attached.
const ANOT = toSlideRow({ _id: 'i3', name: 'cellpose_test.anot', size: 2048 });

const CASE = toFolderRow({ _id: 'f9', name: 'Case 001', nItems: 12, created: '2026-06-01T00:00:00Z' });

const noop = () => {};

function renderPane(row, props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <PreviewPane
        row={row}
        width={320}
        id="browser-preview"
        onOpen={noop}
        onStatus={noop}
        onShare={noop}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** The value rendered under a label, or null when the label is not on screen at all. */
const fieldValue = (label) => {
  const dt = screen.queryByText(label, { selector: '.browser-preview-field dt' });
  return dt ? dt.parentElement.querySelector('dd').textContent : null;
};

describe('the pane with nothing selected', () => {
  it('says so, and still takes the width it was given', () => {
    renderPane(null);
    expect(screen.getByText('Select a row to preview it.')).toBeInTheDocument();
    expect(document.querySelector('.browser-preview')).toHaveStyle({ width: '320px' });
  });
});

describe('a slide that recorded everything', () => {
  it('reads the five scan facts off the tiles metadata', async () => {
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    renderPane(BRACS);

    expect(await screen.findByText('40×')).toBeInTheDocument();
    expect(fieldValue('Magnification')).toBe('40×');
    expect(fieldValue('Resolution')).toBe('0.25 µm/px');
    expect(fieldValue('Dimensions')).toBe('83,664 × 58,852');
    expect(fieldValue('Levels')).toBe('10');
  });

  // Derived from sizeX/sizeY rather than stored, and quoted against 1 in both directions so a
  // portrait slide reads as a portrait instead of being flipped.
  it('derives the aspect, and keeps portraits below 1', async () => {
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    const { unmount } = renderPane(BRACS);
    expect(await screen.findByText('1.42 : 1')).toBeInTheDocument();
    unmount();

    getTilesInfoSafe.mockResolvedValue({ sizeX: 12400, sizeY: 20000, levels: 6 });
    renderPane(BRACS);
    expect(await screen.findByText('0.62 : 1')).toBeInTheDocument();
  });

  it('keeps the row facts alongside them', async () => {
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    renderPane(BRACS);
    await screen.findByText('40×');
    expect(fieldValue('Size')).toBe('1.2 GB');
    expect(fieldValue('Status')).toBe('New');
    expect(fieldValue('Updated')).toBeTruthy();
  });

  // The rail and the breadcrumb both say where you are, permanently. A third copy in the pane can
  // only ever agree with them, which is what makes it noise rather than a fact about the slide.
  it('does not restate where the slide lives', async () => {
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    renderPane(BRACS);
    await screen.findByText('40×');
    expect(fieldValue('Folder')).toBeNull();
    expect(fieldValue('Collection')).toBeNull();
  });
});

describe('a slide that recorded no optics — the MDA .tiff files', () => {
  it('drops magnification and resolution entirely rather than labelling a blank', async () => {
    getTilesInfoSafe.mockResolvedValue(MDA_TILES);
    renderPane(BRACS);

    expect(await screen.findByText('30,720 × 27,904')).toBeInTheDocument();
    expect(fieldValue('Levels')).toBe('8');
    expect(fieldValue('Aspect')).toBe('1.10 : 1');
    expect(screen.queryByText('Magnification')).not.toBeInTheDocument();
    expect(screen.queryByText('Resolution')).not.toBeInTheDocument();
  });

  it('does the same for a slide with a pitch but no magnification', async () => {
    getTilesInfoSafe.mockResolvedValue({ ...MDA_TILES, mm_x: 0.0005 });
    renderPane(BRACS);
    expect(await screen.findByText('0.5 µm/px')).toBeInTheDocument();
    expect(screen.queryByText('Magnification')).not.toBeInTheDocument();
  });
});

describe('an item that is not a slide', () => {
  it('asks nothing of the tiles endpoint, and shows only what the row itself holds', () => {
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    renderPane(ANOT);
    expect(getTilesInfoSafe).not.toHaveBeenCalled();
    expect(screen.queryByText('Dimensions')).not.toBeInTheDocument();
    expect(fieldValue('Size')).toBe('2.0 kB');
  });
});

describe('a folder', () => {
  it('shows its item count and its own action', () => {
    renderPane(CASE);
    expect(getTilesInfoSafe).not.toHaveBeenCalled();
    const frame = document.querySelector('.browser-preview-image.is-folder');
    expect(frame).toHaveTextContent('12');
    expect(frame).toHaveTextContent('items');
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Status' })).not.toBeInTheDocument();
  });

  // Girder has not computed counts on this instance, and `—` is the true rendering: "nobody has
  // counted this" and "this is empty" are different facts and only one of them means skip it.
  it('shows an em dash for a folder Girder has not counted', () => {
    renderPane(toFolderRow({ _id: 'f8', name: 'Uncounted' }));
    expect(document.querySelector('.browser-preview-image.is-folder')).toHaveTextContent('—');
  });
});

describe('the actions', () => {
  it('opens a slide', async () => {
    const onOpen = vi.fn();
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    renderPane(BRACS, { onOpen });
    await userEvent.click(screen.getByRole('button', { name: 'Open slide' }));
    expect(onOpen).toHaveBeenCalledWith(BRACS);
  });

  it('sets and clears a status', async () => {
    const onStatus = vi.fn();
    getTilesInfoSafe.mockResolvedValue(BRACS_TILES);
    renderPane(BRACS, { onStatus });

    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Flagged' }));
    expect(onStatus).toHaveBeenCalledWith('Flagged');

    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear' }));
    expect(onStatus).toHaveBeenCalledWith(null);
  });

  it('shares the folder document, which is what a share link is granted on', async () => {
    const onShare = vi.fn();
    renderPane(CASE, { onShare });
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledWith(CASE.raw);
  });
});
