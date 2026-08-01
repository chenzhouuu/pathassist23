// src/components/browser/browserColumns.jsx
// The table's column definitions, in @tanstack/react-table's shape.
//
// Split out from BrowserPage for the same reason OHIF keeps `columns/defaultColumns.tsx` apart
// from its table: what a column *is* (accessor, sort, cell) is data, and it changes for reasons
// that have nothing to do with how the page fetches or navigates.
//
// The default five are the ones a pathologist reads at a glance. Diagnosis, Folder and Collection
// are defined but start hidden — @tanstack's visibility state makes them a checkbox away, so
// carrying them costs nothing and dropping them would cost a code change.
import React from 'react';
import { ChevronRight, Folder as FolderIcon } from 'lucide-react';
import { Checkbox } from '../ui/checkbox.tsx';
import SlideThumb from './SlideThumb.jsx';
import { fmtSize, fmtDate, isSlideRow } from './browseUtils.js';

export const HIDDEN_BY_DEFAULT = { diagnosis: false, folderPath: false, collectionName: false };

const STATUS_TONE = {
  Read: 'var(--success)',
  'In Review': '#dc7609',
  Flagged: 'var(--danger)',
  New: 'var(--muted-hex)',
};

function StatusDot({ status }) {
  // An untriaged slide reads as New rather than as blank: "nothing here yet" and "nobody has
  // looked" are the same state, and calling it New is what makes the status filter useful.
  const label = status || 'New';
  return (
    <span className="browser-status" title={label}>
      <span className="browser-status-dot" style={{ background: STATUS_TONE[label] || 'var(--muted-hex)' }} />
      {label}
    </span>
  );
}

export function buildColumns({ onOpen }) {
  return [
    {
      id: 'select',
      enableSorting: false,
      enableHiding: false,
      size: 36,
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        // Only slides are selectable. The batch actions are status changes and export, neither of
        // which means anything for a folder.
        isSlideRow(row.original) ? (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${row.original.name}`}
          />
        ) : null
      ),
    },
    {
      id: 'name',
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <button type="button" className="browser-name" onClick={() => onOpen(r)}>
            {isSlideRow(r)
              ? <SlideThumb itemId={r.id} />
              : <span className="browser-thumb browser-thumb-folder"><FolderIcon size={18} /></span>}
            <span className="browser-name-text">
              <span className="browser-name-label">{r.name}</span>
              {!isSlideRow(r) && r.count !== null && (
                <span className="browser-name-sub">{r.count} item{r.count === 1 ? '' : 's'}</span>
              )}
            </span>
            {/* Sits against the name, not pushed to the far edge of the column: a chevron
                stranded in whitespace reads as belonging to the next column over. */}
            {!isSlideRow(r) && <ChevronRight size={14} className="browser-name-chevron" />}
          </button>
        );
      },
    },
    {
      id: 'status',
      accessorFn: (r) => (isSlideRow(r) ? (r.status || 'New') : ''),
      header: 'Status',
      size: 120,
      cell: ({ row }) => (isSlideRow(row.original) ? <StatusDot status={row.original.status} /> : null),
    },
    {
      id: 'size',
      accessorFn: (r) => r.size ?? -1,   // sort on the number, render the human form
      header: 'Size',
      size: 90,
      cell: ({ row }) => <span className="browser-num">{fmtSize(row.original.size)}</span>,
    },
    {
      id: 'created',
      accessorKey: 'created',
      header: 'Updated',
      size: 90,
      cell: ({ row }) => (
        <span className="browser-num" title={row.original.created || ''}>{fmtDate(row.original.created)}</span>
      ),
    },
    { id: 'diagnosis', accessorKey: 'diagnosis', header: 'Diagnosis',
      cell: ({ row }) => row.original.diagnosis || '' },
    { id: 'folderPath', accessorKey: 'folderPath', header: 'Folder',
      cell: ({ row }) => row.original.folderPath || '' },
    { id: 'collectionName', accessorKey: 'collectionName', header: 'Collection',
      cell: ({ row }) => row.original.collectionName || '' },
  ];
}
