// src/components/browser/BrowserToolbar.jsx
// Breadcrumb on the left, actions on the right. Everything here is contextual to the level the
// table is showing — the status filter only appears where there are slides to filter, and "New"
// creates whatever the current level holds.
import React from 'react';
import {
  ChevronDown, ChevronRight, FolderPlus, LayoutGrid, PanelRightClose, PanelRightOpen, Rows3,
  Search, SlidersHorizontal, Upload,
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
  crumbs, onCrumb, search, onSearch, showStatusFilter, status, onStatus, columns,
  columnVisibility = {}, inCollection, onNew, onImport, view, onView, previewOpen, onTogglePreview,
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

      {/* Every button in this bar carries `browser-quiet`, which is where its colour comes from.
          The vendored ghost variant is `text-primary`, and under Graphite `--primary` is the brand
          indigo — three indigo buttons in a row on a near-white page are the loudest thing on it.
          On the Viewer's black ground that same variant was the quiet option, so the mapping is
          not wrong; what is wrong is asking one variant to be quiet against two grounds. The class
          is the page's own answer, in _toolbar.css, rather than an edit to the vendored button. */}
      <div className="browser-toolbar-actions">
        {/* It searches the level the breadcrumb names, which is the whole reason it is here and no
            longer in the brand band: walk into another folder and what it matches changes
            completely, so it belongs to the row that says where you are.

            The state and the 300ms debounce did not move with it — `useBrowseNavigation` still owns
            `search` and `debouncedSearch`, and this is a field in a different place, not a
            different behaviour. */}
        <label className="browser-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search this level…"
            aria-label="Search this level"
          />
        </label>

        <ViewSwitch view={view} onView={onView} />

        {/* The name says what the click will do rather than what is currently true, and there is no
            `aria-pressed` beside it: a toggle that both renames itself and reports a pressed state
            announces the same fact twice and in opposite directions — "Hide preview, pressed" is a
            sentence nobody can act on. The icon carries the same asymmetry, closing or opening. */}
        <Button
          variant="ghost"
          size="sm"
          className="browser-quiet"
          aria-label={previewOpen ? 'Hide preview' : 'Show preview'}
          title={previewOpen ? 'Hide preview' : 'Show preview'}
          onClick={onTogglePreview}
        >
          {previewOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </Button>

        {/* Still a native `<select>`, so the open menu is the platform's and the keyboard behaviour
            is the one every user already has. What changes is the closed control: `appearance: none`
            takes away the system border and the system arrow, and the page draws its own chevron
            over the field, so the one control in this row wearing platform chrome stops being the
            odd one out. The wrapper exists only to give the chevron something to be positioned
            against, and it is `aria-hidden` because the select already announces itself. */}
        {showStatusFilter && (
          <span className="browser-selwrap">
            <select
              className="browser-select"
              value={status}
              onChange={(e) => onStatus(e.target.value)}
              aria-label="Filter by status"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s === 'All' ? 'All statuses' : s}</option>)}
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </span>
        )}

        {/* A card has no columns, so in the grid this menu is a control that does nothing. It is
            hidden rather than disabled for the same reason the status filter is absent on a level
            with no slides — and the table's own visibility state is untouched, so a user's choice
            is still there when they switch back. */}
        {view === 'table' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="browser-quiet" aria-label="Columns">
                <SlidersHorizontal size={14} /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Checked from the user's own visibility map rather than from the column's current
                  state, because those two are deliberately not the same thing. BrowserPage also
                  drops columns for reasons that are nobody's choice — a level with no slides in
                  it, a table too narrow for seven columns — and a menu that read the result back
                  would show Updated unchecked at 1280px and then do nothing when it was clicked,
                  since the user's map already says it is wanted. This list is the request; the
                  table is the request as far as the page could honour it. */}
              {columns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={columnVisibility[c.id] !== false}
                  onCheckedChange={(v) => c.toggleVisibility(!!v)}
                >
                  {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button variant="ghost" size="sm" className="browser-quiet" onClick={onNew}>
          <FolderPlus size={14} /> New {inCollection ? 'folder' : 'collection'}
        </Button>
        <Button variant="ghost" size="sm" className="browser-quiet" onClick={onImport}>
          <Upload size={14} /> Import
        </Button>
      </div>
    </div>
  );
}
