// src/components/worklist/WorklistPage.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../../store/index.js';
import { getFolders, getItems, updateItemMetadata } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';
import LeftSidebar from '../sidebar/LeftSidebar.jsx';

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
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(77,166,255,0.3)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'}>
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
function ThumbnailCard({ item, collectionName, folderPath, onOpen, onStatusChange }) {
  const token = localStorage.getItem('girderToken') || '';
  const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=320&height=240&token=${token}`;
  const [imgError, setImgError] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [saving, setSaving] = useState(false);
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
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(77,166,255,0.25)'}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; setShowMenu(false); }}>

      {/* Thumbnail */}
      <div className="relative overflow-hidden cursor-pointer" style={{ paddingBottom: '60%', background: '#060709' }}
        onClick={() => onOpen(item)}>
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
              className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-all px-1.5 py-0.5 rounded hover:bg-white/5">
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
                style={{ background: '#13151f', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', minWidth: 130 }}>
                {Object.keys(STATUS_CONFIG).map(s => (
                  <button key={s} onClick={() => handleStatus(s)}
                    className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: STATUS_CONFIG[s].color }}/>{s}
                  </button>
                ))}
                {status && (
                  <button onClick={() => handleStatus(null)}
                    className="w-full text-left px-3 py-2 text-xs text-gray-600 hover:text-white transition-colors hover:bg-white/5 border-t"
                    style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
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
    <tr className="group border-b transition-colors" style={{ borderColor: 'rgba(255,255,255,0.04)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
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
              style={{ background: '#13151f', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', minWidth: 130 }}>
              {Object.keys(STATUS_CONFIG).map(s => (
                <button key={s} onClick={() => handleStatus(s)}
                  className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: STATUS_CONFIG[s].color }}/>{s}
                </button>
              ))}
              {status && <button onClick={() => handleStatus(null)} className="w-full text-left px-3 py-2 text-xs text-gray-600 hover:text-white transition-colors border-t" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>Clear</button>}
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
  } = useStore();

  const [view, setView]               = useState('grid');
  const [search, setSearch]           = useState('');
  const [debouncedSearch, setDbSearch]= useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [pageNum, setPageNum]         = useState(0);
  const [localItems, setLocalItems]   = useState([]);
  const searchTimer = useRef(null);

  useEffect(() => { setLeftPanelOpen(true); }, [setLeftPanelOpen]);

  // Debounce search input
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDbSearch(search), 350);
    return () => clearTimeout(searchTimer.current);
  }, [search]);

  // Reset filters when folder changes
  useEffect(() => {
    setPageNum(0);
    setSearch('');
    setStatusFilter('All');
  }, [activeFolder?._id]);

  // ── Fetch folders in selected collection (lazy — only when no folder chosen) ─
  const { data: folders = [], isLoading: loadingFolders } = useQuery({
    queryKey: ['folders-collection', activeCollection?._id],
    queryFn: () => getFolders('collection', activeCollection._id),
    enabled: !!activeCollection && !activeFolder,
    staleTime: 60_000,
  });

  // ── Fetch items in selected folder only ───────────────────────────────────
  const { data: rawItems = [], isLoading: loadingItems } = useQuery({
    queryKey: ['items-folder', activeFolder?._id],
    queryFn: () => getItems(activeFolder._id, 0, 500),
    enabled: !!activeFolder,
    staleTime: 30_000,
  });

  // Keep a local copy so status edits reflect immediately without refetch
  useEffect(() => {
    setLocalItems(
      rawItems.map(item => ({
        item,
        collectionName: activeCollection?.name || '',
        folderPath: activeFolder?.name || '',
      }))
    );
  }, [rawItems, activeCollection, activeFolder]);

  const handleStatusChange = (itemId, newMeta) => {
    setLocalItems(prev =>
      prev.map(row => row.item._id === itemId ? { ...row, item: { ...row.item, meta: newMeta } } : row)
    );
  };

  // Filter items
  const filtered = localItems.filter(({ item }) => {
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
  localItems.forEach(({ item }) => {
    const s = item.meta?.status || 'No Status';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const openInViewer = (item) => { setActiveItem(item); setPage('viewer'); };

  // ── Content area (3 states) ───────────────────────────────────────────────
  const renderContent = () => {

    // ① No collection selected
    if (!activeCollection) {
      return (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#1e2540" strokeWidth="1.2">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>
          </svg>
          <p className="text-sm text-gray-500 font-medium">Select a collection from the sidebar</p>
          <p className="text-xs text-gray-700">Then choose a folder to load its images</p>
        </div>
      );
    }

    // ② Collection chosen, no folder — show folder grid
    if (!activeFolder) {
      if (loadingFolders) {
        return (
          <div className="flex items-center justify-center py-24">
            <div className="spinner" style={{ width: 28, height: 28, borderWidth: 2 }}/>
          </div>
        );
      }
      if (folders.length === 0) {
        return (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <p className="text-sm text-gray-600">No folders in this collection</p>
          </div>
        );
      }
      return (
        <div>
          <p className="text-xs text-gray-600 mb-4">
            {folders.length} folder{folders.length !== 1 ? 's' : ''} — select one to load images
          </p>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {folders.map(folder => (
              <FolderCard key={folder._id} folder={folder} onClick={() => setActiveFolder(folder)}/>
            ))}
          </div>
        </div>
      );
    }

    // ③ Folder selected — show items
    if (loadingItems) {
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
                onOpen={openInViewer} onStatusChange={handleStatusChange}/>
            ))}
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
            <table className="w-full">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
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
                style={{ color: '#9ca3af', border: '1px solid rgba(255,255,255,0.08)' }}>«</button>
              <button onClick={() => setPageNum(p => p - 1)} disabled={pageNum === 0}
                className="px-3 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: '#9ca3af', border: '1px solid rgba(255,255,255,0.08)' }}>Prev</button>
              {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                const pg = pageNum < 4 ? i : pageNum > totalPages - 4 ? totalPages - 7 + i : pageNum - 3 + i;
                if (pg < 0 || pg >= totalPages) return null;
                return (
                  <button key={pg} onClick={() => setPageNum(pg)}
                    className="px-3 py-1.5 rounded text-xs transition-all"
                    style={{
                      background: pg === pageNum ? 'rgba(77,166,255,0.15)' : 'transparent',
                      color: pg === pageNum ? '#4da6ff' : '#6b7280',
                      border: `1px solid ${pg === pageNum ? 'rgba(77,166,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
                    }}>
                    {pg + 1}
                  </button>
                );
              })}
              <button onClick={() => setPageNum(p => p + 1)} disabled={pageNum >= totalPages - 1}
                className="px-3 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: '#9ca3af', border: '1px solid rgba(255,255,255,0.08)' }}>Next</button>
              <button onClick={() => setPageNum(totalPages - 1)} disabled={pageNum >= totalPages - 1}
                className="px-2 py-1.5 rounded text-xs disabled:opacity-30"
                style={{ color: '#9ca3af', border: '1px solid rgba(255,255,255,0.08)' }}>»</button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#07080d', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>

      {/* ── Nav ── */}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20"
        style={{ background: 'rgba(7,8,13,0.95)', borderBottom: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => setPage('dashboard')}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(77,166,255,0.15)', border: '1px solid rgba(77,166,255,0.25)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <span className="text-white font-bold text-sm">PathAssist</span>
        </div>

        <span className="text-gray-700">/</span>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm">
          <button className="text-gray-500 hover:text-white transition-colors"
            onClick={() => clearActiveNavigation()}>
            All Collections
          </button>
          {activeCollection && (
            <>
              <span className="text-gray-700">/</span>
              <button className="text-gray-400 hover:text-white transition-colors"
                onClick={() => setActiveFolder(null)}>
                {activeCollection.name}
              </button>
            </>
          )}
          {activeFolder && (
            <>
              <span className="text-gray-700">/</span>
              <span className="text-white font-semibold">{activeFolder.name}</span>
            </>
          )}
        </div>

        <div className="flex-1"/>

        <button onClick={() => setPage('dashboard')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors px-2 py-1.5 rounded hover:bg-white/5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Dashboard
        </button>

        <div className="flex items-center gap-1.5 pl-3" style={{ borderLeft: '1px solid rgba(255,255,255,0.07)' }}>
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

          {/* ── Toolbar (search + filters — only when folder is selected) ── */}
          {activeFolder && (
            <div className="px-6 py-3 flex flex-col gap-2 shrink-0"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>
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
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#e0e0e0' }}
                    onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.4)'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}/>
                  {search && (
                    <button onClick={() => { setSearch(''); setPageNum(0); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-white">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                </div>

                {/* View toggle */}
                <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
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
                  {filtered.length.toLocaleString()} / {localItems.length.toLocaleString()} images
                </div>
              </div>

              {/* Status pills */}
              <div className="flex items-center gap-2 flex-wrap">
                {['All', 'For Review', 'Pending', 'QC', 'Completed', 'STAT', 'No Status'].map(s => {
                  const count = s === 'All' ? localItems.length : (statusCounts[s] || 0);
                  const cfg = STATUS_CONFIG[s] || {};
                  const isActive = statusFilter === s;
                  return (
                    <button key={s} onClick={() => { setStatusFilter(s); setPageNum(0); }}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-all"
                      style={{
                        background: isActive ? (cfg.bg || 'rgba(77,166,255,0.12)') : 'rgba(255,255,255,0.03)',
                        color: isActive ? (cfg.color || '#4da6ff') : '#6b7280',
                        border: isActive ? `1px solid ${cfg.border || 'rgba(77,166,255,0.3)'}` : '1px solid rgba(255,255,255,0.06)',
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
