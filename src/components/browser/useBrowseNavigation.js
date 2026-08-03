// src/components/browser/useBrowseNavigation.js
// Where the browser is pointing, what it is filtering on, and what is selected — one hook.
//
// This is BrowserPage's state, lifted out of it. The page is about to grow a folder tree, a
// resizable preview and a grid view, and each of those brings state of its own; keeping the
// navigation here means they land beside it rather than on top of it. It also makes the rules
// below — what a level change clears, what Backspace does — testable without rendering a table.
//
// The pair is held locally rather than in the store because nothing outside this page needs to
// know where the browser is pointing. The store's activeCollection/activeFolder are set on the
// way out, for the viewer's sidebar.
//
// The navigation state itself is `(collection, path[])` and every question about position is
// answered from that pair — see browseUtils.js, which owns the pure half of the answers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { crumbsFor, levelOf, parentOf } from './browseUtils.js';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * The browser's position, filters and selection.
 *
 * @param {{ suppressBackspace?: boolean }} options — `suppressBackspace` holds the Backspace
 *   shortcut while the page has a dialog open. The hook cannot see the page's dialogs, so the
 *   page tells it.
 */
export function useBrowseNavigation({ suppressBackspace = false } = {}) {
  const [collection, setCollection] = useState(null);
  const [path, setPath] = useState([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [selectedId, setSelectedId] = useState(null);
  const [rowSelection, setRowSelection] = useState({});
  const [overrides, setOverrides] = useState({});   // itemId → freshly written meta
  const searchTimer = useRef(null);

  const level = levelOf(collection, path);
  const folder = path[path.length - 1] || null;
  const crumbs = crumbsFor(collection, path);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(searchTimer.current);
  }, [search]);

  // Moving to another level is a different set of rows, so nothing about the old one carries:
  // a status filter from the previous folder would silently hide the new one's contents.
  useEffect(() => {
    setSearch(''); setDebouncedSearch(''); setStatus('All');
    setSelectedId(null); setRowSelection({}); setOverrides({});
  }, [collection?._id, folder?._id]);

  // Go into a row. Folders and collections only: a slide row is the end of the walk rather than a
  // step in it, so what happens to it stays with the page that holds the viewer's store.
  const descend = useCallback((row) => {
    if (level === 'collections') { setCollection(row.raw); setPath([]); return; }
    setPath((p) => [...p, row.raw]);
  }, [level]);

  const ascend = useCallback(() => {
    const up = parentOf(collection, path);
    setCollection(up.collection);
    setPath(up.path);
  }, [collection, path]);

  // Jump straight to any crumb: index 0 is the root, 1 the collection, the rest folders.
  const goToCrumb = useCallback((i) => {
    if (i === 0) { setCollection(null); setPath([]); return; }
    setPath(path.slice(0, i - 1));
  }, [path]);

  const select = useCallback((id) => setSelectedId(id), []);

  // The batch bar's Cancel. It drops the checkbox set and leaves the previewed row alone: that
  // one was picked separately, and clearing it would empty the preview pane as a side effect.
  const clearRowSelection = useCallback(() => setRowSelection({}), []);

  // Backspace goes up a level, the way a file manager does — the breadcrumb is the visible route
  // back, this is the one that does not need aiming.
  //
  // Suspended while a dialog is open. The listener is on window, so it fires for a keypress aimed
  // at the dialog, and navigating underneath one is not merely untidy: NewEntryDialog reads the
  // current level from props, so a stray Backspace turns "new folder in this case" into "new
  // collection at the root" with the dialog still showing the old heading.
  useEffect(() => {
    if (suppressBackspace) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Backspace') return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      ascend();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ascend, suppressBackspace]);

  return {
    // Position, and what browseUtils derives from it.
    collection,
    path,
    level,
    folder,
    crumbs,
    // Filters. `search` follows the input; `debouncedSearch` is the one to filter rows on.
    search,
    debouncedSearch,
    status,
    setSearch,
    setStatus,
    // Selection: `selectedId` is the previewed row, `rowSelection` the batch set react-table owns
    // (so its setter is passed through raw — the table calls it with an updater).
    selectedId,
    rowSelection,
    select,
    setRowSelection,
    clearRowSelection,
    // Optimistic item meta, itemId → freshly written meta, until the refetch corrects it.
    overrides,
    setOverrides,
    // Moves.
    descend,
    ascend,
    goToCrumb,
  };
}
