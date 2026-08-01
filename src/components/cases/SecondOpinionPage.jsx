// src/components/cases/SecondOpinionPage.jsx
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../../store/index.js';
import { getSOCases, getItems, updateFolderMetadata } from '../../api/index.js';
import { KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import AppLogo from '../layout/AppLogo.jsx';
import CaseCreateModal from './CaseCreateModal.jsx';

const STATUS_CONFIG = {
  'Submitted':  { color: '#4da6ff', bg: 'rgba(77,166,255,0.12)',  border: 'rgba(77,166,255,0.25)' },
  'In Review':  { color: '#f5a623', bg: 'rgba(245,166,35,0.12)',  border: 'rgba(245,166,35,0.25)' },
  'Completed':  { color: '#4caf82', bg: 'rgba(76,175,130,0.12)',  border: 'rgba(76,175,130,0.25)' },
  'STAT':       { color: '#e94560', bg: 'rgba(233,69,96,0.12)',   border: 'rgba(233,69,96,0.25)' },
  'Cancelled':  { color: '#6b7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.25)' },
};

const URGENCY_CONFIG = {
  'Routine': { color: '#6b7280', bg: 'rgba(107,114,128,0.1)',  border: 'rgba(107,114,128,0.2)' },
  'Urgent':  { color: '#f5a623', bg: 'rgba(245,166,35,0.1)',  border: 'rgba(245,166,35,0.2)' },
  'STAT':    { color: '#e94560', bg: 'rgba(233,69,96,0.1)',   border: 'rgba(233,69,96,0.2)' },
};

const FILTER_TABS = ['All', 'Submitted', 'In Review', 'Completed', 'STAT'];
const STATUS_CHOICES = ['Submitted', 'In Review', 'Completed', 'STAT', 'Cancelled'];


function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG['Submitted'];
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium whitespace-nowrap"
      style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}` }}>
      {status}
    </span>
  );
}

function UrgencyBadge({ urgency }) {
  if (!urgency) return null;
  const cfg = URGENCY_CONFIG[urgency] || URGENCY_CONFIG['Routine'];
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium whitespace-nowrap"
      style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}` }}>
      {urgency}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function SkeletonRow() {
  return (
    <tr>
      {[120, 90, 40, 110, 80, 90, 100, 80].map((w, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 rounded animate-pulse" style={{ width: w, background: 'var(--border-hex)' }} />
        </td>
      ))}
    </tr>
  );
}

export default function SecondOpinionPage() {
  const { setPage, openCaseItem, currentPage, user, clearAuth, hasRole } = useStore();

  const NAV_ITEMS = [
    { id: 'browse',         label: 'Browse',         show: true,                            icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
    { id: 'projects',       label: 'Projects',       show: hasRole('projects-users'),       icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
    { id: 'second-opinion', label: 'Second Opinion', show: hasRole('second-opinion-users'), icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
  ].filter(item => item.show);
  const qc = useQueryClient();
  const [filterTab, setFilterTab] = useState('All');
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [openingId, setOpeningId] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [statusMenuId, setStatusMenuId] = useState(null);

  // Referring physicians only see cases they submitted; all other roles see the full list.
  const isReferring = hasRole('referring-portal-users');
  const { data: cases = [], isLoading } = useQuery({
    queryKey: ['so-cases', isReferring ? user?._id : 'all'],
    queryFn: () => getSOCases({ submittedByUserId: isReferring ? user?._id : null }),
    staleTime: 30_000,
  });

  const filtered = filterTab === 'All'
    ? cases
    : cases.filter((f) => f.meta?.pathassist?.secondOpinion?.status === filterTab);

  const handleOpen = async (folder) => {
    const so = folder.meta?.pathassist?.secondOpinion;
    const imageItemIds = so?.source?.imageItemIds || [];
    setOpeningId(folder._id);
    try {
      let caseItems = [];
      if (imageItemIds.length > 0) {
        // Fetch folder items and filter to only the ones selected for this case
        const allItems = await getItems(so.source.folderId, 0, 500);
        const idSet = new Set(imageItemIds);
        caseItems = allItems.filter((i) => idSet.has(i._id));
        // Preserve original selection order
        caseItems.sort((a, b) => imageItemIds.indexOf(a._id) - imageItemIds.indexOf(b._id));
      } else {
        // Fallback: all non-PDF items in the folder
        const allItems = await getItems(folder._id, 0, 500);
        caseItems = allItems.filter((i) => !(i.name || '').toLowerCase().endsWith('.pdf'));
      }

      if (caseItems.length === 0) return;

      const ctx = {
        caseId: so?.caseId || folder._id,
        folderId: so?.source?.folderId || folder._id,
        items: caseItems,
      };
      openCaseItem(caseItems[0], ctx);
    } finally {
      setOpeningId(null);
    }
  };

  const handleStatusChange = async (folder, newStatus) => {
    setStatusMenuId(null);
    setUpdatingId(folder._id);
    try {
      const existing = folder.meta?.pathassist || {};
      const so = existing.secondOpinion || {};
      await updateFolderMetadata(folder._id, {
        pathassist: {
          ...existing,
          secondOpinion: { ...so, status: newStatus, updatedAt: new Date().toISOString() },
        },
      });
      qc.invalidateQueries({ queryKey: ['so-cases'] });
    } finally { setUpdatingId(null); }
  };

  const displayName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.login || 'Pathologist';

  const handleLogout = async () => {
    try {
      await fetch(`${window.location.origin}/api/v1/user/authentication`, {
        method: 'DELETE',
        headers: { 'Girder-Token': localStorage.getItem('girderToken') || '' },
      });
    } catch (_) {}
    clearAuth();
    window.location.href = KEYCLOAK_LOGOUT_URL;
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      {/* Nav bar */}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20"
        style={{ background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border-hex)', backdropFilter: 'blur(12px)' }}>
        <AppLogo />
        <div className="flex-1" />
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const active = item.id === currentPage;
            return (
              <button key={item.id} onClick={() => setPage(item.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                style={{
                  background: active ? 'var(--highlight-hex)' : 'transparent',
                  color: active ? 'var(--accent-hex)' : 'var(--muted-hex)',
                  border: active ? '1px solid var(--border-hex)' : '1px solid transparent',
                }}>
                {item.icon}{item.label}
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-2 pl-3" style={{ borderLeft: '1px solid var(--border-hex)' }}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'linear-gradient(135deg,#4da6ff22,#7c3aed22)', border: '1px solid rgba(77,166,255,0.3)', color: '#4da6ff' }}>
            {displayName[0]?.toUpperCase()}
          </div>
          <span className="text-xs hidden md:block" style={{ color: 'var(--muted-hex)' }}>{displayName}</span>
          <button onClick={handleLogout} className="btn-icon ml-1" title="Sign out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">

          {/* Page header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>Second Opinion Cases</h1>
              <p className="text-xs mt-1" style={{ color: 'var(--muted-hex)' }}>
                {isLoading ? 'Loading cases...' : `${cases.length} case${cases.length !== 1 ? 's' : ''} total`}
              </p>
            </div>
            <button
              onClick={() => setShowCreateCase(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all"
              style={{ background: '#4da6ff', color: '#fff' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#3a96ef'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#4da6ff'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              New Case
            </button>
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1 mb-4">
            {FILTER_TABS.map((tab) => {
              const active = tab === filterTab;
              const count = tab === 'All' ? cases.length : cases.filter((f) => f.meta?.pathassist?.secondOpinion?.status === tab).length;
              return (
                <button key={tab} onClick={() => setFilterTab(tab)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: active ? 'var(--highlight-hex)' : 'transparent',
                    color: active ? 'var(--accent-hex)' : 'var(--muted-hex)',
                    border: active ? '1px solid var(--border-hex)' : '1px solid transparent',
                  }}>
                  {tab}
                  <span className="px-1.5 py-0.5 rounded text-xs font-mono"
                    style={{ background: 'var(--bg)', color: 'var(--muted-hex)', fontSize: 10 }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Table */}
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-hex)', background: 'var(--bg-panel)' }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-hex)', background: 'var(--bg)' }}>
                  {['Case ID', 'Patient', 'Age / Sex', 'Site', 'Urgency', 'Status', 'Created', 'Action'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left font-semibold"
                      style={{ color: 'var(--muted-hex)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading && [0, 1, 2, 3].map((i) => <SkeletonRow key={i} />)}

                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center" style={{ color: 'var(--muted-hex)' }}>
                      <div className="flex flex-col items-center gap-3">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}>
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                          <circle cx="9" cy="7" r="4"/>
                          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                        </svg>
                        <div>
                          <p className="font-medium mb-1" style={{ color: 'var(--text)' }}>No cases found</p>
                          <p className="text-xs" style={{ color: 'var(--muted-hex)' }}>
                            {filterTab !== 'All' ? `No cases with status "${filterTab}"` : 'Create your first second opinion case to get started.'}
                          </p>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}

                {!isLoading && filtered.map((folder) => {
                  const so = folder.meta?.pathassist?.secondOpinion || {};
                  const patient = so.patient || {};
                  const clinical = so.clinical || {};
                  return (
                    <tr key={folder._id}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid var(--border-hex)' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--highlight-hex)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold" style={{ color: 'var(--accent-hex)', fontSize: 11 }}>
                          {so.caseId || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text)' }}>
                        <div>{patient.patientId || '—'}</div>
                        {patient.referringInstitution && (
                          <div style={{ color: 'var(--muted-hex)', fontSize: 10 }}>{patient.referringInstitution}</div>
                        )}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--muted-hex)' }}>
                        {patient.age ? `${patient.age}y` : '—'}{patient.age && patient.sex ? ' / ' : ''}{patient.sex || ''}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text)' }}>
                        <div>{clinical.anatomicalSite || '—'}</div>
                        {clinical.cancerType && (
                          <div style={{ color: 'var(--muted-hex)', fontSize: 10 }}>{clinical.cancerType}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <UrgencyBadge urgency={clinical.urgency} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="relative flex items-center gap-1">
                          <StatusBadge status={so.status || 'Submitted'} />
                          <button
                            onClick={() => setStatusMenuId(statusMenuId === folder._id ? null : folder._id)}
                            disabled={updatingId === folder._id}
                            className="p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
                            style={{ color: 'var(--muted-hex)' }}
                            title="Change status"
                          >
                            {updatingId === folder._id
                              ? <div className="w-3 h-3 border-2 border-gray-500/30 border-t-gray-400 rounded-full animate-spin" />
                              : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
                            }
                          </button>
                          {statusMenuId === folder._id && (
                            <div className="absolute top-full left-0 mt-1 z-30 rounded-lg overflow-hidden shadow-xl"
                              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-hex)', minWidth: 120 }}>
                              {STATUS_CHOICES.map((s) => (
                                <button key={s} onClick={() => handleStatusChange(folder, s)}
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
                                  style={{ color: s === so.status ? 'var(--accent-hex)' : 'var(--text)' }}>
                                  {s}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--muted-hex)' }}>
                        {formatDate(so.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleOpen(folder)}
                          disabled={openingId === folder._id}
                          className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-all"
                          style={{ background: 'rgba(77,166,255,0.12)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.25)' }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(77,166,255,0.2)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(77,166,255,0.12)'}
                        >
                          {openingId === folder._id
                            ? <div className="w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
                            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          }
                          {openingId === folder._id ? 'Opening...' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Close status menus on outside click */}
      {statusMenuId && (
        <div className="fixed inset-0 z-20" onClick={() => setStatusMenuId(null)} />
      )}

      {showCreateCase && (
        <CaseCreateModal
          onClose={() => setShowCreateCase(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['so-cases'] });
            setShowCreateCase(false);
          }}
        />
      )}
    </div>
  );
}
