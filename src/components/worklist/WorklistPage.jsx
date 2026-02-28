// src/components/worklist/WorklistPage.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { updateItemMetadata } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';
import StatusEditor from './StatusEditor.jsx';

const PAGE_SIZE = 24;

const STATUS_CONFIG = {
  'For Review': { color:'#4da6ff', bg:'rgba(77,166,255,0.12)', border:'rgba(77,166,255,0.25)' },
  'Pending':    { color:'#f5a623', bg:'rgba(245,166,35,0.12)',  border:'rgba(245,166,35,0.25)' },
  'QC':         { color:'#c27aff', bg:'rgba(194,122,255,0.12)', border:'rgba(194,122,255,0.25)' },
  'Completed':  { color:'#4caf82', bg:'rgba(76,175,130,0.12)',  border:'rgba(76,175,130,0.25)' },
  'STAT':       { color:'#e94560', bg:'rgba(233,69,96,0.12)',   border:'rgba(233,69,96,0.25)' },
};

function StatusBadge({ status }) {
  if (!status) return null;
  const cfg = STATUS_CONFIG[status] || { color:'#6b7280', bg:'rgba(107,114,128,0.12)', border:'rgba(107,114,128,0.25)' };
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium whitespace-nowrap"
      style={{ color:cfg.color, background:cfg.bg, border:`1px solid ${cfg.border}` }}>
      {status}
    </span>
  );
}

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
    } catch(e) { console.error(e); }
    setSaving(false);
    setShowMenu(false);
  };

  return (
    <div className="group relative flex flex-col rounded-xl overflow-hidden transition-all duration-200"
      style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor='rgba(77,166,255,0.25)'}
      onMouseLeave={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.07)'; setShowMenu(false); }}>

      {/* Thumbnail */}
      <div className="relative overflow-hidden cursor-pointer" style={{ paddingBottom:'60%', background:'#060709' }}
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

        {/* Open overlay */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background:'rgba(0,0,0,0.5)' }}>
          <div className="flex items-center gap-1.5 text-xs text-white font-medium px-3 py-1.5 rounded-lg"
            style={{ background:'rgba(77,166,255,0.3)', border:'1px solid rgba(77,166,255,0.4)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            Open Viewer
          </div>
        </div>

        {/* Status badge top-right */}
        {status && (
          <div className="absolute top-2 right-2">
            <StatusBadge status={status}/>
          </div>
        )}
        {priority === 'STAT' && (
          <div className="absolute top-2 left-2">
            <span className="text-xs px-1.5 py-0.5 rounded font-bold"
              style={{ background:'#e94560', color:'white' }}>STAT</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 flex flex-col gap-1.5">
        <div className="text-xs font-medium text-white leading-tight truncate" title={item.name}>
          {item.name}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {collectionName && (
            <span className="text-xs text-gray-600 truncate max-w-[100px]" title={collectionName}>
              {collectionName}
            </span>
          )}
          {folderPath && <span className="text-gray-700 text-xs">/</span>}
          {folderPath && (
            <span className="text-xs text-gray-700 truncate max-w-[80px]" title={folderPath}>
              {folderPath}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-1.5">
            <StatusBadge status={status || 'No Status'}/>
          </div>
          {/* Status change button */}
          <div className="relative">
            <button onClick={() => setShowMenu(!showMenu)}
              className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-all px-1.5 py-0.5 rounded hover:bg-white/5">
              {saving ? <div className="spinner" style={{ width:10, height:10 }}/> : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              )}
              Status
            </button>

            {showMenu && (
              <div className="absolute bottom-full right-0 mb-1 rounded-lg overflow-hidden z-50 min-w-[130px]"
                style={{ background:'#13151f', border:'1px solid rgba(255,255,255,0.1)', boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }}>
                {Object.keys(STATUS_CONFIG).map(s => (
                  <button key={s} onClick={() => handleStatus(s)}
                    className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: STATUS_CONFIG[s].color }}/>
                    {s}
                  </button>
                ))}
                {status && (
                  <button onClick={() => handleStatus(null)}
                    className="w-full text-left px-3 py-2 text-xs text-gray-600 hover:text-white transition-colors hover:bg-white/5 border-t"
                    style={{ borderColor:'rgba(255,255,255,0.07)' }}>
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

// ── Table row view ─────────────────────────────────────────────────────────────
function TableRow({ item, collectionName, folderPath, onOpen, onStatusChange, index }) {
  const token = localStorage.getItem('girderToken') || '';
  const thumbUrl = `${GIRDER_BASE}/item/${item._id}/tiles/thumbnail?width=80&height=60&token=${token}`;
  const status = item.meta?.status || null;
  const priority = item.meta?.priority || null;
  const [showMenu, setShowMenu] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleStatus = async (newStatus) => {
    setSaving(true);
    try {
      await updateItemMetadata(item._id, { ...item.meta, status: newStatus });
      onStatusChange(item._id, { ...item.meta, status: newStatus });
    } catch(e) {}
    setSaving(false);
    setShowMenu(false);
  };

  return (
    <tr className="group border-b transition-colors"
      style={{ borderColor:'rgba(255,255,255,0.04)' }}
      onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.02)'}
      onMouseLeave={e => { e.currentTarget.style.background=''; setShowMenu(false); }}>
      {/* # */}
      <td className="px-3 py-2.5 text-xs font-mono text-gray-700 w-8">{index + 1}</td>
      {/* Thumb */}
      <td className="px-2 py-2 w-16">
        <div className="w-14 h-10 rounded overflow-hidden bg-gray-900 cursor-pointer" onClick={() => onOpen(item)}>
          <img src={thumbUrl} alt="" className="w-full h-full object-cover"
            onError={e => { e.target.style.display='none'; }}/>
        </div>
      </td>
      {/* Case # / Name */}
      <td className="px-3 py-2.5">
        <div className="text-xs font-medium cursor-pointer hover:text-blue-400 transition-colors truncate max-w-[180px]"
          style={{ color:'#4da6ff' }} onClick={() => onOpen(item)}>
          {item.name}
        </div>
        <div className="text-xs text-gray-700 font-mono mt-0.5">{item._id.slice(-8)}</div>
      </td>
      {/* Status */}
      <td className="px-3 py-2.5">
        <div className="relative">
          <button onClick={() => setShowMenu(!showMenu)} className="flex items-center gap-1">
            <StatusBadge status={status || 'No Status'}/>
            {!saving && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" className="group-hover:stroke-gray-400"><polyline points="6 9 12 15 18 9"/></svg>}
            {saving && <div className="spinner" style={{ width:9, height:9 }}/>}
          </button>
          {showMenu && (
            <div className="absolute top-full left-0 mt-1 z-50 rounded-lg overflow-hidden"
              style={{ background:'#13151f', border:'1px solid rgba(255,255,255,0.1)', boxShadow:'0 8px 32px rgba(0,0,0,0.5)', minWidth:130 }}>
              {Object.keys(STATUS_CONFIG).map(s => (
                <button key={s} onClick={() => handleStatus(s)}
                  className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background:STATUS_CONFIG[s].color }}/>
                  {s}
                </button>
              ))}
              {status && <button onClick={() => handleStatus(null)} className="w-full text-left px-3 py-2 text-xs text-gray-600 hover:text-white transition-colors border-t" style={{ borderColor:'rgba(255,255,255,0.07)' }}>Clear</button>}
            </div>
          )}
        </div>
      </td>
      {/* Collection */}
      <td className="px-3 py-2.5 text-xs text-gray-500 hidden md:table-cell max-w-[120px]">
        <div className="truncate">{collectionName}</div>
      </td>
      {/* Folder path */}
      <td className="px-3 py-2.5 text-xs text-gray-600 hidden lg:table-cell max-w-[120px]">
        <div className="truncate">{folderPath}</div>
      </td>
      {/* Size */}
      <td className="px-3 py-2.5 text-xs text-gray-600 font-mono hidden md:table-cell">
        {item.size ? `${(item.size/1024/1024).toFixed(1)}MB` : '—'}
      </td>
      {/* Created */}
      <td className="px-3 py-2.5 text-xs text-gray-600 font-mono hidden lg:table-cell whitespace-nowrap">
        {item.created ? new Date(item.created).toLocaleDateString() : '—'}
      </td>
      {/* Diagnosis */}
      <td className="px-3 py-2.5 text-xs text-gray-500 hidden xl:table-cell">
        {item.meta?.diagnosis || <span className="text-gray-800">—</span>}
      </td>
      {/* Open */}
      <td className="px-3 py-2.5">
        <button onClick={() => onOpen(item)}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-xs px-2 py-1 rounded"
          style={{ background:'rgba(77,166,255,0.12)', color:'#4da6ff', border:'1px solid rgba(77,166,255,0.2)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          Open
        </button>
      </td>
    </tr>
  );
}

// ── Main Worklist ─────────────────────────────────────────────────────────────
export default function WorklistPage() {
  const { setPage, setActiveItem, activeCollection, user } = useStore();
  const [view, setView] = useState('grid'); // 'grid' | 'table'
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [colFilter, setColFilter] = useState('All');
  const [page, setPageNum] = useState(0);
  const [allItems, setAllItems] = useState([]);  // [{item, collectionName, folderPath}]
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [collections, setCollections] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const token = localStorage.getItem('girderToken') || '';
  const searchTimer = useRef(null);

  // Debounce search
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(searchTimer.current);
  }, [search]);

  // Load all collections
  useEffect(() => {
    fetch(`${GIRDER_BASE}/collection?limit=200&sort=name`, { headers:{ 'Girder-Token': token }})
      .then(r => r.json()).then(setCollections).catch(console.error);
  }, []);

  // Flatten all items from all collections / selected collection
  const loadItems = useCallback(async (reset = true) => {
    if (reset) { setLoading(true); setAllItems([]); setPageNum(0); }
    else setLoadingMore(true);

    try {
      const targetCols = activeCollection
        ? [activeCollection]
        : collections;

      let gathered = [];
      let offset = reset ? 0 : allItems.length;

      for (const col of targetCols) {
        if (colFilter !== 'All' && col._id !== colFilter) continue;

        // Get folders in collection
        const foldersRes = await fetch(
          `${GIRDER_BASE}/folder?parentType=collection&parentId=${col._id}&limit=200`,
          { headers:{ 'Girder-Token': token }}
        );
        const folders = await foldersRes.json();

        for (const folder of (Array.isArray(folders) ? folders : [])) {
          const itemsRes = await fetch(
            `${GIRDER_BASE}/item?folderId=${folder._id}&limit=200&sort=name`,
            { headers:{ 'Girder-Token': token }}
          );
          const items = await itemsRes.json();

          for (const item of (Array.isArray(items) ? items : [])) {
            gathered.push({
              item,
              collectionName: col.name,
              folderPath: folder.name,
              collectionId: col._id,
            });
          }

          // Also check subfolders (1 level deep)
          const subFoldersRes = await fetch(
            `${GIRDER_BASE}/folder?parentType=folder&parentId=${folder._id}&limit=100`,
            { headers:{ 'Girder-Token': token }}
          );
          const subFolders = await subFoldersRes.json();
          for (const sub of (Array.isArray(subFolders) ? subFolders : [])) {
            const subItemsRes = await fetch(
              `${GIRDER_BASE}/item?folderId=${sub._id}&limit=200&sort=name`,
              { headers:{ 'Girder-Token': token }}
            );
            const subItems = await subItemsRes.json();
            for (const item of (Array.isArray(subItems) ? subItems : [])) {
              gathered.push({
                item,
                collectionName: col.name,
                folderPath: `${folder.name}/${sub.name}`,
                collectionId: col._id,
              });
            }
          }
        }
      }

      setTotalCount(gathered.length);
      setAllItems(reset ? gathered : [...allItems, ...gathered]);
      setHasMore(false); // All loaded at once
    } catch(err) {
      console.error('Load items failed:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [collections, activeCollection, colFilter, token]);

  useEffect(() => {
    if (collections.length > 0) loadItems(true);
  }, [collections.length, colFilter]);

  // Update item meta locally after save
  const handleStatusChange = (itemId, newMeta) => {
    setAllItems(prev => prev.map(row =>
      row.item._id === itemId ? { ...row, item: { ...row.item, meta: newMeta }} : row
    ));
  };

  // Filtered items
  const filtered = allItems.filter(({ item, collectionName, folderPath }) => {
    const q = debouncedSearch.toLowerCase();
    const matchSearch = !q || item.name.toLowerCase().includes(q)
      || collectionName.toLowerCase().includes(q)
      || (folderPath || '').toLowerCase().includes(q)
      || (item.meta?.diagnosis || '').toLowerCase().includes(q)
      || (item.meta?.status || '').toLowerCase().includes(q);
    const matchStatus = statusFilter === 'All' || (item.meta?.status || 'No Status') === statusFilter;
    return matchSearch && matchStatus;
  });

  // Paginated
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const statusCounts = {};
  allItems.forEach(({ item }) => {
    const s = item.meta?.status || 'No Status';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const openInViewer = (item) => {
    setActiveItem(item);
    setPage('viewer');
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background:'#07080d', fontFamily:"'IBM Plex Sans', system-ui, sans-serif" }}>

      {/* ── Nav ── */}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20"
        style={{ background:'rgba(7,8,13,0.95)', borderBottom:'1px solid rgba(255,255,255,0.06)', backdropFilter:'blur(12px)' }}>
        <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => setPage('dashboard')}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background:'rgba(77,166,255,0.15)', border:'1px solid rgba(77,166,255,0.25)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <span className="text-white font-bold text-sm">PathAssist</span>
        </div>

        <span className="text-gray-700">/</span>

        <div className="flex items-center gap-1.5 text-sm text-gray-300">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
            <rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/>
            <rect x="3" y="12" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="5" rx="1"/>
          </svg>
          <span className="font-semibold text-white">
            {activeCollection ? activeCollection.name : 'All Images'}
          </span>
        </div>

        <div className="flex-1"/>

        <button onClick={() => setPage('dashboard')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors px-2 py-1.5 rounded hover:bg-white/5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Dashboard
        </button>

        <div className="flex items-center gap-1.5 pl-3" style={{ borderLeft:'1px solid rgba(255,255,255,0.07)' }}>
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background:'rgba(77,166,255,0.15)', color:'#4da6ff', border:'1px solid rgba(77,166,255,0.2)' }}>
            {user?.firstName?.[0] || user?.login?.[0]?.toUpperCase()}
          </div>
          <span className="text-xs text-gray-500 hidden md:block">{user?.firstName || user?.login}</span>
        </div>
      </nav>

      <div className="flex-1 overflow-hidden flex flex-col">

        {/* ── Toolbar ── */}
        <div className="px-6 py-4 flex flex-col gap-3 shrink-0"
          style={{ borderBottom:'1px solid rgba(255,255,255,0.06)', background:'rgba(255,255,255,0.01)' }}>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-lg">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2"
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input value={search} onChange={e => { setSearch(e.target.value); setPageNum(0); }}
                placeholder="Search by name, collection, folder, diagnosis…"
                className="w-full text-xs rounded-lg pl-9 pr-4 py-2 outline-none transition-colors"
                style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)',
                  color:'#e0e0e0', fontFamily:'IBM Plex Sans' }}
                onFocus={e => e.target.style.borderColor='rgba(77,166,255,0.4)'}
                onBlur={e => e.target.style.borderColor='rgba(255,255,255,0.08)'}/>
              {search && (
                <button onClick={() => { setSearch(''); setPageNum(0); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-white transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>

            {/* Collection filter */}
            <select value={colFilter} onChange={e => { setColFilter(e.target.value); setPageNum(0); }}
              className="text-xs rounded-lg px-2 py-2 outline-none cursor-pointer"
              style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#9ca3af' }}>
              <option value="All">All Collections</option>
              {collections.map(c => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>

            {/* View toggle */}
            <div className="flex rounded-lg overflow-hidden" style={{ border:'1px solid rgba(255,255,255,0.08)' }}>
              {[['grid','M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z'],['table','M3 12h18M3 6h18M3 18h18M3 3v18']].map(([v, path]) => (
                <button key={v} onClick={() => setView(v)}
                  className="px-3 py-1.5 text-xs transition-all"
                  style={{ background: view===v ? 'rgba(77,166,255,0.15)' : 'transparent',
                    color: view===v ? '#4da6ff' : '#4b5563' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d={path}/>
                  </svg>
                </button>
              ))}
            </div>

            {/* Count */}
            <div className="text-xs text-gray-600 font-mono shrink-0">
              {loading ? 'Loading…' : `${filtered.length.toLocaleString()} / ${allItems.length.toLocaleString()} items`}
            </div>
          </div>

          {/* Status filter pills */}
          <div className="flex items-center gap-2 flex-wrap">
            {['All', 'For Review', 'Pending', 'QC', 'Completed', 'STAT', 'No Status'].map(s => {
              const count = s === 'All' ? allItems.length : (statusCounts[s] || 0);
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
                  {s}
                  <span className="font-mono opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4">

          {loading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="spinner" style={{ width:32, height:32, borderWidth:3 }}/>
              <div className="text-sm text-gray-600">Loading images from all collections…</div>
              <div className="text-xs text-gray-700">This may take a moment for large datasets</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#2a2f45" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <p className="text-sm text-gray-600">No images found</p>
              <p className="text-xs text-gray-700">{search ? `No results for "${search}"` : 'No images in this collection'}</p>
              {search && <button onClick={() => setSearch('')} className="text-xs text-blue-500 hover:text-blue-400">Clear search</button>}
            </div>
          ) : view === 'grid' ? (
            <>
              <div className="grid gap-4" style={{ gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {pageItems.map(({ item, collectionName, folderPath }) => (
                  <ThumbnailCard key={item._id} item={item}
                    collectionName={collectionName} folderPath={folderPath}
                    onOpen={openInViewer} onStatusChange={handleStatusChange}/>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-xl overflow-hidden" style={{ border:'1px solid rgba(255,255,255,0.07)' }}>
              <table className="w-full">
                <thead>
                  <tr style={{ background:'rgba(255,255,255,0.03)', borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
                    {['#','','Image Name','Status','Collection','Folder','Size','Created','Diagnosis',''].map((h, i) => (
                      <th key={i} className="text-left px-3 py-2.5 text-xs text-gray-600 font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(({ item, collectionName, folderPath }, i) => (
                    <TableRow key={item._id} item={item} collectionName={collectionName}
                      folderPath={folderPath} index={page * PAGE_SIZE + i}
                      onOpen={openInViewer} onStatusChange={handleStatusChange}/>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Pagination ── */}
          {totalPages > 1 && !loading && (
            <div className="flex items-center justify-between mt-6">
              <div className="text-xs text-gray-600 font-mono">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page+1)*PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setPageNum(0)} disabled={page===0}
                  className="px-2 py-1.5 rounded text-xs transition-colors disabled:opacity-30"
                  style={{ color: page===0 ? '#374151' : '#9ca3af', border:'1px solid rgba(255,255,255,0.08)' }}>
                  «
                </button>
                <button onClick={() => setPageNum(p => p-1)} disabled={page===0}
                  className="px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-30"
                  style={{ color: page===0 ? '#374151' : '#9ca3af', border:'1px solid rgba(255,255,255,0.08)' }}>
                  Prev
                </button>
                {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                  const pg = page < 4 ? i : page > totalPages - 4 ? totalPages - 7 + i : page - 3 + i;
                  if (pg < 0 || pg >= totalPages) return null;
                  return (
                    <button key={pg} onClick={() => setPageNum(pg)}
                      className="px-3 py-1.5 rounded text-xs transition-all"
                      style={{
                        background: pg===page ? 'rgba(77,166,255,0.15)' : 'transparent',
                        color: pg===page ? '#4da6ff' : '#6b7280',
                        border: `1px solid ${pg===page ? 'rgba(77,166,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
                      }}>
                      {pg + 1}
                    </button>
                  );
                })}
                <button onClick={() => setPageNum(p => p+1)} disabled={page>=totalPages-1}
                  className="px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-30"
                  style={{ color: page>=totalPages-1 ? '#374151' : '#9ca3af', border:'1px solid rgba(255,255,255,0.08)' }}>
                  Next
                </button>
                <button onClick={() => setPageNum(totalPages-1)} disabled={page>=totalPages-1}
                  className="px-2 py-1.5 rounded text-xs transition-colors disabled:opacity-30"
                  style={{ color: page>=totalPages-1 ? '#374151' : '#9ca3af', border:'1px solid rgba(255,255,255,0.08)' }}>
                  »
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
