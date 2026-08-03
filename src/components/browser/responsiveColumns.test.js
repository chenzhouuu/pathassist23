// src/components/browser/responsiveColumns.test.js
// The column ladder, checked against the widths this page actually produces.
//
// The measuring needs a browser and the deciding does not, which is the whole reason the two are
// separate modules — so these cases are written in the units the live page reports: 875px of table
// at 1440 with the preview at its default, 715px at 1280, and ~395px with the pane dragged to its
// 50% ceiling on a 1280 laptop. A change that moves a drop point moves one of those numbers here.
import { describe, it, expect } from 'vitest';
import { buildColumns } from './browserColumns.jsx';
import { hiddenByWidth, specFor } from './responsiveColumns.js';

// The six columns the table opens with, straight out of the real definitions rather than a
// fixture: the priorities and the minimums are the thing under test, and a local copy of them
// would pass while the page shipped different numbers.
const DEFAULT_SPEC = specFor(buildColumns({ onOpen: () => {} }), {
  diagnosis: false, folderPath: false, collectionName: false,
});

// 36 + 260 + 120 + 130 + 90 + 90.
const DEFAULT_TOTAL = 726;

describe('specFor', () => {
  it('reads the ladder off the column definitions', () => {
    expect(DEFAULT_SPEC.map((c) => c.id))
      .toEqual(['select', 'name', 'status', 'scan', 'size', 'created']);
    expect(DEFAULT_SPEC.reduce((sum, c) => sum + c.min, 0)).toBe(DEFAULT_TOTAL);
  });

  it('leaves out a column that is hidden for another reason, so it cannot claim width', () => {
    const spec = specFor(buildColumns({ onOpen: () => {} }), {
      diagnosis: false, folderPath: false, collectionName: false, status: false, scan: false, size: false,
    });
    expect(spec.map((c) => c.id)).toEqual(['select', 'name', 'created']);
  });

  it('treats a column the map says nothing about as showing', () => {
    expect(specFor([{ id: 'a', meta: { width: 10 } }], {})).toEqual([
      { id: 'a', min: 10, priority: undefined },
    ]);
  });
});

describe('hiddenByWidth', () => {
  it('drops nothing when the columns fit', () => {
    // 1440px, rail 240, resizer 5, preview at its 320 default.
    expect(hiddenByWidth(875, DEFAULT_SPEC)).toEqual([]);
  });

  it('drops nothing at exactly the width they need', () => {
    expect(hiddenByWidth(DEFAULT_TOTAL, DEFAULT_SPEC)).toEqual([]);
  });

  it('gives up Updated first, on a 1280 laptop with the preview open', () => {
    // 1280 - 240 - 5 - 320 = 715, eleven pixels short of the seven-column table.
    expect(hiddenByWidth(715, DEFAULT_SPEC)).toEqual(['created']);
  });

  it('gives them up in the stated order as the table keeps narrowing', () => {
    expect(hiddenByWidth(700, DEFAULT_SPEC)).toEqual(['created']);
    expect(hiddenByWidth(600, DEFAULT_SPEC)).toEqual(['created', 'size']);
    expect(hiddenByWidth(500, DEFAULT_SPEC)).toEqual(['created', 'size', 'scan']);
    // The preview dragged to its 50% ceiling at 1280 leaves about this much.
    expect(hiddenByWidth(395, DEFAULT_SPEC)).toEqual(['created', 'size', 'scan', 'status']);
  });

  it('stops as soon as what is left fits, rather than dropping the whole tail', () => {
    const hidden = hiddenByWidth(640, DEFAULT_SPEC);
    expect(hidden).toEqual(['created']);
    // 726 - 90 = 636, which is inside 640, so Size stays.
    expect(hidden).not.toContain('size');
  });

  it('never gives up Name, or the checkbox that makes the rows selectable', () => {
    for (const width of [400, 300, 200, 120, 1]) {
      const hidden = hiddenByWidth(width, DEFAULT_SPEC);
      expect(hidden).not.toContain('name');
      expect(hidden).not.toContain('select');
    }
  });

  it('leaves a usable table in a container narrower than anything can fit', () => {
    // Everything with a priority goes, and what is left is a name and a way to select it. Name
    // has no fixed width, so it takes whatever the container has: the table degrades to two
    // columns rather than clipping four off the right edge.
    const spec = specFor(buildColumns({ onOpen: () => {} }), {});
    const showing = spec.filter((c) => !hiddenByWidth(120, spec).includes(c.id));
    expect(showing.map((c) => c.id)).toEqual(['select', 'name']);
  });

  it('hides nothing at all until the container has been measured', () => {
    // jsdom reports 0 for an element it never laid out, and the first render is ahead of the
    // first observation. A table that showed seven columns and dropped four a frame later would
    // read as a rendering bug, so an unmeasured container is treated as roomy.
    for (const width of [null, undefined, 0, -1, NaN, Infinity]) {
      expect(hiddenByWidth(width, DEFAULT_SPEC)).toEqual([]);
    }
  });

  it('follows priority rather than the order the columns are declared in', () => {
    const spec = [
      { id: 'first', min: 100, priority: 9 },
      { id: 'last', min: 100, priority: 1 },
      { id: 'required', min: 100 },
    ];
    expect(hiddenByWidth(250, spec)).toEqual(['last']);
    expect(hiddenByWidth(150, spec)).toEqual(['last', 'first']);
  });

  it('drops the three opt-in columns before any of the default six', () => {
    // Turning a column on is a deliberate act, but Collection and Folder are the two columns that
    // can only agree with the rail and the breadcrumb, both of which are on screen permanently.
    const spec = specFor(buildColumns({ onOpen: () => {} }), {});
    expect(hiddenByWidth(1000, spec)).toEqual(['collectionName', 'folderPath']);
  });

  it('survives a spec with no widths on it at all', () => {
    expect(hiddenByWidth(500, [{ id: 'a' }, { id: 'b', priority: 1 }])).toEqual([]);
    expect(hiddenByWidth(500, [])).toEqual([]);
    expect(hiddenByWidth(500, undefined)).toEqual([]);
  });
});
