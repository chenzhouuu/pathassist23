// src/components/sidebar/LeftSidebar.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../../store/index.js';
import { getCollections, getFolders, getItems } from '../../api/index.js';
import { getThumbnailUrl } from '../../config/girder.js';
import AnnotationsPanel from '../panels/AnnotationsPanel.jsx';
import LayersPanel from '../panels/LayersPanel.jsx';

// ─── Icons ──────────────────────────────────────────────────────────────────
const FolderIcon = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={open ? 'rgba(77,166,255,0.4)' : 'none'}
    stroke="#4da6ff" strokeWidth="2" style={{ flexShrink: 0 }}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const SlideIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" style={{ flexShrink: 0 }}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

const ChevronRight = ({ open }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// ─── Item (slide) row ────────────────────────────────────────────────────────
function SlideRow({ item }) {
  const { activeItem, setActiveItem } = useStore();
  const isActive = activeItem?._id === item._id;
  const token = localStorage.getItem('girderToken') || '';
  const thumbUrl = getThumbnailUrl(item._id, token, 160, 100);

  return (
    <div
      className={`tree-item pl-8 pr-2 py-1 ${isActive ? 'selected' : ''}`}
      onClick={() => setActiveItem(item)}
    >
      <div className="w-10 h-8 rounded overflow-hidden flex-shrink-0" style={{ background: 'var(--bg-viewer)' }}>
        <img
          src={thumbUrl}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      </div>
      <span className="truncate text-xs leading-tight">{item.name}</span>
    </div>
  );
}

// ─── Folder node ─────────────────────────────────────────────────────────────
function FolderNode({ folder, depth = 0 }) {
  const { setActiveFolder, activeFolder } = useStore();
  const isActiveFolder = activeFolder?._id === folder._id;
  // Auto-open if this folder IS the active folder OR is an ancestor of it
  // (e.g. activeFolder.parentId points to this folder for 2-level nesting)
  const isAncestorOfActive =
    activeFolder?.parentId === folder._id &&
    activeFolder?.parentCollection === 'folder';
  const [open, setOpen] = useState(isActiveFolder || isAncestorOfActive);

  useEffect(() => {
    if (isActiveFolder || isAncestorOfActive) setOpen(true);
  }, [isActiveFolder, isAncestorOfActive]);

  const { data: subfolders, isLoading: loadingFolders } = useQuery({
    queryKey: ['folders', folder._id],
    queryFn: () => getFolders('folder', folder._id),
    enabled: open,
  });

  const { data: items, isLoading: loadingItems } = useQuery({
    queryKey: ['items', folder._id],
    queryFn: () => getItems(folder._id),
    enabled: open,
  });

  const isActive = activeFolder?._id === folder._id;
  const indent = depth * 12;

  return (
    <div>
      <div
        className={`tree-item ${isActive ? 'selected' : ''}`}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => {
          setOpen(!open);
          setActiveFolder(folder);
        }}
      >
        <ChevronRight open={open} />
        <FolderIcon open={open} />
        <span className="truncate">{folder.name}</span>
        {folder.nItems > 0 && (
          <span className="ml-auto text-gray-600 text-xs font-mono">{folder.nItems}</span>
        )}
      </div>

      {open && (
        <div>
          {(loadingFolders || loadingItems) && (
            <div className="flex justify-center py-2">
              <div className="spinner" />
            </div>
          )}
          {subfolders?.map((sf) => (
            <FolderNode key={sf._id} folder={sf} depth={depth + 1} />
          ))}
          {items?.map((item) => (
            <SlideRow key={item._id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Collection node ──────────────────────────────────────────────────────────
function CollectionNode({ collection }) {
  const { setActiveCollection, activeCollection } = useStore();
  const isActive = activeCollection?._id === collection._id;
  const [open, setOpen] = useState(isActive);

  useEffect(() => {
    if (isActive) setOpen(true);
  }, [isActive]);

  const { data: folders, isLoading } = useQuery({
    queryKey: ['folders-collection', collection._id],
    queryFn: () => getFolders('collection', collection._id),
    enabled: open,
  });

  return (
    <div>
      <div
        className="tree-item font-medium"
        style={{ paddingLeft: '8px', color: 'var(--text)' }}
        onClick={() => { setOpen(!open); setActiveCollection(collection); }}
      >
        <ChevronRight open={open} />
        <svg width="12" height="12" viewBox="0 0 24 24" fill="rgba(77,166,255,0.3)"
          stroke="#4da6ff" strokeWidth="2" style={{ flexShrink: 0 }}>
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
        </svg>
        <span className="truncate">{collection.name}</span>
      </div>
      {open && (
        <div>
          {isLoading && <div className="flex justify-center py-2"><div className="spinner" /></div>}
          {folders?.map((f) => <FolderNode key={f._id} folder={f} depth={1} />)}
        </div>
      )}
    </div>
  );
}

// ─── Case images panel (shown when a Second Opinion case is open) ─────────────
function CaseItemsPanel({ caseContext }) {
  const { activeItem, openCaseItem, setPage, clearCaseContext, setCompareItems } = useStore();
  const [compareSelection, setCompareSelection] = useState([]);

  useEffect(() => {
    setCompareSelection([]);
  }, [caseContext?.caseId]);

  const toggleCompareSelect = (item) => {
    setCompareSelection((prev) => {
      const exists = prev.find((i) => i._id === item._id);
      if (exists) return prev.filter((i) => i._id !== item._id);
      if (prev.length >= 4) return prev;
      return [...prev, item];
    });
  };

  const openCompareWindow = () => {
    if (compareSelection.length < 2) return;
    setCompareItems(compareSelection);
    const compareUrl = `${window.location.origin}${window.location.pathname}?compare=1`;
    const compareWindow = window.open(compareUrl, 'pathassist-compare', 'popup=yes,width=1680,height=1080,resizable=yes,scrollbars=yes');
    if (compareWindow) {
      compareWindow.focus();
      return;
    }
    setPage('compare');
  };

  return (
    <div className="flex flex-col shrink-0 overflow-hidden h-full"
      style={{ width: 'var(--left-w)', background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border)' }}>
      {/* Header */}
      <div className="panel-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <div className="flex items-center gap-1.5 w-full">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#c27aff" strokeWidth="2" style={{ flexShrink: 0 }}>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span className="flex-1 truncate text-xs font-semibold" style={{ color: '#c27aff' }}>
            {caseContext.caseId}
          </span>
          <button
            onClick={() => { clearCaseContext(); setPage('second-opinion'); }}
            className="text-xs px-1.5 py-0.5 rounded transition-colors"
            style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
            title="Back to cases list"
          >
            ✕
          </button>
        </div>
        <span className="text-xs" style={{ color: 'var(--muted)', fontSize: 10 }}>
          {caseContext.items.length} image{caseContext.items.length !== 1 ? 's' : ''} selected for this case
        </span>
      </div>

      <div className="viewer-case-toolbar">
        <span className="viewer-case-toolbar-copy">{compareSelection.length}/4 compare</span>
        {compareSelection.length >= 2 && (
          <button type="button" className="viewer-case-compare-btn" onClick={openCompareWindow}>
            Compare
          </button>
        )}
        {compareSelection.length > 0 && (
          <button type="button" className="viewer-case-clear-btn" onClick={() => setCompareSelection([])}>
            Clear
          </button>
        )}
      </div>

      {/* Items list */}
      <div className="flex-1 overflow-y-auto py-1">
        {caseContext.items.map((item, idx) => {
          const isActive = activeItem?._id === item._id;
          const isSelected = !!compareSelection.find((i) => i._id === item._id);
          return (
            <div
              key={item._id}
              className={`tree-item pl-3 pr-2 py-1.5 ${isActive ? 'selected' : ''}`}
              onClick={() => openCaseItem(item, caseContext)}
              style={{ cursor: 'pointer' }}
            >
              <button
                type="button"
                className={`viewer-compare-check ${isSelected ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); toggleCompareSelect(item); }}
                title={isSelected ? 'Remove from compare' : 'Add to compare'}
              >
                {isSelected ? (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <polyline points="2 6 5 9 10 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : null}
              </button>
              <div className="w-9 h-7 rounded overflow-hidden shrink-0" style={{ background: 'var(--bg-viewer)' }}>
                <img
                  src={getThumbnailUrl(item._id, localStorage.getItem('girderToken') || '', 160, 100)}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs leading-tight" style={{ color: isActive ? 'var(--accent)' : 'var(--text)' }}>
                  {item.name}
                </div>
                <div className="text-xs" style={{ color: 'var(--muted)', fontSize: 10 }}>
                  Slide {idx + 1}
                </div>
              </div>
              {isSelected && <span className="viewer-compare-chip">Compare</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main sidebar ─────────────────────────────────────────────────────────────
export default function LeftSidebar() {
  const { leftPanelOpen, leftPanelTab, setLeftPanelTab, caseContext, hasRole } = useStore();
  const [search, setSearch] = useState('');
  const canAnnotate = hasRole('annotation-users');

  const { data: collections, isLoading, error } = useQuery({
    queryKey: ['collections'],
    queryFn: getCollections,
  });

  const filtered = useMemo(() => {
    const list = Array.isArray(collections) ? collections : [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => {
      const name = String(c?.name || '').toLowerCase();
      const id = String(c?._id || '').toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }, [collections, search]);

  if (!leftPanelOpen) return null;

  if (leftPanelTab === 'annotations' && canAnnotate) {
    return (
      <div className="app-sidepanel app-sidepanel-left" style={{ width: 'var(--left-w)' }}>
        <div className="viewer-panel-topbar viewer-panel-topbar-left">
          <div>
            <div className="viewer-panel-eyebrow">Slide Tools</div>
            <div className="viewer-panel-title">Annotations</div>
          </div>
        </div>
        <div className="viewer-inline-tabbar">
          <button type="button" className="viewer-inline-tab" onClick={() => setLeftPanelTab('slides')}>Slides</button>
          <button type="button" className="viewer-inline-tab active">Annotations</button>
          <button type="button" className="viewer-inline-tab" onClick={() => setLeftPanelTab('layers')}>Layers</button>
        </div>
        <div className="flex-1 overflow-hidden">
          <AnnotationsPanel />
        </div>
      </div>
    );
  }

  if (leftPanelTab === 'layers' && canAnnotate) {
    return (
      <div className="app-sidepanel app-sidepanel-left" style={{ width: 'var(--left-w)' }}>
        <div className="viewer-panel-topbar viewer-panel-topbar-left">
          <div>
            <div className="viewer-panel-eyebrow">Slide Tools</div>
            <div className="viewer-panel-title">Layers</div>
          </div>
        </div>
        <div className="viewer-inline-tabbar">
          <button type="button" className="viewer-inline-tab" onClick={() => setLeftPanelTab('slides')}>Slides</button>
          <button type="button" className="viewer-inline-tab" onClick={() => setLeftPanelTab('annotations')}>Annotations</button>
          <button type="button" className="viewer-inline-tab active">Layers</button>
        </div>
        <div className="flex-1 overflow-hidden">
          <LayersPanel />
        </div>
      </div>
    );
  }

  // When a Second Opinion case is open, show only its selected images
  if (caseContext) return <CaseItemsPanel caseContext={caseContext} />;

  return (
    <div
      className="app-sidepanel app-sidepanel-left"
      style={{ width: 'var(--left-w)' }}
    >
      <div className="viewer-panel-topbar viewer-panel-topbar-left">
        <div>
          <div className="viewer-panel-eyebrow">Navigation</div>
          <div className="viewer-panel-title">Collections</div>
        </div>
        <div className="viewer-panel-count">{filtered?.length || 0}</div>
      </div>

      {canAnnotate && (
        <div className="viewer-inline-tabbar">
          <button type="button" className="viewer-inline-tab active">Slides</button>
          <button type="button" className="viewer-inline-tab" onClick={() => setLeftPanelTab('annotations')}>Annotations</button>
          <button type="button" className="viewer-inline-tab" onClick={() => setLeftPanelTab('layers')}>Layers</button>
        </div>
      )}

      <div className="panel-search-wrap">
        <div className="relative">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"
            className="absolute left-2 top-1/2 -translate-y-1/2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            className="app-search-input"
            placeholder="Search collections…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="flex justify-center items-center py-8">
            <div className="spinner" />
          </div>
        )}
        {error && (
          <div className="text-xs text-red-400 p-3">
            Failed to load collections. Check server connection.
          </div>
        )}
        {filtered?.map((col) => (
          <CollectionNode key={col._id} collection={col} />
        ))}
        {filtered?.length === 0 && !isLoading && (
          <div className="text-xs text-gray-600 p-3 text-center">No collections found</div>
        )}
      </div>
    </div>
  );
}
