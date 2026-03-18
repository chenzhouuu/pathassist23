// src/components/dashboard/Dashboard.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCollectionStats, getSOCases, createCollection } from '../../api/index.js';
import { GIRDER_BASE, KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import { APP_NAME, APP_TAGLINE } from '../../config/branding.js';
import AppLogo from '../layout/AppLogo.jsx';
import ImportModal from './ImportModal.jsx';

// ── Metric card in the stats row ────────────────────────────────────────────
function MetricCard({ icon, label, value, sub, color, onClick }) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-4 p-5 rounded-2xl transition-all duration-200 group"
      style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        cursor: onClick ? 'pointer' : 'default',
        flex: '1 1 0',
        minWidth: 0,
      }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.borderColor = color + '60'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = `0 8px 24px ${color}18`; }}}
      onMouseLeave={e => { if (onClick) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}}
    >
      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `linear-gradient(135deg, ${color}55, ${color}30)`, border: `1px solid ${color}60` }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold tracking-tight font-mono leading-none" style={{ color }}>{value}</div>
        <div className="text-xs mt-1 font-medium" style={{ color: 'var(--muted)' }}>{label}</div>
        {sub && <div className="text-xs mt-0.5 font-semibold" style={{ color: color + 'cc' }}>{sub}</div>}
      </div>
      {onClick && (
        <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
      )}
    </div>
  );
}

// ── Organization / collection card ──────────────────────────────────────────
function CollectionCard({ collection, stats, onClick }) {
  const palettes = [
    { from: '#4da6ff', to: '#7c3aed' },
    { from: '#4caf82', to: '#06b6d4' },
    { from: '#f5a623', to: '#ef4444' },
    { from: '#c27aff', to: '#ec4899' },
    { from: '#00bcd4', to: '#4da6ff' },
    { from: '#f59e0b', to: '#4caf82' },
  ];
  const p = palettes[Math.abs(collection._id.charCodeAt(0) + collection._id.charCodeAt(1)) % palettes.length];

  return (
    <div
      onClick={onClick}
      className="group relative flex flex-col rounded-2xl cursor-pointer overflow-hidden transition-all duration-200"
      style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 16px 40px ${p.from}20`; e.currentTarget.style.borderColor = p.from + '50'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; e.currentTarget.style.borderColor = 'var(--border)'; }}
    >
      {/* Gradient header strip */}
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${p.from}, ${p.to})` }} />

      {/* Card body */}
      <div className="flex flex-col gap-4 p-5 flex-1">
        {/* Icon + arrow */}
        <div className="flex items-start justify-between">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center"
            style={{ background: `linear-gradient(135deg, ${p.from}25, ${p.to}15)`, border: `1px solid ${p.from}30` }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={p.from} strokeWidth="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200"
            style={{ background: p.from + '18' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={p.from} strokeWidth="2.5">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </div>
        </div>

        {/* Name + description */}
        <div>
          <div className="text-sm font-bold leading-tight" style={{ color: 'var(--text)' }}>{collection.name}</div>
          {collection.description && (
            <div className="text-xs mt-1 line-clamp-2 leading-relaxed" style={{ color: 'var(--muted)' }}>{collection.description}</div>
          )}
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 mt-auto pt-3" style={{ borderTop: `1px solid ${p.from}20` }}>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: p.from }} />
            <span className="text-xs font-bold font-mono" style={{ color: 'var(--text)' }}>{stats?.folders ?? '—'}</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Cases</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: p.to }} />
            <span className="text-xs font-bold font-mono" style={{ color: 'var(--text)' }}>{stats?.items ?? '—'}</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Images</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Create Org Modal ─────────────────────────────────────────────────────────
function CreateOrgModal({ onClose, onCreated }) {
  const [name, setName]       = useState('');
  const [slug, setSlug]       = useState('');
  const [desc, setDesc]       = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [created, setCreated] = useState(null);

  const toSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const handleNameChange = (v) => { setName(v); if (!slug || slug === toSlug(name)) setSlug(toSlug(v)); };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Organization name is required.'); return; }
    if (!slug.trim())  { setError('Org slug is required.'); return; }
    setSaving(true); setError('');
    try {
      const col = await createCollection(name.trim(), desc.trim());
      setCreated({ col, slug: slug.trim() });
      onCreated();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Failed to create collection.');
    } finally { setSaving(false); }
  };

  const steps = created ? [
    { done: true,  text: `Girder collection "${created.col.name}" created` },
    { done: false, text: `Create Keycloak groups: /${created.slug}/admin  /${created.slug}/pathologist  /${created.slug}/lab-tech` },
    { done: false, text: `Run ACL setup: bash deploy/scripts/setup-org-acl.sh "${created.col._id}" ${created.slug}` },
    { done: false, text: `Create org admin in Keycloak → assign /${created.slug}/admin` },
    { done: false, text: `Org admin logs in → confirm collection access` },
  ] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rounded-2xl p-6 w-full max-w-lg" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 32px 80px rgba(0,0,0,0.5)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{created ? 'Organization Created' : 'New Organization'}</h2>
          <button onClick={onClose} className="btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        {!created ? (
          <>
            <div className="flex flex-col gap-3">
              <div><label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Organization Name *</label><input autoFocus className="input w-full" placeholder="e.g. BMJH" value={name} onChange={(e) => handleNameChange(e.target.value)} /></div>
              <div><label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Org Slug *</label><input className="input w-full font-mono" placeholder="e.g. bmjh" value={slug} onChange={(e) => setSlug(toSlug(e.target.value))} /><p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>/{slug || 'slug'}/admin, /{slug || 'slug'}/pathologist …</p></div>
              <div><label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Description (optional)</label><input className="input w-full" placeholder="e.g. Baptist Memorial Johns Hopkins" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
            </div>
            {error && <p className="text-xs mt-3" style={{ color: '#e94560' }}>{error}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button className="btn btn-secondary text-xs" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary text-xs" onClick={handleCreate} disabled={saving}>{saving ? 'Creating…' : 'Create Organization'}</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>Collection created. Complete these steps:</p>
            <ol className="flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2 text-xs" style={{ color: s.done ? '#4caf82' : 'var(--text)' }}>
                  <span className="shrink-0 mt-0.5">{s.done ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg> : <span className="inline-block w-3.5 h-3.5 rounded-full text-center font-bold" style={{ background: 'var(--border)', fontSize: 9, lineHeight: '14px' }}>{i+1}</span>}</span>
                  <span className="font-mono leading-relaxed">{s.text}</span>
                </li>
              ))}
            </ol>
            <div className="flex justify-end mt-5"><button className="btn btn-primary text-xs" onClick={onClose}>Done</button></div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, clearAuth, setPage, setActiveCollection } = useStore();
  const [collectionStats, setCollectionStats] = useState({});
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showImport, setShowImport]       = useState(false);
  const qc = useQueryClient();

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

  const { data: soCases = [] } = useQuery({
    queryKey: ['so-cases'],
    queryFn: getSOCases,
    staleTime: 60_000,
  });

  useEffect(() => {
    collections.forEach(async (col) => {
      if (collectionStats[col._id]) return;
      const stats = await getCollectionStats(col._id);
      setCollectionStats(prev => ({ ...prev, [col._id]: stats }));
    });
  }, [collections]);

  const totalImages  = useMemo(() => Object.values(collectionStats).reduce((s, x) => s + (x?.items || 0), 0), [collectionStats]);
  const totalFolders = useMemo(() => Object.values(collectionStats).reduce((s, x) => s + (x?.folders || 0), 0), [collectionStats]);
  const statsLoadedCount = Object.keys(collectionStats).length;
  const statsReady = collections.length > 0 && statsLoadedCount >= collections.length;
  const pendingSO = soCases.filter(f => f.meta?.pathassist?.secondOpinion?.status === 'Submitted').length;

  const handleLogout = async () => {
    try { await fetch(`${GIRDER_BASE}/user/authentication`, { method: 'DELETE', headers: { 'Girder-Token': localStorage.getItem('girderToken') || '' } }); } catch (_) {}
    clearAuth();
    window.location.href = KEYCLOAK_LOGOUT_URL;
  };

  const goToWorklist = (col) => { setActiveCollection(col); setPage('worklist'); };

  const hasRole   = useStore((s) => s.hasRole);
  const canImport = useStore((s) => s.hasRole('import-users'));

  const displayName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.login || 'User';

  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>

      {showCreateOrg && <CreateOrgModal onClose={() => setShowCreateOrg(false)} onCreated={() => qc.invalidateQueries({ queryKey: ['collections'] })} />}
      {showImport && <ImportModal collections={collections} onClose={() => setShowImport(false)} onImported={() => qc.invalidateQueries({ queryKey: ['collections'] })} />}

      {/* ── Navbar ─────────────────────────────────────────────────────── */}
      <nav className="flex items-center gap-3 px-6 h-14 shrink-0 z-20"
        style={{ background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(16px)' }}>

        {/* Logo */}
        <div className="flex items-center gap-3 pr-4" style={{ borderRight: '1px solid var(--border)' }}>
          <AppLogo className="h-7 w-auto object-contain" />
        </div>

        {/* Nav links */}
        <div className="flex items-center gap-0.5">
          {[
            { id: 'dashboard',      label: 'Dashboard',      show: true,                            icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> },
            { id: 'projects',       label: 'Projects',       show: hasRole('projects-users'),        icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
            { id: 'worklist',       label: 'All Images',     show: true,                            icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
            { id: 'second-opinion', label: 'Second Opinion', show: hasRole('second-opinion-users'), icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
          ].filter(i => i.show).map(item => (
            <button key={item.id} onClick={() => setPage(item.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: item.id === 'dashboard' ? 'var(--accent)18' : 'transparent',
                color: item.id === 'dashboard' ? 'var(--accent)' : 'var(--muted)',
                borderBottom: item.id === 'dashboard' ? '2px solid var(--accent)' : '2px solid transparent',
              }}>
              {item.icon}{item.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {user?.admin && (
            <button onClick={() => setShowCreateOrg(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{ background: 'rgba(77,166,255,0.1)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.2)' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Org
            </button>
          )}
          {collections.length > 0 && (
            <button onClick={() => setShowImport(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'linear-gradient(135deg, #4caf82, #06b6d4)', color: '#fff', border: 'none', boxShadow: '0 2px 12px #4caf8240' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Import Slides
            </button>
          )}
        </div>

        {/* User avatar */}
        <div className="flex items-center gap-2 pl-3" style={{ borderLeft: '1px solid var(--border)' }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'linear-gradient(135deg, #4da6ff, #7c3aed)', color: '#fff', letterSpacing: '0.05em' }}>
            {initials}
          </div>
          <div className="hidden md:block">
            <div className="text-xs font-semibold leading-none" style={{ color: 'var(--text)' }}>{displayName}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--muted)', fontSize: 10 }}>{APP_NAME}</div>
          </div>
          <button onClick={handleLogout} className="btn-icon ml-1 opacity-60 hover:opacity-100 transition-opacity" title="Sign out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto">

        {/* ── Metrics strip ────────────────────────────────────────────── */}
        <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="max-w-7xl mx-auto flex gap-3 flex-wrap">
              <MetricCard
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="1.8"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/></svg>}
                label="Organizations" value={collections.length} color="#4da6ff" onClick={() => setPage('worklist')} />
              <MetricCard
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="3"/></svg>}
                label="Total Images" value={statsReady ? totalImages.toLocaleString() : '…'} color="#4caf82" onClick={() => setPage('worklist')} />
              <MetricCard
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>}
                label="Cases" value={statsReady ? totalFolders.toLocaleString() : '…'} color="#f5a623" />
              <MetricCard
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c27aff" strokeWidth="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                label="Second Opinion" value={soCases.length}
                sub={pendingSO > 0 ? `${pendingSO} pending review` : undefined}
                color="#c27aff" onClick={() => setPage('second-opinion')} />
          </div>
        </div>

        {/* ── Collections grid ─────────────────────────────────────────── */}
        <div className="max-w-7xl mx-auto px-6 py-8">

          <div className="flex items-center justify-between mb-5">
            <p className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Click a card to browse slides and cases</p>
            <button onClick={() => setPage('worklist')}
              className="flex items-center gap-1.5 text-xs font-medium transition-all hover:gap-2.5"
              style={{ color: 'var(--accent)' }}>
              View all images
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading collections…</span>
              </div>
            </div>
          ) : collections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center rounded-2xl"
              style={{ border: '2px dashed var(--border)' }}>
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{ background: 'var(--highlight)' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.5">
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>
                </svg>
              </div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>No collections found</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Collections will appear here once created in Girder</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {collections.map((col) => (
                <CollectionCard key={col._id} collection={col} stats={collectionStats[col._id]} onClick={() => goToWorklist(col)} />
              ))}
            </div>
          )}

          {/* Footer */}
          <div className="mt-16 pt-5 flex items-center justify-between text-xs" style={{ borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>
            <span className="font-mono">{APP_NAME} · {window.location.hostname}</span>
            <span className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#4caf82' }} />
              All systems operational
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
