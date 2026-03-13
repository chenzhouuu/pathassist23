// src/components/layout/Header.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import { logout } from '../../api/index.js';
import ThemeSwitcher from '../ThemeSwitcher.jsx';
import AppLogo from './AppLogo.jsx';
import { APP_NAME } from '../../config/branding.js';
import { KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';

export default function Header({ showBack = false }) {
  const { user, clearAuth, breadcrumb, tilesInfo, toggleLeftPanel, toggleRightPanel, setPage } = useStore();

  const handleLogout = async () => {
    try { await logout(); } catch (_) {}
    clearAuth();
    // End the Keycloak session so SSO doesn't auto-login on next visit
    window.location.href = KEYCLOAK_LOGOUT_URL;
  };

  return (
    <header className="app-header">

      <div className="app-brand" onClick={() => setPage('dashboard')}>
        <div className="app-brand-mark">
          <AppLogo className="h-7 md:h-8 w-auto object-contain" />
        </div>
        <div className="app-brand-copy">
          <span className="app-brand-name">{APP_NAME}</span>
          <span className="app-brand-meta">Slide review workspace</span>
        </div>
      </div>

      {showBack && (
        <>
          <button className="btn-icon ml-1" onClick={toggleLeftPanel} title="Toggle sidebar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>
            </svg>
          </button>
          <button onClick={() => setPage('worklist')}
            className="app-nav-chip">
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

      <div className="app-header-actions">
        {showBack && (
          <button className="btn-icon" onClick={toggleRightPanel} title="Toggle right panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>
            </svg>
          </button>
        )}
        <ThemeSwitcher />
        <div className="app-header-divider" />
        <div className="app-user-chip">
          <div className="app-user-avatar">
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
