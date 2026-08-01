// src/components/browser/BrowserToolbar.jsx
// Breadcrumb on the left, actions on the right. Everything here is contextual to the level the
// table is showing — the status filter only appears where there are slides to filter, and "New"
// creates whatever the current level holds.
import React from 'react';
import { ChevronRight, Upload, FolderPlus, SlidersHorizontal } from 'lucide-react';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { STATUSES } from './browseUtils.js';

export default function BrowserToolbar({
  crumbs, onCrumb, showStatusFilter, status, onStatus, columns, inCollection, onNew, onImport,
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
