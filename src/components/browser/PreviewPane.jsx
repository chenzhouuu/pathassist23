// src/components/browser/PreviewPane.jsx
// The right-hand pane: a large thumbnail plus the fields that do not earn a column.
//
// The row-level thumbnail is 40px, which is enough to tell a bloc of tissue from a control
// section but not enough to recognise a specific case. This is where a slide gets looked at
// before it gets opened — one decode, on demand, for the row the user is actually considering.
import React from 'react';
import { getThumbnailUrl } from '../../api/index.js';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { fmtSize, isSlideRow, STATUSES } from './browseUtils.js';

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div className="browser-preview-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export default function PreviewPane({ row, onOpen, onStatus, onShare }) {
  if (!row) {
    return (
      <aside className="browser-preview is-empty">
        <p className="browser-preview-hint">Select a row to preview it.</p>
      </aside>
    );
  }

  const slide = isSlideRow(row);

  return (
    <aside className="browser-preview">
      {slide ? (
        <div className="browser-preview-image">
          {/* Keyed on the row id so switching selection swaps the src rather than showing the
              previous slide's pixels until the new decode returns. */}
          <img key={row.id} src={getThumbnailUrl(row.id)} alt={`Thumbnail of ${row.name}`} />
        </div>
      ) : (
        <div className="browser-preview-image is-folder">
          <span>{row.count === null ? '—' : row.count}</span>
          <small>item{row.count === 1 ? '' : 's'}</small>
        </div>
      )}

      <h2 className="browser-preview-title" title={row.name}>{row.name}</h2>

      <dl className="browser-preview-fields">
        <Field label="Status" value={slide ? (row.status || 'New') : null} />
        <Field label="Diagnosis" value={row.diagnosis} />
        <Field label="Size" value={fmtSize(row.size)} />
        <Field label="Folder" value={row.folderPath} />
        <Field label="Collection" value={row.collectionName} />
        <Field label="Updated" value={row.created ? new Date(row.created).toLocaleString() : null} />
      </dl>

      <div className="browser-preview-actions">
        <Button size="sm" onClick={() => onOpen(row)}>
          {slide ? 'Open slide' : 'Open folder'}
        </Button>
        {slide ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm">Status</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {STATUSES.filter((s) => s !== 'All').map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onStatus(s)}>{s}</DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onStatus(null)}>Clear</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // Patient sharing is granted per folder — a share link exposes a case, not one slide.
          <Button variant="secondary" size="sm" onClick={() => onShare(row.raw)}>Share</Button>
        )}
      </div>
    </aside>
  );
}
