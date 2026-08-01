// src/components/browser/BrowserTopBar.jsx
// Logo, search, user menu. That is the whole global chrome.
//
// The Dashboard's top bar carried a row of navigation pills, two action buttons, a theme switcher
// and a user chip. Projects and Second Opinion are role-gated pages a given user may never see,
// so they belong behind the account menu rather than occupying permanent horizontal space next
// to the thing everyone uses. Import and New folder moved into the table toolbar, where they act
// on the level you are actually looking at.
import React from 'react';
import { Search, ChevronDown } from 'lucide-react';
import { useStore } from '../../store/index.js';
import { APP_NAME, LOGO_SRC } from '../../config/branding.js';
import { KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';

export default function BrowserTopBar({ search, onSearch, user }) {
  const { setPage, clearAuth, hasRole } = useStore();

  const pages = [
    { id: 'projects', label: 'Projects', show: hasRole('projects-users') },
    { id: 'second-opinion', label: 'Second Opinion', show: hasRole('second-opinion-users') },
  ].filter((p) => p.show);

  const initial = (user?.firstName || user?.login || '?').charAt(0).toUpperCase();

  const logout = () => {
    clearAuth();
    if (KEYCLOAK_LOGOUT_URL) window.location.href = KEYCLOAK_LOGOUT_URL;
  };

  return (
    <header className="browser-topbar">
      <div className="browser-brand">
        <img src={LOGO_SRC} alt="" className="browser-logo" />
        <span className="browser-brand-name">{APP_NAME}</span>
      </div>

      <label className="browser-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search this level…"
          aria-label="Search"
        />
      </label>

      <DropdownMenu>
        <DropdownMenuTrigger className="browser-user">
          <span className="browser-avatar">{initial}</span>
          <span className="browser-user-name">{user?.firstName || user?.login || 'User'}</span>
          <ChevronDown size={13} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{user?.email || user?.login}</DropdownMenuLabel>
          {pages.length > 0 && <DropdownMenuSeparator />}
          {pages.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => setPage(p.id)}>{p.label}</DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={logout}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
