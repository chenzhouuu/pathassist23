// src/components/dashboard/Dashboard.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery } from '@tanstack/react-query';
import { getCollections, getFolders, getCollectionStats } from '../../api/index.js';
import { logout } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';

// ── Donut chart (pure SVG) ────────────────────────────────────────────────────
function DonutChart({ segments, size = 120, thickness = 22, label, sublabel }) {
  const r = (size / 2) - thickness;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  let offset = 0;
  const arcs = segments.map((seg) => {
    const pct = seg.value / total;
    const dash = pct * circ;
    const arc = { ...seg, dash, gap: circ - dash, offset: circ - offset };
    offset += dash;
    return arc;
  });
  return (
    <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={thickness}/>
      {arcs.map((arc, i) => (
        <circle key={i} cx={size/2} cy={size/2} r={r} fill="none"
          stroke={arc.color} strokeWidth={thickness}
          strokeDasharray={`${arc.dash} ${arc.gap}`}
          strokeDashoffset={arc.offset} strokeLinecap="butt"/>
      ))}
      <text x={size/2} y={size/2 - 4} textAnchor="middle" dominantBaseline="middle"
        style={{ fill:'#e8eaf6', fontSize:22, fontWeight:700, transform:'rotate(90deg)', transformOrigin:`${size/2}px ${size/2}px`, fontFamily:'IBM Plex Mono' }}>
        {label}
      </text>
      {sublabel && (
        <text x={size/2} y={size/2 + 16} textAnchor="middle" dominantBaseline="middle"
          style={{ fill:'#6b7280', fontSize:9, transform:'rotate(90deg)', transformOrigin:`${size/2}px ${size/2}px`, fontFamily:'IBM Plex Sans' }}>
          {sublabel}
        </text>
      )}
    </svg>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color = '#4da6ff', onClick }) {
  return (
    <div onClick={onClick}
      className="flex flex-col gap-2 p-5 rounded-xl transition-all duration-200"
      style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', cursor: onClick ? 'pointer' : 'default' }}
      onMouseEnter={e => { if(onClick) e.currentTarget.style.borderColor = color + '55'; }}
      onMouseLeave={e => { if(onClick) e.currentTarget.style.borderColor = 'var(--border)'; }}>
      <div className="flex items-center justify-between">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: color + '22' }}>
          {icon}
        </div>
        {onClick && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2">
            <path d="M5 12h14M12 5l7 7-7 7"/>
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

// ── Collection card ────────────────────────────────────────────────────────────
function CollectionCard({ collection, stats, onClick }) {
  const token = localStorage.getItem('girderToken') || '';
  const colors = ['#4da6ff','#4caf82','#f5a623','#c27aff','#e94560','#00bcd4','#ff9800'];
  const color = colors[Math.abs(collection._id.charCodeAt(0) + collection._id.charCodeAt(1)) % colors.length];

  return (
    <div onClick={onClick}
      className="group relative flex flex-col gap-3 p-4 rounded-xl cursor-pointer transition-all duration-200"
      style={{ background:'var(--bg-panel)', border:'1px solid var(--border)' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color + '44'; e.currentTarget.style.background = 'var(--highlight)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-panel)'; }}>

      {/* Color bar */}
      <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl opacity-60"
        style={{ background: `linear-gradient(90deg, ${color}, transparent)` }}/>

      <div className="flex items-start justify-between gap-2">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: color + '1a', border: `1px solid ${color}33` }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill={color+'44'} stroke={color} strokeWidth="1.8">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>
          </svg>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="2"
          className="group-hover:stroke-gray-400 transition-colors mt-1">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </div>

      <div>
        <div className="text-sm font-semibold leading-tight truncate" style={{ color: 'var(--text)' }}>{collection.name}</div>
        {collection.description && (
          <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--muted)' }}>{collection.description}</div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-auto pt-2" style={{ borderTop:'1px solid var(--border)' }}>
        <div className="text-center">
          <div className="text-xs font-mono font-bold" style={{ color }}>{stats?.folders ?? '…'}</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Cases</div>
        </div>
        <div className="w-px h-6" style={{ background:'var(--border)' }}/>
        <div className="text-center">
          <div className="text-xs font-mono font-bold" style={{ color }}>{stats?.items ?? '…'}</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Images</div>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, clearAuth, setPage, setActiveCollection, setActiveItem } = useStore();
  const [collectionStats, setCollectionStats] = useState({});
  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
  }, []);

  const { data: collections = [], isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: async () => {
      const res = await fetch(`${GIRDER_BASE}/collection?limit=200&sort=name`, {
        headers: { 'Girder-Token': localStorage.getItem('girderToken') || '' }
      });
      return res.json();
    },
    staleTime: 60_000,
  });

  // Load stats for each collection
  useEffect(() => {
    collections.forEach(async (col) => {
      if (collectionStats[col._id]) return;
      const stats = await getCollectionStats(col._id);
      setCollectionStats(prev => ({ ...prev, [col._id]: stats }));
    });
  }, [collections]);

  const totalImages = useMemo(() =>
    Object.values(collectionStats).reduce((s, x) => s + (x?.items || 0), 0),
    [collectionStats]
  );
  const totalFolders = useMemo(() =>
    Object.values(collectionStats).reduce((s, x) => s + (x?.folders || 0), 0),
    [collectionStats]
  );

  // Donut segments for collections
  const colColors = ['#4da6ff','#4caf82','#f5a623','#c27aff','#e94560','#00bcd4','#ff9800'];
  const donutSegs = collections.slice(0, 7).map((c, i) => ({
    value: collectionStats[c._id]?.items || 1,
    color: colColors[i % colColors.length],
    label: c.name,
  }));

  const handleLogout = async () => {
    try { await fetch(`${GIRDER_BASE}/user/authentication`, { method:'DELETE', headers:{ 'Girder-Token': localStorage.getItem('girderToken')||'' }}); } catch(_){}
    clearAuth();
  };

  const goToWorklist = (col) => {
    setActiveCollection(col);
    setPage('worklist');
  };

  const displayName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.login || 'Pathologist';

  return (
    <div className="min-h-screen flex flex-col" style={{ background:'var(--bg)', fontFamily:"'IBM Plex Sans', system-ui, sans-serif" }}>

      {/* ── Top nav ── */}
      <nav className="flex items-center gap-4 px-6 h-14 shrink-0 z-20"
        style={{ background:'var(--bg-toolbar)', borderBottom:'1px solid var(--border)', backdropFilter:'blur(12px)' }}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background:'rgba(77,166,255,0.15)', border:'1px solid rgba(77,166,255,0.25)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight" style={{ color: 'var(--text)' }}>PathAssist</span>
            <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}>IMPART</span>
          </div>
        </div>

        <div className="flex-1"/>

        <nav className="flex items-center gap-1">
          {[
            { id:'dashboard', label:'Dashboard', icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> },
            { id:'worklist', label:'All Images', icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
          ].map(item => (
            <button key={item.id} onClick={() => setPage(item.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{ background: item.id==='dashboard' ? 'var(--highlight)' : 'transparent',
                color: item.id==='dashboard' ? 'var(--accent)' : 'var(--muted)',
                border: item.id==='dashboard' ? '1px solid var(--border)' : '1px solid transparent' }}>
              {item.icon}{item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 pl-3" style={{ borderLeft:'1px solid var(--border)' }}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background:'linear-gradient(135deg, #4da6ff22, #7c3aed22)', border:'1px solid rgba(77,166,255,0.3)', color:'#4da6ff' }}>
            {displayName[0]?.toUpperCase()}
          </div>
          <span className="text-xs hidden md:block" style={{ color: 'var(--muted)' }}>{displayName}</span>
          <button onClick={handleLogout} className="btn-icon ml-1" title="Sign out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">

          {/* ── Welcome header ── */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>
              {greeting}, <span style={{ color:'var(--accent)' }}>{user?.firstName || user?.login}</span>
            </h1>
            <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
              {isLoading ? 'Loading your workspace…' : `${collections.length} collection${collections.length !== 1 ? 's' : ''} · ${totalImages.toLocaleString()} images across ${totalFolders} cases`}
            </p>
          </div>

          {/* ── Collections grid — first section ── */}
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight" style={{ color: 'var(--text)' }}>
              Your Collections
              <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>({collections.length})</span>
            </h2>
            <button onClick={() => setPage('worklist')}
              className="text-xs flex items-center gap-1 transition-colors"
              style={{ color:'var(--accent)' }}>
              View all images
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16 mb-8">
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" style={{ width:28, height:28, borderWidth:3 }}/>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading collections…</span>
              </div>
            </div>
          ) : collections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center mb-8">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" className="mb-3" style={{ stroke: 'var(--border)' }}>
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>
              </svg>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>No collections found</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Collections will appear here once created in Girder</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
              {collections.map((col) => (
                <CollectionCard key={col._id} collection={col}
                  stats={collectionStats[col._id]}
                  onClick={() => goToWorklist(col)}/>
              ))}
            </div>
          )}

          {/* ── Stat cards row ── */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <StatCard
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/></svg>}
              label="Collections" value={isLoading ? '…' : collections.length} color="#4da6ff"
              onClick={() => setPage('worklist')}
            />
            <StatCard
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="3"/></svg>}
              label="Total Images" value={totalImages > 0 ? totalImages.toLocaleString() : '…'} color="#4caf82"
              onClick={() => setPage('worklist')}
            />
            <StatCard
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>}
              label="Cases" value={totalFolders > 0 ? totalFolders.toLocaleString() : '…'} color="#f5a623"
            />
          </div>

          {/* ── Overview: donut + quick action ── */}
          {collections.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">

              {/* Donut chart card */}
              <div className="rounded-2xl p-6 flex flex-col gap-4"
                style={{ background:'var(--bg-panel)', border:'1px solid var(--border)' }}>
                <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Image Distribution</div>
                <div className="flex items-center gap-6">
                  <DonutChart segments={donutSegs} label={totalImages > 0 ? totalImages : '…'} sublabel="Total" size={130} thickness={20}/>
                  <div className="flex flex-col gap-2 flex-1 min-w-0">
                    {collections.slice(0, 7).map((col, i) => (
                      <div key={col._id} className="flex items-center gap-2 cursor-pointer group" onClick={() => goToWorklist(col)}>
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colColors[i % colColors.length] }}/>
                        <span className="text-xs truncate flex-1" style={{ color: 'var(--muted)' }}>{col.name}</span>
                        <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{collectionStats[col._id]?.items ?? '…'}</span>
                      </div>
                    ))}
                    {collections.length > 7 && (
                      <div className="text-xs text-gray-700">+{collections.length - 7} more</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Quick action: browse all images */}
              <div className="lg:col-span-2">
                <div onClick={() => setPage('worklist')}
                  className="rounded-2xl p-5 cursor-pointer flex flex-col justify-between group transition-all h-full"
                  style={{ background:'var(--bg-panel)', border:'1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor='var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor='var(--border)'}>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                    style={{ background:'var(--highlight)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/>
                      <rect x="3" y="12" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="5" rx="1"/>
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Browse All Images</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                      {totalImages > 0 ? `${totalImages.toLocaleString()} images across ${collections.length} collections` : 'Search, filter & open slides from all collections'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-xs mt-3" style={{ color:'var(--accent)' }}>
                    Open worklist
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="mt-12 pt-6 text-center text-xs font-mono"
            style={{ borderTop:'1px solid var(--border)', color: 'var(--muted)' }}>
            PathAssist · IMPART · lymphoma.dev.pathassist.health
          </div>
        </div>
      </div>
    </div>
  );
}
