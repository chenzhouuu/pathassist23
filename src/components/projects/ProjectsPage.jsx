// src/components/projects/ProjectsPage.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCollections, getCollectionStats,
  createCollection, updateCollection, updateCollectionMetadata,
} from '../../api/index.js';
import { GIRDER_BASE, KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import AppLogo from '../layout/AppLogo.jsx';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  active:    { label: 'Active',      color: '#4caf82', bg: '#4caf8218' },
  review:    { label: 'In Review',   color: '#f5a623', bg: '#f5a62318' },
  completed: { label: 'Completed',   color: '#4da6ff', bg: '#4da6ff18' },
  archived:  { label: 'Archived',    color: '#6b7280', bg: '#6b728018' },
};
const PRIORITY_CONFIG = {
  high:   { label: 'High',   color: '#e94560' },
  normal: { label: 'Normal', color: '#f5a623' },
  low:    { label: 'Low',    color: '#4b5563' },
};
const CASE_TYPES = ['Lymphoma', 'Breast Cancer', 'Lung Cancer', 'Prostate', 'GI Tract', 'Skin', 'Neuro', 'Other'];
const FILTER_TABS = ['all', 'active', 'review', 'completed', 'archived'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getProjectMeta(col) {
  return col.meta?.pathassist || {};
}
function statusOf(col) {
  return getProjectMeta(col).status || 'active';
}
function accentColor(col) {
  const palette = ['#4da6ff', '#4caf82', '#f5a623', '#c27aff', '#e94560', '#00bcd4', '#ff9800'];
  return palette[Math.abs((col._id.charCodeAt(0) + col._id.charCodeAt(1)) % palette.length)];
}

// ── StatusPill ────────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.active;
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.label}
    </span>
  );
}

// ── PriorityDot ───────────────────────────────────────────────────────────────
function PriorityDot({ priority }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.normal;
  return (
    <span className="flex items-center gap-1 text-xs" style={{ color: cfg.color }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cfg.color }} />
      {cfg.label}
    </span>
  );
}

// ── ProjectCard ───────────────────────────────────────────────────────────────
function ProjectCard({ collection, stats, onOpen, onEdit }) {
  const color = accentColor(collection);
  const meta = getProjectMeta(collection);
  const status = statusOf(collection);
  const updated = collection.updated
    ? new Date(collection.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  return (
    <div
      className="group relative flex flex-col gap-3 p-4 rounded-xl cursor-pointer transition-all duration-200"
      style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hex)' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color + '44'; e.currentTarget.style.background = 'var(--highlight-hex)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-hex)'; e.currentTarget.style.background = 'var(--bg-panel)'; }}
      onClick={onOpen}
    >
      {/* Accent stripe */}
      <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl opacity-60"
        style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />

      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: color + '1a', border: `1px solid ${color}33` }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill={color + '44'} stroke={color} strokeWidth="1.8">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusPill status={status} />
          <button
            onClick={e => { e.stopPropagation(); onEdit(); }}
            className="p-1 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
            style={{ color: 'var(--muted-hex)' }}
            title="Edit project"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Title + description */}
      <div>
        <div className="text-sm font-semibold leading-tight truncate" style={{ color: 'var(--text)' }}>
          {collection.name}
        </div>
        {collection.description && (
          <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--muted-hex)' }}>
            {collection.description}
          </div>
        )}
      </div>

      {/* Tags row */}
      <div className="flex flex-wrap items-center gap-2">
        {meta.caseType && (
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg)', color: 'var(--muted-hex)', border: '1px solid var(--border-hex)' }}>
            {meta.caseType}
          </span>
        )}
        {meta.priority && <PriorityDot priority={meta.priority} />}
        {meta.assignee && (
          <span className="text-xs" style={{ color: 'var(--muted-hex)' }}>
            👤 {meta.assignee}
          </span>
        )}
      </div>

      {/* Stats footer */}
      <div className="flex items-center gap-3 mt-auto pt-2" style={{ borderTop: '1px solid var(--border-hex)' }}>
        <div className="text-center">
          <div className="text-xs font-mono font-bold" style={{ color }}>{stats?.folders ?? '…'}</div>
          <div className="text-xs" style={{ color: 'var(--muted-hex)' }}>Cases</div>
        </div>
        <div className="w-px h-5" style={{ background: 'var(--border-hex)' }} />
        <div className="text-center">
          <div className="text-xs font-mono font-bold" style={{ color }}>{stats?.items ?? '…'}</div>
          <div className="text-xs" style={{ color: 'var(--muted-hex)' }}>Images</div>
        </div>
        <div className="ml-auto text-xs font-mono" style={{ color: 'var(--muted-hex)' }}>{updated}</div>
      </div>
    </div>
  );
}

// ── CreateEditModal ───────────────────────────────────────────────────────────
function ProjectModal({ initial, onClose, onSave }) {
  const isEdit = !!initial;
  const initMeta = initial ? getProjectMeta(initial) : {};

  const [name, setName]           = useState(initial?.name || '');
  const [desc, setDesc]           = useState(initial?.description || '');
  const [status, setStatus]       = useState(initMeta.status || 'active');
  const [caseType, setCaseType]   = useState(initMeta.caseType || '');
  const [priority, setPriority]   = useState(initMeta.priority || 'normal');
  const [assignee, setAssignee]   = useState(initMeta.assignee || '');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Project name is required'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave({ name: name.trim(), description: desc.trim(), meta: { status, caseType, priority, assignee } });
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Save failed');
      setSaving(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '7px 10px', borderRadius: 7, fontSize: 12,
    background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border-hex)', outline: 'none',
  };
  const selectStyle = { ...inputStyle, cursor: 'pointer' };
  const labelStyle  = { fontSize: 11, color: 'var(--muted-hex)', marginBottom: 4, display: 'block' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rounded-xl p-5 w-full max-w-md flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hex)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>

        {/* Title */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--text)' }}>
              {isEdit ? 'Edit Project' : 'New PathAssist Project'}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted-hex)' }}>
              {isEdit ? 'Update project details' : 'Create a new project to organise cases and slides'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700/50 transition-colors" style={{ color: 'var(--muted-hex)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-3">
          <div>
            <label style={labelStyle}>Project Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Lymphoma Study Q1 2025"
              style={inputStyle} onFocus={e => e.target.style.borderColor = '#4da6ff'} onBlur={e => e.target.style.borderColor = 'var(--border-hex)'} />
          </div>
          <div>
            <label style={labelStyle}>Description</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Brief project description..."
              rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
              onFocus={e => e.target.style.borderColor = '#4da6ff'} onBlur={e => e.target.style.borderColor = 'var(--border-hex)'} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)} style={selectStyle}>
                {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
                {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Case Type</label>
              <select value={caseType} onChange={e => setCaseType(e.target.value)} style={selectStyle}>
                <option value="">Select type…</option>
                {CASE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Assignee</label>
              <input value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="Dr. Smith"
                style={inputStyle} onFocus={e => e.target.style.borderColor = '#4da6ff'} onBlur={e => e.target.style.borderColor = 'var(--border-hex)'} />
            </div>
          </div>
        </div>

        {error && (
          <div className="text-xs px-3 py-2 rounded-lg" style={{ background: '#e9456018', color: '#e94560', border: '1px solid #e9456033' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 justify-end pt-1">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{ background: 'var(--bg)', color: 'var(--muted-hex)', border: '1px solid var(--border-hex)' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !name.trim()}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
            style={{ background: saving ? 'rgba(77,166,255,0.3)' : '#4da6ff', color: '#fff', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', opacity: !name.trim() ? 0.5 : 1 }}>
            {saving && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {isEdit ? 'Save Changes' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ProjectsPage ──────────────────────────────────────────────────────────────
export default function ProjectsPage() {
  const { user, clearAuth, setPage, setActiveCollection, setActiveProject, hasRole } = useStore();
  const qc = useQueryClient();

  const [filterStatus, setFilterStatus] = useState('all');
  const [search, setSearch]             = useState('');
  const [showCreate, setShowCreate]     = useState(false);
  const [editTarget, setEditTarget]     = useState(null);
  const [collectionStats, setCollectionStats] = useState({});

  const { data: collections = [], isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: async () => {
      const res = await fetch(`${GIRDER_BASE}/collection?limit=200&sort=name`, {
        headers: { 'Girder-Token': localStorage.getItem('girderToken') || '' },
      });
      return res.json();
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    collections.forEach(async (col) => {
      if (collectionStats[col._id]) return;
      const stats = await getCollectionStats(col._id);
      setCollectionStats(prev => ({ ...prev, [col._id]: stats }));
    });
  }, [collections]);

  // Filter + search
  const filtered = useMemo(() => {
    let list = collections;
    if (filterStatus !== 'all') list = list.filter(c => statusOf(c) === filterStatus);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        (getProjectMeta(c).caseType || '').toLowerCase().includes(q) ||
        (getProjectMeta(c).assignee || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [collections, filterStatus, search]);

  // Stats summary
  const counts = useMemo(() => {
    const r = { active: 0, review: 0, completed: 0, archived: 0, total: collections.length };
    collections.forEach(c => { const s = statusOf(c); if (r[s] !== undefined) r[s]++; });
    return r;
  }, [collections]);

  const handleLogout = async () => {
    try {
      await fetch(`${GIRDER_BASE}/user/authentication`, {
        method: 'DELETE',
        headers: { 'Girder-Token': localStorage.getItem('girderToken') || '' },
      });
    } catch (_) {}
    clearAuth();
    window.location.href = KEYCLOAK_LOGOUT_URL;
  };

  const handleOpen = (col) => {
    setActiveProject(col);
    setActiveCollection(col);
    setPage('browse');
  };

  const handleCreate = async ({ name, description, meta }) => {
    const col = await createCollection(name, description);
    await updateCollectionMetadata(col._id, { pathassist: meta });
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  const handleEdit = async ({ name, description, meta }) => {
    if (!editTarget) return;
    await updateCollection(editTarget._id, { name, description });
    await updateCollectionMetadata(editTarget._id, { pathassist: meta });
    qc.invalidateQueries({ queryKey: ['collections'] });
    setEditTarget(null);
  };

  const displayName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.login || 'Pathologist';

  const navItems = [
    { id: 'browse',         label: 'Browse',         show: true,                            icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
    { id: 'projects',       label: 'Projects',       show: hasRole('projects-users'),       icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
    { id: 'second-opinion', label: 'Second Opinion', show: hasRole('second-opinion-users'), icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
  ].filter(item => item.show);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      {/* Nav */}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20"
        style={{ background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border-hex)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center">
          <AppLogo />
        </div>
        <div className="flex-1" />
        <nav className="flex items-center gap-1">
          {navItems.map(item => (
            <button key={item.id} onClick={() => setPage(item.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: item.id === 'projects' ? 'var(--highlight-hex)' : 'transparent',
                color: item.id === 'projects' ? 'var(--accent-hex)' : 'var(--muted-hex)',
                border: item.id === 'projects' ? '1px solid var(--border-hex)' : '1px solid transparent',
              }}>
              {item.icon}{item.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 pl-3" style={{ borderLeft: '1px solid var(--border-hex)' }}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'linear-gradient(135deg, #4da6ff22, #7c3aed22)', border: '1px solid rgba(77,166,255,0.3)', color: '#4da6ff' }}>
            {displayName[0]?.toUpperCase()}
          </div>
          <span className="text-xs hidden md:block" style={{ color: 'var(--muted-hex)' }}>{displayName}</span>
          <button onClick={handleLogout} className="btn-icon ml-1" title="Sign out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">

          {/* Page header */}
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>
                PathAssist Projects
              </h1>
              <p className="text-sm mt-1" style={{ color: 'var(--muted-hex)' }}>
                {isLoading ? 'Loading projects…' : `${counts.total} project${counts.total !== 1 ? 's' : ''} — ${counts.active} active, ${counts.review} in review`}
              </p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all shrink-0"
              style={{ background: '#4da6ff', color: '#fff', border: 'none' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Project
            </button>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { key: 'active',    label: 'Active',      color: '#4caf82' },
              { key: 'review',    label: 'In Review',   color: '#f5a623' },
              { key: 'completed', label: 'Completed',   color: '#4da6ff' },
              { key: 'archived',  label: 'Archived',    color: '#6b7280' },
            ].map(({ key, label, color }) => (
              <div key={key}
                onClick={() => setFilterStatus(filterStatus === key ? 'all' : key)}
                className="flex flex-col gap-1 p-3 rounded-xl cursor-pointer transition-all"
                style={{
                  background: filterStatus === key ? color + '18' : 'var(--bg-panel)',
                  border: `1px solid ${filterStatus === key ? color + '44' : 'var(--border-hex)'}`,
                }}>
                <div className="text-xl font-bold font-mono" style={{ color }}>{counts[key]}</div>
                <div className="text-xs" style={{ color: 'var(--muted-hex)' }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Filter + search row */}
          <div className="flex flex-wrap items-center gap-3 mb-5">
            {/* Filter tabs */}
            <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hex)' }}>
              {FILTER_TABS.map(tab => (
                <button key={tab}
                  onClick={() => setFilterStatus(tab)}
                  className="px-3 py-1 rounded-md text-xs font-medium transition-all capitalize"
                  style={{
                    background: filterStatus === tab ? 'var(--highlight-hex)' : 'transparent',
                    color: filterStatus === tab ? 'var(--accent-hex)' : 'var(--muted-hex)',
                    border: filterStatus === tab ? '1px solid var(--border-hex)' : '1px solid transparent',
                  }}>
                  {tab === 'all' ? 'All' : STATUS_CONFIG[tab]?.label || tab}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 min-w-[160px] max-w-xs"
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hex)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--muted-hex)', shrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search projects…"
                className="flex-1 text-xs bg-transparent outline-none"
                style={{ color: 'var(--text)', border: 'none' }}
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ color: 'var(--muted-hex)' }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>

            <div className="text-xs ml-auto" style={{ color: 'var(--muted-hex)' }}>
              {filtered.length} of {collections.length}
            </div>
          </div>

          {/* Content */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
                <span className="text-xs" style={{ color: 'var(--muted-hex)' }}>Loading projects…</span>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" className="mb-3" style={{ stroke: 'var(--border-hex)' }}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <p className="text-sm" style={{ color: 'var(--muted-hex)' }}>
                {search || filterStatus !== 'all' ? 'No projects match the current filter' : 'No projects yet'}
              </p>
              {!search && filterStatus === 'all' && (
                <button onClick={() => setShowCreate(true)}
                  className="mt-3 text-xs px-4 py-1.5 rounded-lg"
                  style={{ background: '#4da6ff', color: '#fff' }}>
                  Create your first project
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map(col => (
                <ProjectCard
                  key={col._id}
                  collection={col}
                  stats={collectionStats[col._id]}
                  onOpen={() => handleOpen(col)}
                  onEdit={() => setEditTarget(col)}
                />
              ))}
            </div>
          )}

          <div className="mt-12 pt-6 text-center text-xs font-mono"
            style={{ borderTop: '1px solid var(--border-hex)', color: 'var(--muted-hex)' }}>
            PathAssist Projects — IMPART — lymphoma.dev.pathassist.health
          </div>
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <ProjectModal onClose={() => setShowCreate(false)} onSave={handleCreate} />
      )}
      {editTarget && (
        <ProjectModal initial={editTarget} onClose={() => setEditTarget(null)} onSave={handleEdit} />
      )}
    </div>
  );
}
