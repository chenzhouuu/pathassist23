// src/components/browser/BrowserTopBar.jsx
// The brand band: the logo, and the settings that belong to the application rather than to the
// level. That is the whole global chrome.
//
// The Dashboard's top bar carried a row of navigation pills, two action buttons, a theme switcher
// and a user chip. Projects and Second Opinion are role-gated pages a given user may never see,
// so they belong behind the account menu rather than occupying permanent horizontal space next
// to the thing everyone uses. Import and New folder moved into the table toolbar, where they act
// on the level you are actually looking at.
//
// WHY SEARCH IS NO LONGER HERE. It searches the level the breadcrumb names — walk into another
// folder and what it matches changes completely — so it belongs beside the breadcrumb rather than
// in a band that spans the whole application. It sat here because the band was the only full-width
// strip on the page; the frame gave the toolbar its own row and took that excuse away.
import React from 'react';
import { ChevronDown, CircleHelp, Moon, Settings, Sun } from 'lucide-react';
import { useStore } from '../../store/index.js';
import { APP_NAME, LOGO_SRC } from '../../config/branding.js';
import { KEYCLOAK_LOGOUT_URL } from '../../config/girder.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';

export default function BrowserTopBar({ user, mode = 'light', onToggleMode }) {
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

      <div className="browser-topbar-settings">
        {/* Light and dark are one surface seen two ways, so the switch is a single button rather
            than a menu of themes: there is no third choice to make room for.

            The label says what the click WILL DO rather than what is currently true, and carries
            no `aria-pressed`. A control that both renames itself and reports a pressed state
            announces the same fact twice in opposite directions — "Switch to dark theme, pressed"
            is a sentence nobody can act on. The preview toggle in the toolbar follows the same
            rule, and the view switch beside it deliberately does not, because those two buttons
            keep one name and report which is true. */}
        <button
          type="button"
          className="browser-iconbtn"
          onClick={onToggleMode}
          aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {mode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* PLACEHOLDERS. This band is where application-level settings go, and these two are where
            the rest of them will. They are rendered `disabled` rather than wired to something
            invented: there is no settings page and no help content in this application, and a
            control that looks live and does nothing on click is worse than one that says so. When
            either gets a destination, drop the `disabled` and give it a handler. */}
        <button type="button" className="browser-iconbtn" disabled title="Settings — not yet available">
          <Settings size={16} />
        </button>
        <button type="button" className="browser-iconbtn" disabled title="Help — not yet available">
          <CircleHelp size={16} />
        </button>

        <span className="browser-vsep" aria-hidden="true" />

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
      </div>
    </header>
  );
}
