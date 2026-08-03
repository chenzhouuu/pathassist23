import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBrowseNavigation } from './useBrowseNavigation.js';

const COLLECTION = { _id: 'c1', name: 'BRCA-DEMO' };
const CASE = { _id: 'f1', name: 'Case 001' };
const BLOCK = { _id: 'f2', name: 'Block A' };

const folderRow = (raw) => ({ id: raw._id, name: raw.name, kind: 'folder', raw });

/** Render with the dialog suppression the page passes, so the flag can be flipped mid-test. */
const render = (suppressBackspace = false) => renderHook(
  (props) => useBrowseNavigation(props),
  { initialProps: { suppressBackspace } },
);

const backspaceOn = (target = window) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('useBrowseNavigation — walking down', () => {
  it('starts at the root, where the only crumb is the way back to itself', () => {
    const { result } = render();
    expect(result.current.level).toBe('collections');
    expect(result.current.folder).toBeNull();
    expect(result.current.crumbs.map((c) => c.name)).toEqual(['All collections']);
  });

  it('descends into a collection, then a folder, and the crumbs follow', () => {
    const { result } = render();

    act(() => result.current.descend(folderRow(COLLECTION)));
    expect(result.current.level).toBe('folders');
    expect(result.current.collection).toBe(COLLECTION);
    expect(result.current.crumbs.map((c) => c.name)).toEqual(['All collections', 'BRCA-DEMO']);

    act(() => result.current.descend(folderRow(CASE)));
    expect(result.current.level).toBe('items');
    expect(result.current.folder).toBe(CASE);
    expect(result.current.crumbs.map((c) => c.name)).toEqual(['All collections', 'BRCA-DEMO', 'Case 001']);

    // Sub-folders keep going: a case can hold blocks, and the level stays 'items' because a
    // block folder shows sub-folders and slides side by side.
    act(() => result.current.descend(folderRow(BLOCK)));
    expect(result.current.path.map((f) => f._id)).toEqual(['f1', 'f2']);
    expect(result.current.folder).toBe(BLOCK);
  });
});

describe('useBrowseNavigation — walking up', () => {
  it('ascends out of a folder into the one above it', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    act(() => result.current.descend(folderRow(CASE)));
    act(() => result.current.descend(folderRow(BLOCK)));

    act(() => result.current.ascend());
    expect(result.current.folder).toBe(CASE);

    act(() => result.current.ascend());
    expect(result.current.folder).toBeNull();
    expect(result.current.level).toBe('folders');
  });

  it('ascends out of a collection back to the root', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    act(() => result.current.ascend());
    expect(result.current.collection).toBeNull();
    expect(result.current.level).toBe('collections');
  });

  it('ascending at the root stays at the root rather than going negative', () => {
    const { result } = render();
    act(() => result.current.ascend());
    act(() => result.current.ascend());
    expect(result.current.collection).toBeNull();
    expect(result.current.path).toEqual([]);
    expect(result.current.level).toBe('collections');
  });
});

describe('useBrowseNavigation — breadcrumb jumps', () => {
  const atBlock = () => {
    const rendered = render();
    act(() => rendered.result.current.descend(folderRow(COLLECTION)));
    act(() => rendered.result.current.descend(folderRow(CASE)));
    act(() => rendered.result.current.descend(folderRow(BLOCK)));
    return rendered;
  };

  it('index 0 is the root, which drops the collection as well as the path', () => {
    const { result } = atBlock();
    act(() => result.current.goToCrumb(0));
    expect(result.current.collection).toBeNull();
    expect(result.current.path).toEqual([]);
  });

  it('index 1 is the collection, so the whole folder path is dropped', () => {
    const { result } = atBlock();
    act(() => result.current.goToCrumb(1));
    expect(result.current.collection).toBe(COLLECTION);
    expect(result.current.path).toEqual([]);
    expect(result.current.level).toBe('folders');
  });

  it('index 2 is the first folder, so only what is below it is dropped', () => {
    const { result } = atBlock();
    act(() => result.current.goToCrumb(2));
    expect(result.current.folder).toBe(CASE);
    expect(result.current.path.map((f) => f._id)).toEqual(['f1']);
  });
});

describe('useBrowseNavigation — changing level', () => {
  it('clears the filters, the selection and the optimistic overrides', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));

    act(() => {
      result.current.setSearch('TCGA');
      result.current.setStatus('Flagged');
      result.current.select('item-1');
      result.current.setRowSelection({ 'item-1': true });
      result.current.setOverrides({ 'item-1': { status: 'Read' } });
    });
    expect(result.current.search).toBe('TCGA');

    // A status filter carried in from the previous folder would silently hide the new one's
    // contents, so the move resets everything the old level was showing through.
    act(() => result.current.descend(folderRow(CASE)));
    expect(result.current.search).toBe('');
    expect(result.current.debouncedSearch).toBe('');
    expect(result.current.status).toBe('All');
    expect(result.current.selectedId).toBeNull();
    expect(result.current.rowSelection).toEqual({});
    expect(result.current.overrides).toEqual({});
  });

  it('leaves the filters alone while the level stays put', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    act(() => result.current.descend(folderRow(CASE)));
    act(() => {
      result.current.setStatus('In Review');
      result.current.select('item-9');
    });
    expect(result.current.status).toBe('In Review');
    expect(result.current.selectedId).toBe('item-9');
  });

  it('clearing the row selection leaves the previewed row alone', () => {
    const { result } = render();
    act(() => {
      result.current.select('item-1');
      result.current.setRowSelection({ 'item-1': true, 'item-2': true });
    });
    act(() => result.current.clearRowSelection());
    expect(result.current.rowSelection).toEqual({});
    expect(result.current.selectedId).toBe('item-1');
  });
});

describe('useBrowseNavigation — Backspace', () => {
  it('ascends a level', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    act(() => result.current.descend(folderRow(CASE)));

    backspaceOn();
    expect(result.current.folder).toBeNull();
    backspaceOn();
    expect(result.current.collection).toBeNull();
  });

  it('is held while a dialog is open, so NewEntryDialog cannot outlive the level it names', () => {
    const { result, rerender } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    rerender({ suppressBackspace: true });

    backspaceOn();
    expect(result.current.collection).toBe(COLLECTION);

    rerender({ suppressBackspace: false });
    backspaceOn();
    expect(result.current.collection).toBeNull();
  });

  it('is ignored while a text field has focus — that Backspace is deleting a character', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));

    for (const tag of ['input', 'textarea']) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      backspaceOn(el);
      expect(result.current.collection).toBe(COLLECTION);
    }

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not implement isContentEditable off the attribute, so it is set directly.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.appendChild(editable);
    backspaceOn(editable);
    expect(result.current.collection).toBe(COLLECTION);
  });

  it('leaves other keys to whoever wants them', () => {
    const { result } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(result.current.collection).toBe(COLLECTION);
  });

  it('stops listening once unmounted', () => {
    const { result, unmount } = render();
    act(() => result.current.descend(folderRow(COLLECTION)));
    unmount();
    backspaceOn();
    expect(result.current.collection).toBe(COLLECTION);
  });
});

describe('useBrowseNavigation — search debounce', () => {
  it('holds the filtering copy back until the typing stops', () => {
    vi.useFakeTimers();
    const { result } = render();

    act(() => result.current.setSearch('T'));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.setSearch('TCGA'));
    act(() => vi.advanceTimersByTime(200));
    // The first keystroke's timer was cancelled by the second, so nothing has filtered yet.
    expect(result.current.search).toBe('TCGA');
    expect(result.current.debouncedSearch).toBe('');

    act(() => vi.advanceTimersByTime(100));
    expect(result.current.debouncedSearch).toBe('TCGA');
  });
});
