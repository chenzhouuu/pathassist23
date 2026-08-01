// src/components/browser/BrowserPage.jsx
// The application's landing page: one table that walks the Girder hierarchy.
//
// This replaces the Dashboard. The old page opened on metrics, hero copy and gradient cards and
// put the actual work — finding a slide — one click further away; every number on it was also a
// second, drifting source of truth for counts the browser already shows. What a pathologist
// arrives to do is open a slide, so that is what the landing page does.
//
// Structure follows the file-manager convention rather than a bespoke layout: breadcrumb for
// where you are, one table for what is here, a preview pane for what is selected. The table is
// assembled from the OHIF ui-next primitives in src/components/ui (MIT) driven by
// @tanstack/react-table, which is the same engine OHIF's own StudyList runs on. Navigation is
// this repo's own: OHIF's study list is flat, so it has no breadcrumb to borrow.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  flexRender, getCoreRowModel, getSortedRowModel, useReactTable,
} from '@tanstack/react-table';
import { X } from 'lucide-react';
import { useStore } from '../../store/index.js';
import { getCollections, getFolders, getItems, updateItemMetadata } from '../../api/index.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.tsx';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import BrowserTopBar from './BrowserTopBar.jsx';
import BrowserToolbar from './BrowserToolbar.jsx';
import PreviewPane from './PreviewPane.jsx';
import ImportModal from './ImportModal.jsx';
import NewEntryDialog from './NewEntryDialog.jsx';
import SharePatientModal from '../share/SharePatientModal.jsx';
import { buildColumns, HIDDEN_BY_DEFAULT } from './browserColumns.jsx';
import {
  crumbsFor, levelOf, parentOf, toFolderRow, toSlideRow, filterRows, isSlideRow, foldersFirst,
  STATUSES,
} from './browseUtils.js';

const SEARCH_DEBOUNCE_MS = 300;

export default function BrowserPage() {
  const qc = useQueryClient();
  const { setActiveItem, setActiveFolder, user } = useStore();

  // Navigation is a (collection, path) pair — see browseUtils. Held locally rather than in the
  // store because nothing outside this page needs to know where the browser is pointing; the
  // store's activeCollection/activeFolder are set on the way out, for the viewer's sidebar.
  const [collection, setCollection] = useState(null);
  const [path, setPath] = useState([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('All');
  const [selectedId, setSelectedId] = useState(null);
  const [rowSelection, setRowSelection] = useState({});
  const [columnVisibility, setColumnVisibility] = useState(HIDDEN_BY_DEFAULT);
  const [sorting, setSorting] = useState([{ id: 'name', desc: false }]);
  const [overrides, setOverrides] = useState({});   // itemId → freshly written meta
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [shareFolder, setShareFolder] = useState(null);
  const searchTimer = useRef(null);

  const level = levelOf(collection, path);
  const folder = path[path.length - 1] || null;

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(searchTimer.current);
  }, [search]);

  // Moving to another level is a different set of rows, so nothing about the old one carries:
  // a status filter from the previous folder would silently hide the new one's contents.
  useEffect(() => {
    setSearch(''); setDebounced(''); setStatus('All');
    setSelectedId(null); setRowSelection({}); setOverrides({});
  }, [collection?._id, folder?._id]);

  // Always fetched, not just at the root: the Import dialog needs the collection list to offer a
  // destination, and it can be opened from any level.
  const collections = useQuery({
    queryKey: ['browser', 'collections'],
    queryFn: getCollections,
  });

  const folders = useQuery({
    queryKey: ['browser', 'folders', collection?._id, folder?._id],
    queryFn: () => (folder ? getFolders('folder', folder._id) : getFolders('collection', collection._id)),
    enabled: !!collection,
  });

  // Sub-folders and slides live at the same level in Girder, so a folder shows both. Nothing
  // says a case folder cannot hold blocks AND loose slides, and hiding either would lose them.
  const items = useQuery({
    queryKey: ['browser', 'items', folder?._id],
    queryFn: () => getItems(folder._id, 0, 500),
    enabled: !!folder,
  });

  const rows = useMemo(() => {
    if (level === 'collections') return (collections.data || []).map(toFolderRow);
    const out = (folders.data || []).map(toFolderRow);
    if (level === 'items') {
      const ctx = { folderPath: folder?.name || null, collectionName: collection?.name || null };
      for (const it of items.data || []) {
        const merged = overrides[it._id] ? { ...it, meta: overrides[it._id] } : it;
        out.push(toSlideRow(merged, ctx));
      }
    }
    return out;
  }, [level, collections.data, folders.data, items.data, overrides, folder, collection]);

  const visible = useMemo(() => filterRows(rows, { search: debounced, status }), [rows, debounced, status]);

  const open = useCallback((row) => {
    if (isSlideRow(row)) {
      // Hand the viewer the context it needs for its sidebar before leaving.
      setActiveFolder(folder);
      setActiveItem(row.raw);
      return;
    }
    if (level === 'collections') { setCollection(row.raw); setPath([]); return; }
    setPath((p) => [...p, row.raw]);
  }, [level, folder, setActiveItem, setActiveFolder]);

  // Backspace goes up a level, the way a file manager does — the breadcrumb is the visible route
  // back, this is the one that does not need aiming.
  //
  // Suspended while a dialog is open. The listener is on window, so it fires for a keypress aimed
  // at the dialog, and navigating underneath one is not merely untidy: NewEntryDialog reads the
  // current level from props, so a stray Backspace turns "new folder in this case" into "new
  // collection at the root" with the dialog still showing the old heading.
  const modalOpen = showImport || showNew || !!shareFolder;

  useEffect(() => {
    if (modalOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Backspace') return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const up = parentOf(collection, path);
      setCollection(up.collection);
      setPath(up.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collection, path, modalOpen]);

  // Jump straight to any crumb: index 0 is the root, 1 the collection, the rest folders.
  const goToCrumb = useCallback((i) => {
    if (i === 0) { setCollection(null); setPath([]); return; }
    setPath(path.slice(0, i - 1));
  }, [path]);

  const writeStatus = useCallback(async (ids, next) => {
    const list = Array.isArray(ids) ? ids : [ids];
    // Optimistic: the table shows the new status immediately and the query cache is invalidated
    // afterwards, so a failed write is corrected by the refetch rather than left showing a lie.
    setOverrides((prev) => {
      const draft = { ...prev };
      for (const id of list) {
        const row = rows.find((r) => r.id === id);
        draft[id] = { ...(row?.raw?.meta || {}), status: next };
      }
      return draft;
    });
    await Promise.allSettled(list.map((id) => {
      const row = rows.find((r) => r.id === id);
      return updateItemMetadata(id, { ...(row?.raw?.meta || {}), status: next });
    }));
    qc.invalidateQueries({ queryKey: ['browser', 'items', folder?._id] });
  }, [rows, qc, folder]);

  const columns = useMemo(() => buildColumns({ onOpen: open }), [open]);

  // Status and Size describe a slide. On a level that holds only collections or folders they are
  // two empty columns eating the width Name wants, so they are hidden until there is something to
  // put in them. This is derived rather than pushed into `columnVisibility`, so a user's own
  // choice in the Columns menu survives walking through a level that had no slides.
  const effectiveVisibility = useMemo(() => (
    visible.some(isSlideRow) ? columnVisibility : { ...columnVisibility, status: false, size: false }
  ), [visible, columnVisibility]);

  const table = useReactTable({
    data: visible,
    columns,
    state: { sorting, columnVisibility: effectiveVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getRowId: (r) => r.id,
    enableRowSelection: (r) => isSlideRow(r.original),
    sortingFns: { foldersFirst },
    defaultColumn: { sortingFn: 'foldersFirst' },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const crumbs = crumbsFor(collection, path);
  const selectedRow = visible.find((r) => r.id === selectedId) || null;
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const loading = collections.isLoading || folders.isLoading || items.isLoading;
  const error = collections.error || folders.error || items.error;

  return (
    <div className="browser-shell">
      <BrowserTopBar search={search} onSearch={setSearch} user={user} />

      <BrowserToolbar
        crumbs={crumbs}
        onCrumb={goToCrumb}
        showStatusFilter={level === 'items'}
        status={status}
        onStatus={setStatus}
        columns={table.getAllColumns().filter((c) => c.getCanHide())}
        inCollection={!!collection}
        onNew={() => setShowNew(true)}
        onImport={() => setShowImport(true)}
      />

      {selectedIds.length > 0 && (
        <div className="browser-batchbar" role="status">
          <span>{selectedIds.length} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm">Set status</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {STATUSES.filter((s) => s !== 'All').map((s) => (
                <DropdownMenuItem key={s} onSelect={() => writeStatus(selectedIds, s)}>{s}</DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => writeStatus(selectedIds, null)}>Clear</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
            <X size={14} /> Cancel
          </Button>
        </div>
      )}

      <div className="browser-body">
        <div className="browser-table-wrap">
          {error ? (
            <div className="browser-empty">
              <p>Could not load this level.</p>
              <p className="browser-empty-sub">{String(error.message || error)}</p>
            </div>
          ) : (
            <Table noScroll>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((h) => (
                      <TableHead
                        key={h.id}
                        style={h.column.columnDef.size ? { width: h.column.columnDef.size } : undefined}
                        onClick={h.column.getCanSort() ? h.column.getToggleSortingHandler() : undefined}
                        className={h.column.getCanSort() ? 'is-sortable' : undefined}
                        aria-sort={
                          h.column.getIsSorted() === 'asc' ? 'ascending'
                            : h.column.getIsSorted() === 'desc' ? 'descending' : undefined
                        }
                      >
                        {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((r) => (
                  <TableRow
                    key={r.id}
                    data-selected={r.original.id === selectedId ? '' : undefined}
                    onClick={() => setSelectedId(r.original.id)}
                    onDoubleClick={() => open(r.original)}
                  >
                    {r.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!error && !loading && visible.length === 0 && (
            <div className="browser-empty">
              <p>{rows.length ? 'Nothing matches the current filters.' : 'This level is empty.'}</p>
              {rows.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus('All'); }}>
                  Clear filters
                </Button>
              )}
            </div>
          )}
          {loading && <div className="browser-empty"><p>Loading…</p></div>}
        </div>

        <PreviewPane
          row={selectedRow}
          onOpen={open}
          onStatus={(s) => writeStatus(selectedRow.id, s)}
          onShare={setShareFolder}
        />
      </div>

      {showNew && (
        <NewEntryDialog
          collection={collection}
          folder={folder}
          onClose={() => setShowNew(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ['browser'] })}
        />
      )}
      {showImport && (
        <ImportModal
          collections={collections.data || []}
          onClose={() => setShowImport(false)}
          onImported={() => qc.invalidateQueries({ queryKey: ['browser'] })}
        />
      )}
      {shareFolder && <SharePatientModal folder={shareFolder} onClose={() => setShareFolder(null)} />}
    </div>
  );
}
