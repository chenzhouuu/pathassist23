// src/components/worklist/WorklistPage.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useStore } from '../../store/index.js';
import { getCollections, getFolders, getItems, updateItemMetadata, getTilesInfoSafe } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';
import LeftSidebar from '../sidebar/LeftSidebar.jsx';
import ThemeSwitcher from '../ThemeSwitcher.jsx';

const PAGE_SIZE = 48;

const STATUS_CONFIG = {
  'For Review': { color: '#4da6ff', bg: 'rgba(77,166,255,0.12)',  border: 'rgba(77,166,255,0.25)' },
  'Pending':    { color: '#f5a623', bg: 'rgba(245,166,35,0.12)',  border: 'rgba(245,166,35,0.25)' },
  'QC':         { color: '#c27aff', bg: 'rgba(194,122,255,0.12)', border: 'rgba(194,122,255,0.25)' },
  'Completed':  { color: '#4caf82', bg: 'rgba(76,175,130,0.12)',  border: 'rgba(76,175,130,0.25)' },
  'STAT':       { color: '#e94560', bg: 'rgba(233,69,96,0.12)',   border: 'rgba(233,69,96,0.25)' },
};

function StatusBadge({ status }) {
  if (!status) return null;
  const cfg = STATUS_CONFIG[status] || { color: '#6b7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.25)' };
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium whitespace-nowrap"
      style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}` }}>
      {status}
    </span>
  );
}

// ── Folder card (shown when collection is selected but no folder) ─────────────
function FolderCard({ folder, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 p-4 rounded-xl text-left w-full transition-all"
      style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(77,166,255,0.4)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(77,166,255,0.25)"
        stroke="#4da6ff" strokeWidth="1.5" style={{ flexShrink: 0 }}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-white truncate">{folder.name}</div>
        {folder.nItems > 0 && (
          <div className="text-xs text-gray-600 font-mono mt-0.5">
            {folder.nItems} image{folder.nItems !== 1 ? 's' : ''}
          </div>
        )}
      </div>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" style={{ flexShrink: 0 }}>
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}

// ── Thumbnail card ────────────────────────────────────────────────────────────
function ThumbnailCard({ item, collectionName, folderPath, onOpen, onStatusChange, selected, onToggleSelect }) {
  const token = localStorage.getItem('girderToken') || '';
  const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=320&height=240&token=${token}`;
  const [imgError, setImgError] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const status = item.meta?.status || null;
  const priority = item.meta?.priority || null;

  const handleStatus = async (newStatus) => {
    setSaving(true);
    try {
      await updateItemMetadata(item._id, { ...item.meta, status: newStatus });
      onStatusChange(item._id, { ...item.meta, status: newStatus });
    } catch (e) { console.error(e); }
    setSaving(false);
    setShowMenu(false);
  };

  return (
    <div className="group relative flex flex-col rounded-xl overflow-hidden transition-all duration-200"
      style={{
        background: 'var(--bg-panel)',
        border: `1px solid ${selected ? 'rgba(77,166,255,0.7)' : hovered ? 'rgba(77,166,255,0.4)' : 'var(--border)'}`,
        boxShadow: selected ? '0 0 0 2px rgba(77,166,255,0.15)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShowMenu(false); }}>

      {/* Thumbnail */}
      <div className="relative overflow-hidden cursor-pointer" style={{ paddingBottom: '60%', background: 'var(--bg-viewer)' }}
        onClick={() => onOpen(item)}>

        {/* Compare select button — top-left */}
        <button
          className={`absolute top-2 left-2 z-10 w-6 h-6 rounded flex items-center justify-center transition-all ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          style={{
            background: selected ? '#4da6ff' : 'rgba(0,0,0,0.55)',
            border: `1px solid ${selected ? '#4da6ff' : 'rgba(255,255,255,0.35)'}`,
          }}
          onClick={e => { e.stopPropagation(); onToggleSelect(item); }}
          title={selected ? 'Remove from comparison' : 'Select for comparison'}>
          {selected ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          )}
        </button>
        {!imgError ? (
          <img src={thumbUrl} alt={item.name} onError={() => setImgError(true)}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"/>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1e2130" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <circle cx="8.5" cy="9" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
            <span className="text-xs text-gray-700 px-2 text-center leading-tight">{item.name}</span>
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="flex items-center gap-1.5 text-xs text-white font-medium px-3 py-1.5 rounded-lg"
            style={{ background: 'rgba(77,166,255,0.3)', border: '1px solid rgba(77,166,255,0.4)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            Open Viewer
          </div>
        </div>
        {status && <div className="absolute top-2 right-2"><StatusBadge status={status}/></div>}
        {priority === 'STAT' && (
          <div className="absolute top-2 left-2">
            <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ background: '#e94560', color: 'white' }}>STAT</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 flex flex-col gap-1.5">
        <div className="text-xs font-medium text-white leading-tight truncate" title={item.name}>{item.name}</div>
        <div className="flex items-center gap-1 flex-wrap">
          {collectionName && <span className="text-xs text-gray-600 truncate max-w-[100px]">{collectionName}</span>}
          {folderPath && <><span className="text-gray-700 text-xs">/</span><span className="text-xs text-gray-700 truncate max-w-[80px]">{folderPath}</span></>}
        </div>
        <div className="flex items-center justify-between mt-1">
          <StatusBadge status={status || 'No Status'}/>
          <div className="relative">
            <button onClick={() => setShowMenu(!showMenu)}
              className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs transition-all px-1.5 py-0.5 rounded hover:bg-black/5" style={{ color: 'var(--muted)' }}>
              {saving ? <div className="spinner" style={{ width: 10, height: 10 }}/> : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              )}
              Status
            </button>
            {showMenu && (
              <div className="absolute bottom-full right-0 mb-1 rounded-lg overflow-hidden z-50"
                style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', minWidth: 130 }}>
                {Object.keys(STATUS_CONFIG).map(s => (
                  <button key={s} onClick={() => handleStatus(s)}
                    className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-black/5 flex items-center gap-2" style={{ color: 'var(--text)' }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: STATUS_CONFIG[s].color }}/>{s}
                  </button>
                ))}
                {status && (
                  <button onClick={() => handleStatus(null)}
                    className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-black/5 border-t"
                    style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>
                    Clear status
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Table row ──────────────────────────────────────────────────────────────────
function TableRow({ item, collectionName, folderPath, onOpen, onStatusChange, index }) {
  const token = localStorage.getItem('girderToken') || '';
  const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=80&height=60&token=${token}`;
  const status = item.meta?.status || null;
  const [showMenu, setShowMenu] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleStatus = async (newStatus) => {
    setSaving(true);
    try {
      await updateItemMetadata(item._id, { ...item.meta, status: newStatus });
      onStatusChange(item._id, { ...item.meta, status: newStatus });
    } catch (e) {}
    setSaving(false);
    setShowMenu(false);
  };

  return (
    <tr className="group border-b transition-colors" style={{ borderColor: 'var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--highlight)'}
      onMouseLeave={e => { e.currentTarget.style.background = ''; setShowMenu(false); }}>
      <td className="px-3 py-2.5 text-xs font-mono text-gray-700 w-8">{index + 1}</td>
      <td className="px-2 py-2 w-16">
        <div className="w-14 h-10 rounded overflow-hidden bg-gray-900 cursor-pointer" onClick={() => onOpen(item)}>
          <img src={thumbUrl} alt="" className="w-full h-full object-cover" onError={e => { e.target.style.display = 'none'; }}/>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="text-xs font-medium cursor-pointer hover:text-blue-400 transition-colors truncate max-w-[180px]"
          style={{ color: '#4da6ff' }} onClick={() => onOpen(item)}>
          {item.name}
        </div>
        <div className="text-xs text-gray-700 font-mono mt-0.5">{item._id.slice(-8)}</div>
      </td>
      <td className="px-3 py-2.5">
        <div className="relative">
          <button onClick={() => setShowMenu(!showMenu)} className="flex items-center gap-1">
            <StatusBadge status={status || 'No Status'}/>
            {!saving && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" className="group-hover:stroke-gray-400"><polyline points="6 9 12 15 18 9"/></svg>}
            {saving && <div className="spinner" style={{ width: 9, height: 9 }}/>}
          </button>
          {showMenu && (
            <div className="absolute top-full left-0 mt-1 z-50 rounded-lg overflow-hidden"
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', minWidth: 130 }}>
              {Object.keys(STATUS_CONFIG).map(s => (
                <button key={s} onClick={() => handleStatus(s)}
                  className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-black/5 flex items-center gap-2" style={{ color: 'var(--text)' }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: STATUS_CONFIG[s].color }}/>{s}
                </button>
              ))}
              {status && <button onClick={() => handleStatus(null)} className="w-full text-left px-3 py-2 text-xs transition-colors border-t" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>Clear</button>}
            </div>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500 hidden md:table-cell max-w-[120px]"><div className="truncate">{collectionName}</div></td>
      <td className="px-3 py-2.5 text-xs text-gray-600 hidden lg:table-cell max-w-[120px]"><div className="truncate">{folderPath}</div></td>
      <td className="px-3 py-2.5 text-xs text-gray-600 font-mono hidden md:table-cell">
        {item.size ? `${(item.size / 1024 / 1024).toFixed(1)}MB` : '—'}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-600 font-mono hidden lg:table-cell whitespace-nowrap">
        {item.created ? new Date(item.created).toLocaleDateString() : '—'}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500 hidden xl:table-cell">
        {item.meta?.diagnosis || <span className="text-gray-800">—</span>}
      </td>
      <td className="px-3 py-2.5">
        <button onClick={() => onOpen(item)}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-xs px-2 py-1 rounded"
          style={{ background: 'rgba(77,166,255,0.12)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.2)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          Open
        </button>
      </td>
    </tr>
  );
}

// ── Main Worklist ──────────────────────────────────────────────────────────────
export default function WorklistPage() {
  const {
    setPage, setActiveItem,
    activeCollection, activeFolder, setActiveFolder,
    clearActiveNavigation, setLeftPanelOpen, user,
    setCompareItems,
  } = useStore();

  const [compareSelection, setCompareSelection] = useState([]); // max 2 items

  const toggleCompareSelect = (item) => {
    setCompareSelection(prev => {
      const exists = prev.find(i => i._id === item._id);
      if (exists) return prev.filter(i => i._id !== item._id);
      if (prev.length >= 2) return prev; // already at max
      return [...prev, item];
    });
  };

  const [view, setView]               = useState('grid');
  const [search, setSearch]           = useState('');
  const [debouncedSearch, setDbSearch]= useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [pageNum, setPageNum]         = useState(0);
  const [localOverrides, setLocalOverrides] = useState({}); // itemId → updated meta
  const searchTimer = useRef(null);

  useEffect(() => { setLeftPanelOpen(true); }, [setLeftPanelOpen]);

  // Debounce search input
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDbSearch(search), 350);
    return () => clearTimeout(searchTimer.current);
  }, [search]);

  // Reset filters and overrides when collection/folder changes
  useEffect(() => {
    setPageNum(0);
    setSearch('');
    setStatusFilter('All');
    setLocalOverrides({});
  }, [activeFolder?._id, activeCollection?._id]);

  // ── "View All" mode: load all collections when none selected ─────────────
  const { data: allCollections = [], isLoading: loadingAllCollections } = useQuery({
    queryKey: ['collections'],
    queryFn: getCollections,
    enabled: !activeCollection,
    staleTime: 60_000,
  });

  // ── Fetch folders for each collection in "View All" mode ─────────────────
  const allCollFolderResults = useQueries({
    queries: (!activeCollection && allCollections.length > 0)
      ? allCollections.map(col => ({
          queryKey: ['folders-collection', col._id],
          queryFn: () => getFolders('collection', col._id),
          staleTime: 60_000,
        }))
      : [],
  });

  // ── Fetch folders for selected collection ─────────────────────────────────
  const { data: folders = [], isLoading: loadingFolders } = useQuery({
    queryKey: ['folders-collection', activeCollection?._id],
    queryFn: () => getFolders('collection', activeCollection._id),
    enabled: !!activeCollection,
    staleTime: 60_000,
  });

  // ── Fetch items when a specific folder is selected ────────────────────────
  const { data: rawItems = [], isLoading: loadingItems } = useQuery({
    queryKey: ['items-folder', activeFolder?._id],
    queryFn: () => getItems(activeFolder._id, 0, 500),
    enabled: !!activeFolder,
    staleTime: 30_000,
  });

  // ── Fetch level-2 subfolders (Mode B: handles nested collection folders) ──
  // e.g. Collection → LatestImagesFrom RFH → Feb2ndImages → [items]
  const levelTwoFolderResults = useQueries({
    queries: (!!activeCollection && !activeFolder && folders.length > 0)
      ? folders.map(folder => ({
          queryKey: ['folders-folder', folder._id],
          queryFn: () => getFolders('folder', folder._id),
          staleTime: 60_000,
        }))
      : [],
  });

  // ── Build unified folder list to load items from ──────────────────────────
  // Mode A: !activeCollection → all folders from all collections
  // Mode B: activeCollection && !activeFolder → level-1 + level-2 folders
  // Mode C: activeFolder → handled by rawItems above
  const foldersToLoad = !activeCollection
    ? allCollFolderResults.flatMap((r, ci) =>
        (r.data || []).map(f => ({ folder: f, collection: allCollections[ci] }))
      )
    : [
        ...folders.map(f => ({ folder: f, collection: activeCollection })),
        ...levelTwoFolderResults.flatMap(r =>
          (r.data || []).map(f => ({ folder: f, collection: activeCollection }))
        ),
      ];

  // ── Fetch items from all resolved folders (modes A & B) ───────────────────
  const allFolderResults = useQueries({
    queries: (!activeFolder && foldersToLoad.length > 0)
      ? foldersToLoad.map(({ folder }) => ({
          queryKey: ['items-folder', folder._id],
          queryFn: () => getItems(folder._id, 0, 500),
          staleTime: 30_000,
        }))
      : [],
  });

  const isLoadingFolders = activeCollection
    ? loadingFolders || levelTwoFolderResults.some(r => r.isLoading)
    : loadingAllCollections || allCollFolderResults.some(r => r.isLoading);
  const isLoadingItems = activeFolder
    ? loadingItems
    : allFolderResults.some(r => r.isLoading);

  // ── Build display items SYNCHRONOUSLY — no useEffect race ────────────────
  const baseItems = useMemo(() => {
    if (activeFolder) {
      return rawItems.map(item => ({
        item,
        folder: activeFolder,
        collectionName: activeCollection?.name || '',
        folderPath: activeFolder?.name || '',
      }));
    }
    return allFolderResults.flatMap((r, i) => {
      const { folder, collection } = foldersToLoad[i] || {};
      return (r.data || []).map(item => ({
        item,
        folder: folder || null,
        collectionName: collection?.name || '',
        folderPath: folder?.name || '',
      }));
    });
  }, [activeFolder, rawItems, allFolderResults, foldersToLoad]); // eslint-disable-line

  // Apply local status overrides on top of base items
  const displayItems = useMemo(() =>
    baseItems.map(row => {
      const override = localOverrides[row.item._id];
      return override ? { ...row, item: { ...row.item, meta: override } } : row;
    }),
  [baseItems, localOverrides]);

  // Background pre-warm: silently touch tile sources for first 20 items
  useEffect(() => {
    displayItems.slice(0, 20).forEach(r => { getTilesInfoSafe(r.item._id).catch(() => {}); });
  }, [displayItems]);

  const handleStatusChange = (itemId, newMeta) => {
    setLocalOverrides(prev => ({ ...prev, [itemId]: newMeta }));
  };

  // Filter items
  const filtered = displayItems.filter(({ item }) => {
    const q = debouncedSearch.toLowerCase();
    const matchSearch = !q
      || item.name.toLowerCase().includes(q)
      || (item.meta?.diagnosis || '').toLowerCase().includes(q)
      || (item.meta?.status || '').toLowerCase().includes(q);
    const matchStatus = statusFilter === 'All' || (item.meta?.status || 'No Status') === statusFilter;
    return matchSearch && matchStatus;
  });

  const pageItems  = filtered.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const statusCounts = {};
  displayItems.forEach(({ item }) => {
    const s = item.meta?.status || 'No Status';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const openInViewer = (item) => {
    // When in all-collection view, find and set the folder so the sidebar can auto-expand
    if (!activeFolder) {
      const row = displayItems.find(r => r.item._id === item._id);
      if (row?.folder) setActiveFolder(row.folder);
    }
    setActiveItem(item);
    setPage('viewer');
  };

  // ── Content area ─────────────────────────────────────────────────────────
  const renderContent = () => {

    // ① Still loading folders or items
    if (isLoadingFolders || isLoadingItems) {
      return (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <div className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }}/>
          <div className="text-sm text-gray-600">Loading images…</div>
        </div>
      );
    }

    if (filtered.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2a2f45" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <p className="text-sm text-gray-600">
            {search ? `No results for "${search}"` : 'No images in this folder'}
          </p>
          {search && (
            <button onClick={() => setSearch('')} className="text-xs text-blue-500 hover:text-blue-400">
              Clear search
            </button>
          )}
        </div>
      );
    }

    return (
      <>
        {view === 'grid' ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {pageItems.map(({ item, collectionName, folderPath }) => (
              <ThumbnailCard key={item._id} item={item}
                collectionName={collectionName} folderPath={folderPath}
                onOpen={openInViewer} onStatusChange={handleStatusChange}
                selected={!!compareSelection.find(i => i._id === item._id)}
                onToggleSelect={toggleCompareSelect}/>
            ))}
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <table className="w-full">
              <thead>
                <tr style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)' }}>
                  {['#', '', 'Image Name', 'Status', 'Collection', 'Folder', 'Size', 'Created', 'Diagnosis', ''].map((h, i) => (
                    <th key={i} className="text-left px-3 py-2.5 text-xs text-gray-600 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map(({ item, collectionName, folderPath }, i) => (
                  <TableRow key={item._id} item={item} collectionName={collectionName}
                    folderPath={folderPath} index={pageNum * PAGE_SIZE + i}
                    onOpen={openInViewer} onStatusChange={handleStatusChange}/>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6">
            <div className="text-xs text-gray-600 font-mono">
              Showing {pageNum * PAGE_SIZE + 1}–{Math.min((pageNum + 1) * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setPageNum(0)} disabled={pageNum === 0}
                className="px-2 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>«</button>
              <button onClick={() => setPageNum(p => p - 1)} disabled={pageNum === 0}
                className="px-3 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>Prev</button>
              {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                const pg = pageNum < 4 ? i : pageNum > totalPages - 4 ? totalPages - 7 + i : pageNum - 3 + i;
                if (pg < 0 || pg >= totalPages) return null;
                return (
                  <button key={pg} onClick={() => setPageNum(pg)}
                    className="px-3 py-1.5 rounded text-xs transition-all"
                    style={{
                      background: pg === pageNum ? 'rgba(77,166,255,0.15)' : 'transparent',
                      color: pg === pageNum ? '#4da6ff' : '#6b7280',
                      border: `1px solid ${pg === pageNum ? 'rgba(77,166,255,0.25)' : 'var(--border)'}`,
                    }}>
                    {pg + 1}
                  </button>
                );
              })}
              <button onClick={() => setPageNum(p => p + 1)} disabled={pageNum >= totalPages - 1}
                className="px-3 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>Next</button>
              <button onClick={() => setPageNum(totalPages - 1)} disabled={pageNum >= totalPages - 1}
                className="px-2 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>»</button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>

      {/* ── Nav ── */}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20"
        style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center cursor-pointer" onClick={() => setPage('dashboard')}>
          <img
            src="/impart-dx-logo.svg"
            alt="Impart DX"
            className="h-8 md:h-9 w-auto object-contain"
          />
        </div>

        <span className="text-gray-700">/</span>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm">
          <button className="transition-colors" style={{ color: 'var(--muted)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}
            onClick={() => clearActiveNavigation()}>
            All Collections
          </button>
          {activeCollection && (
            <>
              <span style={{ color: 'var(--border)' }}>/</span>
              <button className="transition-colors" style={{ color: 'var(--muted)' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}
                onClick={() => setActiveFolder(null)}>
                {activeCollection.name}
              </button>
            </>
          )}
          {activeFolder && (
            <>
              <span style={{ color: 'var(--border)' }}>/</span>
              <span className="font-semibold" style={{ color: 'var(--text)' }}>{activeFolder.name}</span>
            </>
          )}
        </div>

        <div className="flex-1"/>

        <button onClick={() => setPage('dashboard')}
          className="flex items-center gap-1.5 text-xs transition-colors px-2 py-1.5 rounded hover:bg-black/5" style={{ color: 'var(--muted)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Dashboard
        </button>

        <ThemeSwitcher />

        <div className="flex items-center gap-1.5 pl-3" style={{ borderLeft: '1px solid var(--border)' }}>
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'rgba(77,166,255,0.15)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.2)' }}>
            {user?.firstName?.[0] || user?.login?.[0]?.toUpperCase()}
          </div>
          <span className="text-xs text-gray-500 hidden md:block">{user?.firstName || user?.login}</span>
        </div>
      </nav>

      <div className="flex-1 overflow-hidden flex">
        <LeftSidebar/>
        <div className="flex-1 overflow-hidden flex flex-col">

          {/* ── Toolbar (search + filters) ── */}
          {(activeFolder || activeCollection || displayItems.length > 0) && (
            <div className="px-6 py-3 flex flex-col gap-2 shrink-0"
              style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-toolbar)' }}>
              <div className="flex items-center gap-3 flex-wrap">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px] max-w-lg">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2"
                    className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input value={search} onChange={e => { setSearch(e.target.value); setPageNum(0); }}
                    placeholder="Search by name, diagnosis…"
                    className="w-full text-xs rounded-lg pl-9 pr-4 py-2 outline-none"
                    style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text)' }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}/>
                  {search && (
                    <button onClick={() => { setSearch(''); setPageNum(0); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                </div>

                {/* View toggle */}
                <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  {[
                    ['grid', 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z'],
                    ['table', 'M3 12h18M3 6h18M3 18h18M3 3v18'],
                  ].map(([v, path]) => (
                    <button key={v} onClick={() => setView(v)}
                      className="px-3 py-1.5 text-xs transition-all"
                      style={{ background: view === v ? 'rgba(77,166,255,0.15)' : 'transparent', color: view === v ? '#4da6ff' : '#4b5563' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={path}/></svg>
                    </button>
                  ))}
                </div>

                {/* Count */}
                <div className="text-xs text-gray-600 font-mono shrink-0">
                  {filtered.length.toLocaleString()} / {displayItems.length.toLocaleString()} images
                </div>

                {/* Compare selection UI */}
                {compareSelection.length > 0 && (
                  <div className="flex items-center gap-2 shrink-0 pl-3" style={{ borderLeft: '1px solid var(--border)' }}>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {compareSelection.length}/2 selected
                    </span>
                    {compareSelection.length === 2 && (
                      <button
                        onClick={() => setCompareItems(compareSelection)}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-medium transition-all"
                        style={{ background: 'rgba(77,166,255,0.15)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.35)' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="2" y="3" width="9" height="18" rx="1"/><rect x="13" y="3" width="9" height="18" rx="1"/>
                        </svg>
                        Compare
                      </button>
                    )}
                    <button
                      onClick={() => setCompareSelection([])}
                      className="text-xs px-2 py-1 rounded transition-all"
                      style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}>
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Status pills */}
              <div className="flex items-center gap-2 flex-wrap">
                {['All', 'For Review', 'Pending', 'QC', 'Completed', 'STAT', 'No Status'].map(s => {
                  const count = s === 'All' ? displayItems.length : (statusCounts[s] || 0);
                  const cfg = STATUS_CONFIG[s] || {};
                  const isActive = statusFilter === s;
                  return (
                    <button key={s} onClick={() => { setStatusFilter(s); setPageNum(0); }}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-all"
                      style={{
                        background: isActive ? (cfg.bg || 'rgba(77,166,255,0.12)') : 'var(--highlight)',
                        color: isActive ? (cfg.color || 'var(--accent)') : 'var(--muted)',
                        border: isActive ? `1px solid ${cfg.border || 'rgba(77,166,255,0.3)'}` : '1px solid var(--border)',
                      }}>
                      {s}<span className="font-mono opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Content ── */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
