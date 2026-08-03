// src/components/browser/scanFacts.test.js
// The Scan column's three empty states are the point of these cases. Each fixture below is the
// shape of a real item in this instance, named in the case, so a change that collapses "not
// recorded" into "not a slide" fails here rather than in a browser pass six tickets later.
import { describe, it, expect } from 'vitest';
import { toFolderRow, toSlideRow } from './browseUtils.js';
import { hasLargeImage, scanCell, wantsTiles } from './scanFacts.js';

// A folder, exactly as the collections and folders levels build it.
const folderRow = () => toFolderRow({ _id: 'f1', name: 'slides', nItems: 100 });

// An item with a tile source attached. Girder's `largeImage` field is the marker.
const slideRow = (over = {}) => toSlideRow({
  _id: 's1', name: 'BRACS_1403.svs', size: 1_000_000,
  largeImage: { fileId: 'file1', sourceName: 'openslide' },
  meta: {}, ...over,
});

// `cellpose_test.anot` in TCGA-NSCLC/slides: a Girder item in a slide folder, with no pyramid.
const nonSlideRow = () => toSlideRow({
  _id: 'a1', name: 'cellpose_test.anot', size: 4_000, meta: {},
});

describe('hasLargeImage / wantsTiles', () => {
  it('is false for a folder, which has no item behind it', () => {
    expect(hasLargeImage(folderRow())).toBe(false);
    expect(wantsTiles(folderRow())).toBe(false);
  });

  it('is false for an item Girder never attached a tile source to', () => {
    expect(wantsTiles(nonSlideRow())).toBe(false);
  });

  it('is true for a slide, which is the only row worth a /tiles request', () => {
    expect(wantsTiles(slideRow())).toBe(true);
  });
});

describe('scanCell', () => {
  it('says nothing for a folder', () => {
    expect(scanCell(folderRow(), null)).toEqual({ text: '', kind: 'folder' });
  });

  it('says "not a slide" for an item with no largeImage, without needing tiles metadata', () => {
    expect(scanCell(nonSlideRow(), undefined)).toEqual({ text: 'not a slide', kind: 'not-a-slide' });
  });

  it('says "not recorded" for a slide whose source recorded neither field', () => {
    // The 14 MDA .tiff files: a full pyramid, a thumbnail, and no scanner parameters.
    const tiles = { magnification: null, mm_x: null, mm_y: null, sizeX: 118784, sizeY: 59904, levels: 10 };
    expect(scanCell(slideRow(), tiles)).toEqual({ text: 'not recorded', kind: 'not-recorded' });
  });

  it('shows the pixel pitch alone when only the magnification is missing', () => {
    expect(scanCell(slideRow(), { magnification: null, mm_x: 0.0005 }))
      .toEqual({ text: '0.5 µm', kind: 'ok' });
  });

  it('shows the magnification alone when only the pixel pitch is missing', () => {
    expect(scanCell(slideRow(), { magnification: 40, mm_x: null }))
      .toEqual({ text: '40×', kind: 'ok' });
  });

  it('reads both fields off a slide that has them', () => {
    // BRACS_1403.svs, verbatim from GET /api/v1/item/{id}/tiles.
    const tiles = { magnification: 40.0, mm_x: 0.0002519, mm_y: 0.0002519, sizeX: 83664, sizeY: 58852, levels: 10 };
    expect(scanCell(slideRow(), tiles)).toEqual({ text: '40× · 0.25 µm', kind: 'ok' });
  });

  it('rounds the pixel pitch to two significant figures', () => {
    // mm → µm is ×1000, and 0.2519 µm is a tolerance rather than a reading.
    expect(scanCell(slideRow(), { mm_x: 0.0002519 }).text).toBe('0.25 µm');
    expect(scanCell(slideRow(), { mm_x: 0.00025 }).text).toBe('0.25 µm');
    expect(scanCell(slideRow(), { mm_x: 0.001 }).text).toBe('1 µm');
  });

  it('keeps a half step in the magnification and drops a trailing zero', () => {
    expect(scanCell(slideRow(), { magnification: 20.0 }).text).toBe('20×');
    expect(scanCell(slideRow(), { magnification: 20.5 }).text).toBe('20.5×');
  });

  it('says nothing while the request is still out, rather than guessing at "not recorded"', () => {
    expect(scanCell(slideRow(), undefined)).toEqual({ text: '', kind: 'unknown' });
    expect(scanCell(slideRow(), null)).toEqual({ text: '', kind: 'unknown' });
  });

  it('ignores a zero or negative reading, which is a source bug rather than a measurement', () => {
    expect(scanCell(slideRow(), { magnification: 0, mm_x: 0 }))
      .toEqual({ text: 'not recorded', kind: 'not-recorded' });
  });
});
