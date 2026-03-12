// src/components/layout/Header.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import { logout } from '../../api/index.js';
import ThemeSwitcher from '../ThemeSwitcher.jsx';
import AppLogo from './AppLogo.jsx';

export default function Header({ showBack = false }) {
  const { user, clearAuth, breadcrumb, tilesInfo, toggleLeftPanel, toggleRightPanel, setPage } = useStore();

  const handleLogout = async () => {
    try { await logout(); } catch (_) {}
    clearAuth();
  };

  return (
    <header className="flex items-center gap-3 px-3 shrink-0 z-20"
      style={{ height:'var(--header-h)', background:'var(--bg-toolbar)', borderBottom:'1px solid var(--border)' }}>

      {/* Logo */}
      <div className="flex items-center shrink-0 cursor-pointer" onClick={() => setPage('dashboard')}>
        <AppLogo className="h-7 md:h-8 w-auto object-contain" />
      </div>

      {showBack && (
        <>
          <button className="btn-icon ml-1" onClick={toggleLeftPanel} title="Toggle sidebar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>
            </svg>
          </button>
          {/* Back to worklist */}
          <button onClick={() => setPage('worklist')}
            className="flex items-center gap-1.5 text-xs px-2 py-1 rounded hover:bg-black/5 transition-colors"
            style={{ color: 'var(--muted)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Worklist
          </button>
        </>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 flex-1 overflow-hidden text-xs">
        {breadcrumb.map((crumb, i) => (
          <React.Fragment key={crumb._id}>
            {i > 0 && <span style={{ color: 'var(--muted)' }}>/</span>}
            <span className={`px-1.5 py-0.5 rounded truncate max-w-[140px] ${i === breadcrumb.length - 1 ? 'font-medium' : ''}`}
              style={{ color: i === breadcrumb.length - 1 ? 'var(--text)' : 'var(--muted)' }}>
              {crumb.name}
            </span>
          </React.Fragment>
        ))}
      </div>

      {tilesInfo && (
        <div className="flex items-center gap-2 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
          <span className="tag">{tilesInfo.magnification || '—'}×</span>
          <span className="font-mono hidden md:block" style={{ color: 'var(--muted)' }}>
            {tilesInfo.sizeX?.toLocaleString()} × {tilesInfo.sizeY?.toLocaleString()} px
          </span>
        </div>
      )}

      <div className="flex items-center gap-1 shrink-0 ml-2">
        {showBack && (
          <button className="btn-icon" onClick={toggleRightPanel} title="Toggle right panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>
            </svg>
          </button>
        )}
        <ThemeSwitcher />
        <div className="w-px h-5 mx-1" style={{ background:'var(--border)' }}/>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ background:'rgba(77,166,255,0.2)', color:'#4da6ff' }}>
            {user?.firstName?.[0] || user?.login?.[0]?.toUpperCase() || '?'}
          </div>
          <span className="text-xs hidden sm:block" style={{ color: 'var(--muted)' }}>{user?.login || user?.firstName}</span>
          <button className="btn-icon" onClick={handleLogout} title="Sign out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
