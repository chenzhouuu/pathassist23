import { describe, it, expect } from 'vitest';
import {
  ROOT,
  crumbsFor,
  levelOf,
  parentOf,
  toFolderRow,
  toSlideRow,
  matchesSearch,
  matchesStatus,
  filterRows,
  fmtSize,
  fmtDate,
  STATUSES,
  isSlideRow,
  foldersFirst,
  foldersFirstIn,
} from './browseUtils.js';

const coll = (over = {}) => ({ _id: 'c1', name: 'BRCA-TEST', ...over });
const folder = (over = {}) => ({ _id: 'f1', name: 'Case 04', nItems: 3, ...over });
const slide = (over = {}) => ({
  _id: 's1', name: 'slide-01.svs', size: 2_100_000_000,
  created: '2026-07-28T10:00:00Z', meta: {}, ...over,
});

// ── Breadcrumbs ────────────────────────────────────────────────────────────────────────

describe('crumbsFor', () => {
  it('is just the root when nothing is selected', () => {
    expect(crumbsFor(null, [])).toEqual([ROOT]);
  });

  it('appends the collection', () => {
    expect(crumbsFor(coll(), [])).toEqual([ROOT, { _id: 'c1', name: 'BRCA-TEST', kind: 'collection' }]);
  });

  it('appends every folder on the path, in order', () => {
    const path = [folder({ _id: 'f1', name: 'Case 04' }), folder({ _id: 'f2', name: 'Block A' })];
    expect(crumbsFor(coll(), path).map((c) => c.name)).toEqual(['All collections', 'BRCA-TEST', 'Case 04', 'Block A']);
  });

  it('ignores a folder path with no collection — a folder cannot be reached without one', () => {
    expect(crumbsFor(null, [folder()])).toEqual([ROOT]);
  });
});

describe('levelOf', () => {
  it('reports where the browser is', () => {
    expect(levelOf(null, [])).toBe('collections');
    expect(levelOf(coll(), [])).toBe('folders');
    expect(levelOf(coll(), [folder()])).toBe('items');
    expect(levelOf(coll(), [folder(), folder({ _id: 'f2' })])).toBe('items');
  });
});

describe('parentOf', () => {
  it('drops the last folder', () => {
    const path = [folder({ _id: 'f1' }), folder({ _id: 'f2' })];
    expect(parentOf(coll(), path)).toEqual({ collection: coll(), path: [folder({ _id: 'f1' })] });
  });

  it('drops the collection once the folder path is empty', () => {
    expect(parentOf(coll(), [])).toEqual({ collection: null, path: [] });
  });

  it('stays at the root rather than going negative', () => {
    expect(parentOf(null, [])).toEqual({ collection: null, path: [] });
  });
});

// ── Row normalisation ──────────────────────────────────────────────────────────────────

describe('toFolderRow', () => {
  it('carries the name and the child count', () => {
    const r = toFolderRow(folder({ nItems: 12 }));
    expect(r).toMatchObject({ id: 'f1', name: 'Case 04', kind: 'folder', count: 12 });
  });

  it('treats a missing nItems as unknown, not as zero', () => {
    expect(toFolderRow(folder({ nItems: undefined })).count).toBeNull();
  });

  it('has no size or status — a folder is not a slide', () => {
    const r = toFolderRow(folder());
    expect(r.size).toBeNull();
    expect(r.status).toBeNull();
  });
});

describe('toSlideRow', () => {
  it('lifts status and diagnosis out of meta', () => {
    const r = toSlideRow(slide({ meta: { status: 'Read', diagnosis: 'IDC' } }), { folderPath: 'Case 04' });
    expect(r).toMatchObject({
      id: 's1', name: 'slide-01.svs', kind: 'slide',
      status: 'Read', diagnosis: 'IDC', folderPath: 'Case 04',
    });
  });

  it('leaves status null when the slide has never been triaged', () => {
    expect(toSlideRow(slide()).status).toBeNull();
  });

  it('survives a slide with no meta at all', () => {
    const r = toSlideRow(slide({ meta: undefined }));
    expect(r.status).toBeNull();
    expect(r.diagnosis).toBeNull();
  });
});

describe('isSlideRow', () => {
  it('separates the two row kinds', () => {
    expect(isSlideRow(toSlideRow(slide()))).toBe(true);
    expect(isSlideRow(toFolderRow(folder()))).toBe(false);
  });
});

// ── Filtering ──────────────────────────────────────────────────────────────────────────

describe('matchesSearch', () => {
  const row = toSlideRow(slide({ name: 'TCGA-BH-A0B3.svs', meta: { diagnosis: 'Lobular carcinoma' } }));

  it('is case-insensitive on the name', () => {
    expect(matchesSearch(row, 'tcga')).toBe(true);
    expect(matchesSearch(row, 'A0B3')).toBe(true);
  });

  it('also searches the diagnosis, because that is how a case is remembered', () => {
    expect(matchesSearch(row, 'lobular')).toBe(true);
  });

  it('rejects a miss', () => {
    expect(matchesSearch(row, 'ductal')).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(matchesSearch(row, '')).toBe(true);
    expect(matchesSearch(row, '   ')).toBe(true);
  });
});

describe('matchesStatus', () => {
  it('All lets everything through', () => {
    expect(matchesStatus(toSlideRow(slide()), 'All')).toBe(true);
    expect(matchesStatus(toSlideRow(slide({ meta: { status: 'Read' } })), 'All')).toBe(true);
  });

  it('matches an explicit status', () => {
    const r = toSlideRow(slide({ meta: { status: 'Read' } }));
    expect(matchesStatus(r, 'Read')).toBe(true);
    expect(matchesStatus(r, 'New')).toBe(false);
  });

  it('treats an untriaged slide as New, so the filter finds the work still to do', () => {
    expect(matchesStatus(toSlideRow(slide()), 'New')).toBe(true);
  });
});

describe('filterRows', () => {
  const rows = [
    toFolderRow(folder({ _id: 'f1', name: 'Case 04' })),
    toSlideRow(slide({ _id: 's1', name: 'aaa.svs', meta: { status: 'Read' } })),
    toSlideRow(slide({ _id: 's2', name: 'bbb.svs', meta: { status: 'New' } })),
  ];

  it('keeps folders visible whatever the status filter says', () => {
    // A folder has no status; hiding it would strand its contents behind a filter that
    // cannot describe them.
    const out = filterRows(rows, { search: '', status: 'Read' });
    expect(out.map((r) => r.id)).toEqual(['f1', 's1']);
  });

  it('applies the search to folders too', () => {
    expect(filterRows(rows, { search: 'case', status: 'All' }).map((r) => r.id)).toEqual(['f1']);
  });

  it('applies both filters together', () => {
    expect(filterRows(rows, { search: 'bbb', status: 'New' }).map((r) => r.id)).toEqual(['s2']);
  });

  it('returns everything when nothing is set', () => {
    expect(filterRows(rows, { search: '', status: 'All' })).toHaveLength(3);
  });
});

// ── Formatting ─────────────────────────────────────────────────────────────────────────

describe('fmtSize', () => {
  it('uses the unit a pathologist reads at a glance', () => {
    expect(fmtSize(2_100_000_000)).toBe('2.1 GB');
    expect(fmtSize(1_800_000)).toBe('1.8 MB');
    expect(fmtSize(4_096)).toBe('4.1 kB');
    expect(fmtSize(512)).toBe('512 B');
  });

  it('renders nothing for a folder rather than "0 B"', () => {
    expect(fmtSize(null)).toBe('');
    expect(fmtSize(undefined)).toBe('');
  });

  it('does not print a decimal point on a whole GB', () => {
    expect(fmtSize(3_000_000_000)).toBe('3 GB');
  });
});

describe('fmtDate', () => {
  it('is short — the year is noise inside a working set', () => {
    expect(fmtDate('2026-07-28T10:00:00Z')).toMatch(/^\d{2}-\d{2}$/);
  });

  it('is empty rather than "Invalid Date" for junk', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('not a date')).toBe('');
  });
});

describe('STATUSES', () => {
  it('starts with All and contains New', () => {
    expect(STATUSES[0]).toBe('All');
    expect(STATUSES).toContain('New');
  });
});

// ── Sorting ────────────────────────────────────────────────────────────────────────────

describe('foldersFirst', () => {
  // @tanstack hands the sort fn Row objects, so the tests build the shape it actually sees.
  const asRow = (original) => ({ original, getValue: (id) => original[id] });
  const f = (name) => asRow(toFolderRow(folder({ _id: name, name })));
  const s = (name, over = {}) => asRow(toSlideRow(slide({ _id: name, name, ...over })));

  it('puts a folder before a slide regardless of name', () => {
    expect(foldersFirst(f('zzz'), s('aaa'), 'name')).toBeLessThan(0);
    expect(foldersFirst(s('aaa'), f('zzz'), 'name')).toBeGreaterThan(0);
  });

  it('falls back to the column within a group', () => {
    expect(foldersFirst(f('a'), f('b'), 'name')).toBeLessThan(0);
    expect(foldersFirst(s('b.svs'), s('a.svs'), 'name')).toBeGreaterThan(0);
  });

  it('compares numbers as numbers, so 900 MB does not sort above 1 GB', () => {
    expect(foldersFirst(s('big', { size: 2e9 }), s('small', { size: 9e8 }), 'size')).toBeGreaterThan(0);
  });

  it('orders numerically inside a name, so slide-2 precedes slide-10', () => {
    expect(foldersFirst(s('slide-2.svs'), s('slide-10.svs'), 'name')).toBeLessThan(0);
  });

  it('does not throw on a missing value', () => {
    expect(() => foldersFirst(s('a', { name: undefined }), s('b'), 'name')).not.toThrow();
  });
});

describe('foldersFirstIn', () => {
  const asRow = (original) => ({ original, getValue: (id) => original[id] });
  const f = (name) => asRow(toFolderRow(folder({ _id: name, name })));
  const s = (name, over = {}) => asRow(toSlideRow(slide({ _id: name, name, ...over })));

  // The point of these cases is what table-core does AFTER the sortingFn returns, so they model
  // it rather than calling the comparator bare. Testing the comparator on its own is exactly how
  // the descending bug stayed invisible: the negation below is where it lived.
  const sorted = (rows, columnId, desc) => {
    const fn = foldersFirstIn(desc);
    return [...rows]
      .sort((a, b) => {
        const n = fn(a, b, columnId);
        return desc ? n * -1 : n;
      })
      .map((r) => r.original.name);
  };

  const MIXED = [s('b.svs'), f('case-2'), s('a.svs'), f('case-10')];

  it('leads with folders ascending', () => {
    expect(sorted(MIXED, 'name', false)).toEqual(['case-2', 'case-10', 'a.svs', 'b.svs']);
  });

  it('still leads with folders descending, which is the whole reason it exists', () => {
    expect(sorted(MIXED, 'name', true)).toEqual(['case-10', 'case-2', 'b.svs', 'a.svs']);
  });

  it('reverses within each group descending, since that is what the user asked for', () => {
    const slides = [s('a.svs'), s('c.svs'), s('b.svs')];
    expect(sorted(slides, 'name', false)).toEqual(['a.svs', 'b.svs', 'c.svs']);
    expect(sorted(slides, 'name', true)).toEqual(['c.svs', 'b.svs', 'a.svs']);
  });

  it('sorts a numeric column as numbers in both directions', () => {
    const rows = [s('mid', { size: 1e9 }), s('big', { size: 2e9 }), s('small', { size: 9e8 })];
    expect(sorted(rows, 'size', false)).toEqual(['small', 'mid', 'big']);
    expect(sorted(rows, 'size', true)).toEqual(['big', 'mid', 'small']);
  });

  it('defaults to ascending, so it drops in where foldersFirst was', () => {
    expect(foldersFirstIn()(f('zzz'), s('aaa'), 'name')).toBeLessThan(0);
  });
});
