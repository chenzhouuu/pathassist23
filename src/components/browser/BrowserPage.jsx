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
import React, { useCallback, useMemo, useState } from 'react';
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
import CollectionTree from './CollectionTree.jsx';
import SlideGrid from './SlideGrid.jsx';
import PreviewPane from './PreviewPane.jsx';
import ImportModal from './ImportModal.jsx';
import NewEntryDialog from './NewEntryDialog.jsx';
import SharePatientModal from '../share/SharePatientModal.jsx';
import { buildColumns, HIDDEN_BY_DEFAULT } from './browserColumns.jsx';
import { useBrowseNavigation } from './useBrowseNavigation.js';
import { useSurfaceTheme } from './useSurfaceTheme.js';
import {
  toFolderRow, toSlideRow, filterRows, isSlideRow, foldersFirstIn, STATUSES,
} from './browseUtils.js';

export default function BrowserPage() {
  const qc = useQueryClient();
  const { setActiveItem, setActiveFolder, user } = useStore();

  // This page, and only this page, is Graphite. The hook marks the document for as long as the
  // page is mounted and unmarks it on the way out, which is what leaves the Viewer in its own
  // reading-room palette without a single rule in browser/ knowing the Viewer exists.
  const { mode, toggleMode } = useSurfaceTheme('browser');

  // Table or grid. It lives here rather than in `useBrowseNavigation` because it is not navigation:
  // the hook holds where we are pointing and what that position implies, and it clears every one of
  // those on a level change, because a status filter carried into another folder silently hides its
  // contents. A view mode carried into another folder is the *opposite* — it is the thing the user
  // chose about how to look, and resetting it on every step into a case folder is precisely the bug
  // the ticket forbids. It is presentation, like the rail's expansion state; unlike that one it
  // cannot live inside a single component, because the control is in the toolbar and the rendering
  // is in the body, and this is the smallest place both can see.
  const [viewMode, setViewMode] = useState('table');
  const [columnVisibility, setColumnVisibility] = useState(HIDDEN_BY_DEFAULT);
  const [sorting, setSorting] = useState([{ id: 'name', desc: false }]);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [shareFolder, setShareFolder] = useState(null);

  // Where we are, what is filtered, what is selected. Backspace ascends, so the hook has to be
  // told when a dialog is up: the listener is on window and would otherwise navigate underneath
  // one, leaving NewEntryDialog offering to create in a level that is no longer showing.
  const {
    collection, path, level, folder, crumbs,
    search, debouncedSearch, status, setSearch, setStatus,
    selectedId, rowSelection, select, setRowSelection, clearRowSelection,
    overrides, setOverrides, descend, goToCrumb, goTo,
  } = useBrowseNavigation({ suppressBackspace: showImport || showNew || !!shareFolder });

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

  const visible = useMemo(
    () => filterRows(rows, { search: debouncedSearch, status }),
    [rows, debouncedSearch, status],
  );

  // A slide row is not navigation, so it never reaches the hook: it is the end of the walk, and
  // all that is left is to hand the viewer its context and leave.
  const open = useCallback((row) => {
    if (isSlideRow(row)) {
      setActiveFolder(folder);
      setActiveItem(row.raw);
      return;
    }
    descend(row);
  }, [descend, folder, setActiveItem, setActiveFolder]);

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

  // Status, Scan and Size describe a slide. On a level that holds only collections or folders they
  // are three empty columns eating the width Name wants, so they are hidden until there is
  // something to put in them. This is derived rather than pushed into `columnVisibility`, so a
  // user's own choice in the Columns menu survives walking through a level that had no slides.
  const effectiveVisibility = useMemo(() => (
    visible.some(isSlideRow)
      ? columnVisibility
      : { ...columnVisibility, status: false, scan: false, size: false }
  ), [visible, columnVisibility]);

  // The sort direction has to be closed over rather than read inside the comparator, because
  // @tanstack's sortingFn signature does not carry it — and it matters here. table-core negates
  // the whole comparator result for a descending column, kind grouping included, so the plain
  // `foldersFirst` sends folders to the bottom the moment you sort Name descending. See
  // `foldersFirstIn` for what it does about that.
  const sortDesc = sorting[0]?.desc ?? false;
  const sortingFns = useMemo(() => ({ foldersFirst: foldersFirstIn(sortDesc) }), [sortDesc]);

  const table = useReactTable({
    data: visible,
    columns,
    state: { sorting, columnVisibility: effectiveVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getRowId: (r) => r.id,
    enableRowSelection: (r) => isSlideRow(r.original),
    sortingFns,
    defaultColumn: { sortingFn: 'foldersFirst' },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const selectedRow = visible.find((r) => r.id === selectedId) || null;
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const loading = collections.isLoading || folders.isLoading || items.isLoading;
  const error = collections.error || folders.error || items.error;

  return (
    <div className="browser-shell">
      <BrowserTopBar
        search={search}
        onSearch={setSearch}
        user={user}
        mode={mode}
        onToggleMode={toggleMode}
      />

      <BrowserToolbar
        crumbs={crumbs}
        onCrumb={goToCrumb}
        showStatusFilter={level === 'items'}
        status={status}
        onStatus={setStatus}
        columns={table.getAllColumns().filter((c) => c.getCanHide())}
        view={viewMode}
        onView={setViewMode}
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
          <Button variant="ghost" size="sm" onClick={clearRowSelection}>
            <X size={14} /> Cancel
          </Button>
        </div>
      )}

      <div className="browser-body">
        {/* The rail is handed the position and a way to change it, and keeps everything else to
            itself — which branches are open is the rail's own business and nothing on this page
            reads it. See CollectionTree.jsx for why those are two pieces of state and not one. */}
        <CollectionTree collection={collection} path={path} onNavigate={goTo} />

        <div className="browser-table-wrap">
          {error ? (
            <div className="browser-empty">
              <p>Could not load this level.</p>
              <p className="browser-empty-sub">{String(error.message || error)}</p>
            </div>
          ) : viewMode === 'grid' ? (
            // Fed from the table's own row model rather than from `visible`, so the two views are
            // the same rows in the same order. The grid has no header to sort by, and a switch that
            // silently reshuffled the level would make the sort look like a property of the table
            // rather than of the level.
            <SlideGrid
              rows={table.getRowModel().rows.map((r) => r.original)}
              selectedId={selectedId}
              onSelect={select}
              onOpen={open}
            />
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
                    onClick={() => select(r.original.id)}
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
