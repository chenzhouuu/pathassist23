// src/components/dashboard/Dashboard.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCollectionStats, getSOCases, createCollection } from '../../api/index.js';
import { GIRDER_BASE, KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import { APP_NAME, APP_TAGLINE } from '../../config/branding.js';
import AppLogo from '../layout/AppLogo.jsx';
import ImportModal from './ImportModal.jsx';
import ThemeSwitcher from '../ThemeSwitcher.jsx';

// ── Metric card in the stats row ────────────────────────────────────────────
function MetricCard({ icon, label, value, sub, color, onClick }) {
  return (
    <div
      onClick={onClick}
      className="dashboard-metric-card group"
      style={{ '--metric-color': color, cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="dashboard-metric-icon">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="dashboard-metric-label-row">
          <span className="dashboard-metric-label">{label}</span>
          <span className="dashboard-metric-chip">Live</span>
        </div>
        <div className="dashboard-metric-value">{value}</div>
        {sub && <div className="dashboard-metric-sub">{sub}</div>}
      </div>
      {onClick && (
        <div className="dashboard-metric-arrow">
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
      className="dashboard-collection-card group"
      style={{ '--collection-from': p.from, '--collection-to': p.to }}
    >
      <div className="dashboard-collection-glow" />
      <div className="dashboard-collection-strip" />
      <div className="flex flex-col gap-4 p-5 flex-1 relative z-10">
        <div className="flex items-start justify-between">
          <div className="dashboard-collection-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={p.from} strokeWidth="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="dashboard-collection-arrow">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={p.from} strokeWidth="2.5">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </div>
        </div>

        <div>
          <div className="dashboard-collection-title">{collection.name}</div>
          {collection.description && (
            <div className="dashboard-collection-description">{collection.description}</div>
          )}
        </div>

        <div className="dashboard-collection-stats">
          <div className="dashboard-collection-stat">
            <div className="dashboard-collection-dot" style={{ background: p.from }} />
            <span className="dashboard-collection-stat-value">{stats?.folders ?? '—'}</span>
            <span className="dashboard-collection-stat-label">Cases</span>
          </div>
          <div className="dashboard-collection-stat">
            <div className="dashboard-collection-dot" style={{ background: p.to }} />
            <span className="dashboard-collection-stat-value">{stats?.items ?? '—'}</span>
            <span className="dashboard-collection-stat-label">Images</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const statusMap = {
    Submitted: { color: '#4da6ff', bg: 'rgba(77,166,255,0.14)', border: 'rgba(77,166,255,0.28)' },
    'In Review': { color: '#f5a623', bg: 'rgba(245,166,35,0.14)', border: 'rgba(245,166,35,0.28)' },
    Completed: { color: '#4caf82', bg: 'rgba(76,175,130,0.14)', border: 'rgba(76,175,130,0.28)' },
    STAT: { color: '#e94560', bg: 'rgba(233,69,96,0.14)', border: 'rgba(233,69,96,0.28)' },
    Pending: { color: '#7c3aed', bg: 'rgba(124,58,237,0.14)', border: 'rgba(124,58,237,0.28)' },
  };
  const cfg = statusMap[status] || { color: 'var(--muted)', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.25)' };
  return (
    <span className="dashboard-status-badge" style={{ color: cfg.color, background: cfg.bg, borderColor: cfg.border }}>
      {status || 'Unknown'}
    </span>
  );
}

function RoleActionCard({ eyebrow, title, text, actionLabel, onAction, secondaryLabel, onSecondary, tone = 'blue' }) {
  return (
    <div className={`dashboard-role-card dashboard-tone-${tone}`}>
      <div className="dashboard-eyebrow">{eyebrow}</div>
      <div className="dashboard-role-card-title">{title}</div>
      <p className="dashboard-role-card-text">{text}</p>
      <div className="dashboard-role-card-actions">
        {actionLabel && <button className="dashboard-primary-btn" onClick={onAction}>{actionLabel}</button>}
        {secondaryLabel && <button className="dashboard-secondary-btn" onClick={onSecondary}>{secondaryLabel}</button>}
      </div>
    </div>
  );
}

function RoleTable({ title, subtitle, columns, rows, emptyText }) {
  return (
    <div className="dashboard-table-card">
      <div className="dashboard-table-header">
        <div>
          <div className="dashboard-eyebrow">Role Workspace</div>
          <div className="dashboard-table-title">{title}</div>
          <p className="dashboard-table-subtitle">{subtitle}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="dashboard-table-empty">{emptyText}</div>
      ) : (
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={row.key || idx}>
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  const { user, clearAuth, setPage, setActiveCollection, hasRole } = useStore();
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
  const readyCollections = Object.values(collectionStats).filter(Boolean).length;
  const utilization = collections.length ? Math.round((readyCollections / collections.length) * 100) : 0;
  const isAdmin = !!user?.admin;
  const isLabAdmin = !isAdmin && hasRole('import-users');
  const isPathologist = !isAdmin && hasRole('pathologist');
  const isPathologistLike = isPathologist || (!isLabAdmin && hasRole('second-opinion-users'));
  const heroStats = [
    { label: isPathologistLike ? 'Cases assigned' : 'Organizations', value: isPathologistLike ? soCases.length.toLocaleString() : collections.length.toLocaleString() },
    { label: isLabAdmin || isAdmin ? 'Cases tracked' : 'Pending review', value: isLabAdmin || isAdmin ? (statsReady ? totalFolders.toLocaleString() : '...') : pendingSO.toLocaleString() },
    { label: isAdmin ? 'Images indexed' : isLabAdmin ? 'Slides indexed' : 'Organizations', value: isAdmin || isLabAdmin ? (statsReady ? totalImages.toLocaleString() : '...') : collections.length.toLocaleString() },
  ];

  const handleLogout = async () => {
    try { await fetch(`${GIRDER_BASE}/user/authentication`, { method: 'DELETE', headers: { 'Girder-Token': localStorage.getItem('girderToken') || '' } }); } catch (_) {}
    clearAuth();
    window.location.href = KEYCLOAK_LOGOUT_URL;
  };

  const goToWorklist = (col) => { setActiveCollection(col); setPage('worklist'); };

  const canImport = useStore((s) => s.hasRole('import-users'));
  const activeRole = isAdmin ? 'admin' : isLabAdmin ? 'lab-admin' : isPathologistLike ? 'pathologist' : 'default';

  const roleContent = {
    admin: {
      eyebrow: 'System Administration',
      title: 'Create organizations, manage imports, and keep collections aligned.',
      text: 'Your dashboard is optimized for tenant setup, cross-organization intake, and operational oversight.',
      primary: collections.length > 0 ? 'Import and assign slides' : 'Create first organization',
      primaryAction: collections.length > 0 ? () => setShowImport(true) : () => setShowCreateOrg(true),
      secondary: 'Open project workspace',
      secondaryAction: () => setPage('projects'),
      panelTitle: 'Administration control center',
    },
    'lab-admin': {
      eyebrow: 'Lab Operations',
      title: 'Import slide batches and route work into the right organization.',
      text: 'This view focuses on intake throughput, collection assignment, and fast access to operational actions.',
      primary: 'Start import',
      primaryAction: () => setShowImport(true),
      secondary: 'Browse all slides',
      secondaryAction: () => setPage('worklist'),
      panelTitle: 'Import and assignment queue',
    },
    pathologist: {
      eyebrow: 'Pathologist Workspace',
      title: 'Review cases in a cleaner tabular queue with status at a glance.',
      text: 'Your dashboard now prioritizes patient cases, review state, and quick handoff into second-opinion workflow.',
      primary: 'Open case queue',
      primaryAction: () => setPage('second-opinion'),
      secondary: 'Browse images',
      secondaryAction: () => setPage('worklist'),
      panelTitle: 'Case review table',
    },
    default: {
      eyebrow: 'Clinical Operations Dashboard',
      title: 'A calmer, clearer workspace for digital pathology teams.',
      text: `${APP_NAME} brings collections, cases, imaging throughput, and second-opinion workflows into one polished control surface.`,
      primary: 'Browse all images',
      primaryAction: () => setPage('worklist'),
      secondary: collections.length > 0 ? 'Open import flow' : null,
      secondaryAction: () => setShowImport(true),
      panelTitle: 'System pulse',
    },
  }[activeRole];

  const casesTableRows = useMemo(() => (
    soCases.slice(0, 8).map((folder) => {
      const meta = folder.meta?.pathassist?.secondOpinion || {};
      return {
        key: folder._id,
        caseId: meta.caseId || folder.name,
        patient: meta.patientName || meta.patient?.name || 'Unspecified patient',
        organization: folder._collection?.name || 'Unknown org',
        status: meta.status || 'Submitted',
        createdAt: meta.createdAt ? new Date(meta.createdAt).toLocaleDateString() : '—',
      };
    })
  ), [soCases]);

  const organizationRows = useMemo(() => (
    collections.map((collection) => {
      const stats = collectionStats[collection._id] || {};
      return {
        key: collection._id,
        collection,
        name: collection.name,
        folders: stats.folders ?? '—',
        items: stats.items ?? '—',
        readiness: collectionStats[collection._id] ? 'Ready' : 'Syncing',
      };
    })
  ), [collections, collectionStats]);

  const roleTable = activeRole === 'pathologist'
    ? (
      <RoleTable
        title="Cases and status"
        subtitle="Recent second-opinion work is organized in a simple tabular view for faster review."
        emptyText="No cases are available yet."
        columns={[
          { key: 'caseId', label: 'Case', render: (row) => <span className="dashboard-table-main">{row.caseId}</span> },
          { key: 'patient', label: 'Patient', render: (row) => row.patient },
          { key: 'organization', label: 'Organization', render: (row) => row.organization },
          { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
          { key: 'createdAt', label: 'Created', render: (row) => row.createdAt },
          { key: 'action', label: 'Action', render: () => <button className="dashboard-link-btn" onClick={() => setPage('second-opinion')}>Open queue</button> },
        ]}
        rows={casesTableRows}
      />
    )
    : (
      <RoleTable
        title={activeRole === 'admin' ? 'Organizations and collections' : 'Import destinations and assignment targets'}
        subtitle={activeRole === 'admin'
          ? 'Create organizations, review collection readiness, and jump into management actions.'
          : 'Import slide batches, route collections, and move into image operations quickly.'}
        emptyText="No organizations are available yet."
        columns={[
          { key: 'name', label: 'Organization', render: (row) => <span className="dashboard-table-main">{row.name}</span> },
          { key: 'folders', label: 'Cases', render: (row) => row.folders },
          { key: 'items', label: 'Images', render: (row) => row.items },
          { key: 'readiness', label: 'Readiness', render: (row) => <StatusBadge status={row.readiness} /> },
          { key: 'action', label: 'Action', render: (row) => <button className="dashboard-link-btn" onClick={() => goToWorklist(row.collection)}>Open collection</button> },
        ]}
        rows={organizationRows}
      />
    );

  const displayName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.login || 'User';

  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="dashboard-shell min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>

      {showCreateOrg && <CreateOrgModal onClose={() => setShowCreateOrg(false)} onCreated={() => qc.invalidateQueries({ queryKey: ['collections'] })} />}
      {showImport && <ImportModal collections={collections} onClose={() => setShowImport(false)} onImported={() => qc.invalidateQueries({ queryKey: ['collections'] })} />}

      <div className="dashboard-shell-bg" />

      <nav className="dashboard-topbar shrink-0 z-20">
        <div className="dashboard-topbar-inner">
          <AppLogo className="h-7 w-auto object-contain" />

          <div className="dashboard-nav">
          {[
            { id: 'dashboard',      label: 'Dashboard',      show: true,                            icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> },
            { id: 'projects',       label: 'Projects',       show: hasRole('projects-users'),        icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
            { id: 'worklist',       label: 'All Images',     show: true,                            icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
            { id: 'second-opinion', label: 'Second Opinion', show: hasRole('second-opinion-users'), icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
          ].filter(i => i.show).map(item => (
            <button key={item.id} onClick={() => setPage(item.id)}
              className={`dashboard-nav-pill ${item.id === 'dashboard' ? 'active' : ''}`}>
              {item.icon}{item.label}
            </button>
          ))}
          </div>

          <div className="flex-1" />

          <div className="dashboard-topbar-actions">
          <ThemeSwitcher />
          {user?.admin && (
            <button onClick={() => setShowCreateOrg(true)}
              className="dashboard-secondary-btn">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Org
            </button>
          )}
          {canImport && collections.length > 0 && (
            <button onClick={() => setShowImport(true)}
              className="dashboard-primary-btn">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Import Slides
            </button>
          )}
          <div className="dashboard-user-chip">
          <div className="dashboard-user-avatar">
            {initials}
          </div>
          <div className="hidden md:block min-w-0">
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
          </div>
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8">
          <section className="dashboard-hero">
            <div className="dashboard-hero-copy">
              <div className="dashboard-eyebrow">{roleContent.eyebrow}</div>
              <h1 className="dashboard-hero-title">{roleContent.title}</h1>
              <p className="dashboard-hero-text">
                {roleContent.text}
              </p>
              <div className="dashboard-hero-actions">
                <button onClick={roleContent.primaryAction} className="dashboard-primary-btn">{roleContent.primary}</button>
                {roleContent.secondary && <button onClick={roleContent.secondaryAction} className="dashboard-secondary-btn">{roleContent.secondary}</button>}
              </div>
            </div>

            <div className="dashboard-hero-panel">
              <div className="dashboard-hero-panel-top">
                <div>
                  <div className="dashboard-panel-label">{roleContent.eyebrow}</div>
                  <div className="dashboard-panel-title">{roleContent.panelTitle}</div>
                </div>
                <div className="dashboard-status-pill">
                  <span className="dashboard-status-dot" />
                  All systems operational
                </div>
              </div>

              <div className="dashboard-hero-stats">
                {heroStats.map((stat) => (
                  <div key={stat.label} className="dashboard-hero-stat">
                    <div className="dashboard-hero-stat-value">{stat.value}</div>
                    <div className="dashboard-hero-stat-label">{stat.label}</div>
                  </div>
                ))}
              </div>

              <div className="dashboard-readiness">
                <div className="dashboard-readiness-row">
                  <span className="dashboard-panel-label">Collection readiness</span>
                  <span className="dashboard-readiness-value">{utilization}%</span>
                </div>
                <div className="dashboard-progress-track">
                  <div className="dashboard-progress-bar" style={{ width: `${utilization}%` }} />
                </div>
                <p className="dashboard-readiness-text">
                  {statsReady ? 'All organization metrics are synced and ready for exploration.' : 'Metrics are still syncing in the background.'}
                </p>
              </div>
            </div>
          </section>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="dashboard-metrics-grid">
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

        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-6">
          <div className="dashboard-role-grid">
            {roleTable}
            <RoleActionCard
              eyebrow={roleContent.eyebrow}
              title={activeRole === 'admin' ? 'Organization setup and routing' : activeRole === 'lab-admin' ? 'Import slides and assign collections' : 'Clinical review shortcuts'}
              text={activeRole === 'admin'
                ? 'Create organizations, import slides, and open project management from one command center.'
                : activeRole === 'lab-admin'
                  ? 'Bring in batches from the assetstore, direct them into the right destination, and continue into operational review.'
                  : 'Jump from this dashboard into second-opinion review or image browsing without hunting through navigation.'}
              actionLabel={activeRole === 'admin' ? 'Create organization' : activeRole === 'lab-admin' ? 'Import slides' : 'Review cases'}
              onAction={activeRole === 'admin' ? () => setShowCreateOrg(true) : activeRole === 'lab-admin' ? () => setShowImport(true) : () => setPage('second-opinion')}
              secondaryLabel={activeRole === 'admin' ? 'Open projects' : 'Browse images'}
              onSecondary={activeRole === 'admin' ? () => setPage('projects') : () => setPage('worklist')}
              tone={activeRole === 'pathologist' ? 'violet' : activeRole === 'admin' ? 'amber' : 'green'}
            />
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-10 sm:pb-14">
          <div className="dashboard-section-header">
            <div>
              <div className="dashboard-eyebrow">Workspace Collections</div>
              <h2 className="dashboard-section-title">Open an organization to browse cases and slides.</h2>
            </div>
            <button onClick={() => setPage('worklist')}
              className="dashboard-link-btn">
              View all images
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>

          {isLoading ? (
            <div className="dashboard-empty-state">
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading collections…</span>
              </div>
            </div>
          ) : collections.length === 0 ? (
            <div className="dashboard-empty-state text-center">
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
            <div className="dashboard-collections-grid">
              {collections.map((col) => (
                <CollectionCard key={col._id} collection={col} stats={collectionStats[col._id]} onClick={() => goToWorklist(col)} />
              ))}
            </div>
          )}

          <div className="dashboard-footer">
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
