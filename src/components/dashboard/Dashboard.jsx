// src/components/dashboard/Dashboard.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCollectionStats, getSOCases, createCollection } from '../../api/index.js';
import { GIRDER_BASE, KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import AppLogo from '../layout/AppLogo.jsx';
import ImportModal from './ImportModal.jsx';

function StatCard({ icon, label, value, sub, color = '#4da6ff', onClick }) {
  return (
    <div
      onClick={onClick}
      className="flex flex-col gap-2 p-5 rounded-xl transition-all duration-200"
      style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', cursor: onClick ? 'pointer' : 'default' }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = color + '55'; }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.borderColor = 'var(--border)'; }}
    >
      <div className="flex items-center justify-between">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: color + '22' }}>
          {icon}
        </div>
        {onClick && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        )}
      </div>
      <div>
        <div className="text-2xl font-bold tracking-tight font-mono" style={{ color }}>{value}</div>
        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
        {sub && <div className="text-xs text-gray-700 mt-0.5 font-mono">{sub}</div>}
      </div>
    </div>
  );
}

function CollectionCard({ collection, stats, onClick }) {
  const colors = ['#4da6ff', '#4caf82', '#f5a623', '#c27aff', '#e94560', '#00bcd4', '#ff9800'];
  const color = colors[Math.abs(collection._id.charCodeAt(0) + collection._id.charCodeAt(1)) % colors.length];

  return (
    <div
      onClick={onClick}
      className="group relative flex flex-col gap-3 p-4 rounded-xl cursor-pointer transition-all duration-200"
      style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color + '44'; e.currentTarget.style.background = 'var(--highlight)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-panel)'; }}
    >
      <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl opacity-60" style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />

      <div className="flex items-start justify-between gap-2">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: color + '1a', border: `1px solid ${color}33` }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill={color + '44'} stroke={color} strokeWidth="1.8">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
          </svg>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="2" className="group-hover:stroke-gray-400 transition-colors mt-1">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </div>

      <div>
        <div className="text-sm font-semibold leading-tight truncate" style={{ color: 'var(--text)' }}>{collection.name}</div>
        {collection.description && (
          <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--muted)' }}>{collection.description}</div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-auto pt-2" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="text-center">
          <div className="text-xs font-mono font-bold" style={{ color }}>{stats?.folders ?? '...'} </div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Cases</div>
        </div>
        <div className="w-px h-6" style={{ background: 'var(--border)' }} />
        <div className="text-center">
          <div className="text-xs font-mono font-bold" style={{ color }}>{stats?.items ?? '...'} </div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Images</div>
        </div>
      </div>
    </div>
  );
}

function CreateOrgModal({ onClose, onCreated }) {
  const [name, setName]         = useState('');
  const [slug, setSlug]         = useState('');
  const [desc, setDesc]         = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [created, setCreated]   = useState(null); // collection object after success

  const handleNameChange = (v) => {
    setName(v);
    if (!slug || slug === toSlug(name)) setSlug(toSlug(v));
  };
  const toSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
    } finally {
      setSaving(false);
    }
  };

  const steps = created ? [
    { done: true,  text: `Girder collection "${created.col.name}" created` },
    { done: false, text: `Create Keycloak groups: /${created.slug}/admin  /${created.slug}/pathologist  /${created.slug}/lab-tech  /${created.slug}/referring  /${created.slug}/patient` },
    { done: false, text: `Run ACL setup script: bash deploy/scripts/setup-org-acl.sh "${created.col._id}" ${created.slug}` },
    { done: false, text: `Create org admin account in Keycloak → assign /${created.slug}/admin` },
    { done: false, text: `Org admin logs in → Girder group sync runs → confirm collection access` },
  ] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rounded-xl p-6 w-full max-w-lg" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            {created ? 'Organization Created' : 'New Organization'}
          </h2>
          <button onClick={onClose} className="btn-icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {!created ? (
          <>
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Organization Name *</label>
                <input
                  autoFocus
                  className="input w-full"
                  placeholder="e.g. BMJH"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Org Slug (Keycloak group prefix) *</label>
                <input
                  className="input w-full font-mono"
                  placeholder="e.g. bmjh"
                  value={slug}
                  onChange={(e) => setSlug(toSlug(e.target.value))}
                />
                <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  Used for Keycloak groups: /{slug || 'slug'}/admin, /{slug || 'slug'}/pathologist …
                </p>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Description (optional)</label>
                <input className="input w-full" placeholder="e.g. Baptist Memorial Johns Hopkins" value={desc} onChange={(e) => setDesc(e.target.value)} />
              </div>
            </div>

            {error && <p className="text-xs mt-3" style={{ color: '#e94560' }}>{error}</p>}

            <div className="flex justify-end gap-2 mt-5">
              <button className="btn btn-secondary text-xs" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary text-xs" onClick={handleCreate} disabled={saving}>
                {saving ? <span className="flex items-center gap-1.5"><div className="spinner" style={{ width: 10, height: 10 }}/> Creating…</span> : 'Create Organization'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>
              Collection created. Complete these steps to finish onboarding:
            </p>
            <ol className="flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2 text-xs" style={{ color: s.done ? '#4caf82' : 'var(--text)' }}>
                  <span className="shrink-0 mt-0.5">
                    {s.done
                      ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      : <span className="inline-block w-3.5 h-3.5 rounded-full text-center leading-3.5 font-bold" style={{ background: 'var(--border)', fontSize: 9 }}>{i + 1}</span>
                    }
                  </span>
                  <span className="font-mono leading-relaxed">{s.text}</span>
                </li>
              ))}
            </ol>
            <div className="flex justify-end mt-5">
              <button className="btn btn-primary text-xs" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user, userGroups, clearAuth, setPage, setActiveCollection } = useStore();
  const [collectionStats, setCollectionStats] = useState({});
  const [greeting, setGreeting] = useState('');
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showImport, setShowImport]       = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
  }, []);

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

  const totalImages = useMemo(
    () => Object.values(collectionStats).reduce((s, x) => s + (x?.items || 0), 0),
    [collectionStats]
  );
  const totalFolders = useMemo(
    () => Object.values(collectionStats).reduce((s, x) => s + (x?.folders || 0), 0),
    [collectionStats]
  );
  const statsLoadedCount = Object.keys(collectionStats).length;
  const statsReady = collections.length > 0 && statsLoadedCount >= collections.length;

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

  const goToWorklist = (col) => {
    setActiveCollection(col);
    setPage('worklist');
  };

  const hasRole = useStore((s) => s.hasRole);

  const displayName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.login || 'Pathologist';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      {showCreateOrg && (
        <CreateOrgModal
          onClose={() => setShowCreateOrg(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ['collections'] })}
        />
      )}
      {showImport && (
        <ImportModal
          collections={collections}
          onClose={() => setShowImport(false)}
          onImported={() => qc.invalidateQueries({ queryKey: ['collections'] })}
        />
      )}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20" style={{ background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center">
          <AppLogo />
        </div>

        <div className="flex-1" />

        <nav className="flex items-center gap-1">
          {[
            { id: 'dashboard',      label: 'Dashboard',      show: true,                                  icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg> },
            { id: 'projects',       label: 'Projects',       show: hasRole('projects-users'),             icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg> },
            { id: 'worklist',       label: 'All Images',     show: true,                                  icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg> },
            { id: 'second-opinion', label: 'Second Opinion', show: hasRole('second-opinion-users'),       icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
          ].filter(item => item.show).map(item => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: item.id === 'dashboard' ? 'var(--highlight)' : 'transparent',
                color: item.id === 'dashboard' ? 'var(--accent)' : 'var(--muted)',
                border: item.id === 'dashboard' ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              {item.icon}{item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 pl-3" style={{ borderLeft: '1px solid var(--border)' }}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: 'linear-gradient(135deg, #4da6ff22, #7c3aed22)', border: '1px solid rgba(77,166,255,0.3)', color: '#4da6ff' }}>
            {displayName[0]?.toUpperCase()}
          </div>
          <span className="text-xs hidden md:block" style={{ color: 'var(--muted)' }}>{displayName}</span>
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
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>
              {greeting}, <span style={{ color: 'var(--accent)' }}>{user?.firstName || user?.login}</span>
            </h1>
            <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
              {(isLoading || !statsReady) ? 'Loading your workspace...' : `${collections.length} collection${collections.length !== 1 ? 's' : ''} - ${totalImages.toLocaleString()} images across ${totalFolders} cases`}
            </p>
          </div>

          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight" style={{ color: 'var(--text)' }}>
              Organizations
              <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>({collections.length})</span>
            </h2>
            <div className="flex items-center gap-3">
              {user?.admin && (
                <button
                  onClick={() => setShowCreateOrg(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: 'rgba(77,166,255,0.12)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.25)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  New Organization
                </button>
              )}
              {hasRole('import-users') && collections.length > 0 && (
                <button
                  onClick={() => setShowImport(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: 'rgba(76,175,130,0.12)', color: '#4caf82', border: '1px solid rgba(76,175,130,0.25)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  Import Slides
                </button>
              )}
              <button onClick={() => setPage('worklist')} className="text-xs flex items-center gap-1 transition-colors" style={{ color: 'var(--accent)' }}>
                View all images
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16 mb-8">
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading collections...</span>
              </div>
            </div>
          ) : (
            <>
              {collections.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center mb-6">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" className="mb-3" style={{ stroke: 'var(--border)' }}>
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
                  </svg>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>No collections found</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Collections will appear here once created in Girder</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
                {collections.map((col) => (
                  <CollectionCard
                    key={col._id}
                    collection={col}
                    stats={collectionStats[col._id]}
                    onClick={() => goToWorklist(col)}
                  />
                ))}
                <StatCard
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" /></svg>}
                  label="Collections"
                  value={collections.length}
                  color="#4da6ff"
                  onClick={() => setPage('worklist')}
                />
                <StatCard
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><circle cx="12" cy="10" r="3" /></svg>}
                  label="Total Images"
                  value={statsReady ? totalImages.toLocaleString() : '...'}
                  color="#4caf82"
                  onClick={() => setPage('worklist')}
                />
                <StatCard
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>}
                  label="Cases"
                  value={statsReady ? totalFolders.toLocaleString() : '...'}
                  color="#f5a623"
                />
                <StatCard
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c27aff" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                  label="Second Opinion Cases"
                  value={soCases.length}
                  sub={soCases.filter(f => f.meta?.pathassist?.secondOpinion?.status === 'Submitted').length > 0
                    ? `${soCases.filter(f => f.meta?.pathassist?.secondOpinion?.status === 'Submitted').length} pending review`
                    : undefined}
                  color="#c27aff"
                  onClick={() => setPage('second-opinion')}
                />
              </div>
            </>
          )}

          <div className="mt-12 pt-6 text-center text-xs font-mono" style={{ borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>
            PathAssist - IMPART - lymphoma.dev.pathassist.health
          </div>
        </div>
      </div>
    </div>
  );
}
