// src/components/browser/browserColumns.jsx
// The table's column definitions, in @tanstack/react-table's shape.
//
// Split out from BrowserPage for the same reason OHIF keeps `columns/defaultColumns.tsx` apart
// from its table: what a column *is* (accessor, sort, cell) is data, and it changes for reasons
// that have nothing to do with how the page fetches or navigates.
//
// The default six are the ones a pathologist reads at a glance. Diagnosis, Folder and Collection
// are defined but start hidden — @tanstack's visibility state makes them a checkbox away, so
// carrying them costs nothing and dropping them would cost a code change.
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder as FolderIcon } from 'lucide-react';
import { Checkbox } from '../ui/checkbox.tsx';
import SlideThumb, { useOnScreen } from './SlideThumb.jsx';
import { getTilesInfoSafe } from '../../api/index.js';
import { fmtSize, fmtDate, isSlideRow } from './browseUtils.js';
import { hasLargeImage, scanCell, wantsTiles } from './scanFacts.js';

export const HIDDEN_BY_DEFAULT = { diagnosis: false, folderPath: false, collectionName: false };

function StatusChip({ status }) {
  // An untriaged slide reads as New rather than as blank: "nothing here yet" and "nobody has
  // looked" are the same state, and calling it New is what makes the status filter useful.
  //
  // The status is written to a data attribute rather than turned into an inline colour, because
  // the fill is a `color-mix` of the semantic hue over the current surface and the label is the
  // theme's own reading of that hue — two values that have to move together when the page goes
  // dark, which is a stylesheet's job and not a component's.
  const label = status || 'New';
  return <span className="browser-status" data-status={label}>{label}</span>;
}

// The Scan column's cell, which is the one cell in the table that has to ask the server a
// question. It asks per row rather than by lifting the fetch into BrowserPage: a slide's scanner
// parameters belong to the slide, and hoisting them would mean the page holding a map keyed by
// item id that only this column reads.
//
// Two things keep the request count sane on the 500-row folders this instance actually has.
// `wantsTiles` answers folders and non-slide items from the row itself, with no request at all;
// and the query is held back until the row has been near the viewport, the same gate and the same
// observer the thumbnail beside it uses. React Query then dedups and caches, so scrolling back up
// a list costs nothing. `staleTime: Infinity` because a slide's objective power is a property of
// the scan and does not change while the page is open.
function ScanCell({ row }) {
  const [ref, seen] = useOnScreen();
  const ask = wantsTiles(row);
  const { data } = useQuery({
    queryKey: ['browser', 'tiles', row.id],
    queryFn: () => getTilesInfoSafe(row.id),
    enabled: ask && seen,
    staleTime: Infinity,
    // `getTilesInfoSafe` swallows the error and resolves null, so a retry would only repeat a
    // request that already told us what it could.
    retry: false,
  });

  const { text, kind } = scanCell(row, data);
  return <span ref={ref} className="browser-scan" data-kind={kind}>{text}</span>;
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
          // The button, and not the row, is what opens. The row selects on click and the
          // stylesheet puts the hover affordance here for that reason: tinting the whole row
          // would advertise an open target across 700px of cells that do not open anything.
          <button type="button" className="browser-name" onClick={() => onOpen(r)}>
            {/* Three tiles, one frame. The middle case is the annotation files and other loose
                items that live in slide folders: asking Girder for a thumbnail of an item with no
                tile source is a request that can only 400, and the empty bed is what the failed
                request would have left behind anyway. */}
            {!isSlideRow(r) ? (
              <span className="browser-thumb browser-thumb-folder"><FolderIcon size={18} /></span>
            ) : hasLargeImage(r) ? (
              <SlideThumb itemId={r.id} />
            ) : (
              <span className="browser-thumb" aria-hidden="true" />
            )}
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
      cell: ({ row }) => (isSlideRow(row.original) ? <StatusChip status={row.original.status} /> : null),
    },
    {
      // Sorted on the row's own kind and nothing else. The magnification arrives asynchronously
      // and per row, so sorting on it would reorder the table underneath the user as the
      // responses land — the column is there to be read, not to be sorted by.
      id: 'scan',
      header: 'Scan',
      size: 130,
      enableSorting: false,
      cell: ({ row }) => <ScanCell row={row.original} />,
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
