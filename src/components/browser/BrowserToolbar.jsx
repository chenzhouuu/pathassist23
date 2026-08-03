// src/components/browser/BrowserToolbar.jsx
// Breadcrumb on the left, actions on the right. Everything here is contextual to the level the
// table is showing — the status filter only appears where there are slides to filter, and "New"
// creates whatever the current level holds.
import React from 'react';
import {
  ChevronRight, FolderPlus, LayoutGrid, PanelRightClose, PanelRightOpen, Rows3,
  SlidersHorizontal, Upload,
} from 'lucide-react';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { STATUSES } from './browseUtils.js';

// The view switch. Two toggle buttons in a labelled group rather than a tablist: a tab implies a
// panel it labels and controls, and these two do not label the level below them — the level is the
// same rows either way, which is the entire claim the control is making. `aria-pressed` says what
// is true of each button, and both stay in the tab order, so there is no roving focus to get wrong.
function ViewSwitch({ view, onView }) {
  return (
    <div className="browser-viewseg" role="group" aria-label="View">
      <button
        type="button"
        aria-pressed={view === 'table'}
        aria-label="Table view"
        title="Table view"
        onClick={() => onView('table')}
      >
        <Rows3 size={15} />
      </button>
      <button
        type="button"
        aria-pressed={view === 'grid'}
        aria-label="Grid view"
        title="Grid view"
        onClick={() => onView('grid')}
      >
        <LayoutGrid size={15} />
      </button>
    </div>
  );
}

export default function BrowserToolbar({
  crumbs, onCrumb, showStatusFilter, status, onStatus, columns, inCollection, onNew, onImport,
  view, onView, previewOpen, onTogglePreview,
}) {
  return (
    <div className="browser-toolbar">
      <nav className="browser-crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.kind}-${c._id ?? 'root'}`}>
            {i > 0 && <ChevronRight size={13} className="browser-crumb-sep" />}
            <button
              type="button"
              className={`browser-crumb ${i === crumbs.length - 1 ? 'is-current' : ''}`}
              onClick={() => onCrumb(i)}
              aria-current={i === crumbs.length - 1 ? 'page' : undefined}
            >
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </nav>

      <div className="browser-toolbar-actions">
        <ViewSwitch view={view} onView={onView} />

        {/* The name says what the click will do rather than what is currently true, and there is no
            `aria-pressed` beside it: a toggle that both renames itself and reports a pressed state
            announces the same fact twice and in opposite directions — "Hide preview, pressed" is a
            sentence nobody can act on. The icon carries the same asymmetry, closing or opening. */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={previewOpen ? 'Hide preview' : 'Show preview'}
          title={previewOpen ? 'Hide preview' : 'Show preview'}
          onClick={onTogglePreview}
        >
          {previewOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </Button>

        {showStatusFilter && (
          <select
            className="browser-select"
            value={status}
            onChange={(e) => onStatus(e.target.value)}
            aria-label="Filter by status"
          >
            {STATUSES.map((s) => <option key={s} value={s}>{s === 'All' ? 'All statuses' : s}</option>)}
          </select>
        )}

        {/* A card has no columns, so in the grid this menu is a control that does nothing. It is
            hidden rather than disabled for the same reason the status filter is absent on a level
            with no slides — and the table's own visibility state is untouched, so a user's choice
            is still there when they switch back. */}
        {view === 'table' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Columns">
                <SlidersHorizontal size={14} /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {columns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={c.getIsVisible()}
                  onCheckedChange={(v) => c.toggleVisibility(!!v)}
                >
                  {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button variant="ghost" size="sm" onClick={onNew}>
          <FolderPlus size={14} /> New {inCollection ? 'folder' : 'collection'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onImport}>
          <Upload size={14} /> Import
        </Button>
      </div>
    </div>
  );
}
