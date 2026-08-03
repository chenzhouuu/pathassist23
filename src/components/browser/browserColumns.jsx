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
//
// WHAT `meta` CARRIES, AND WHY IT IS NOT `size`. Three numbers per column: the width it is laid
// out at, the width it needs before the table would rather shed it, and where it sits in the queue
// when the table runs out of room. @tanstack fills `columnDef.size` with a default of 150 for
// every column that does not state one, so `size` cannot answer "did the author give this column a
// width?" — it always says yes. `meta` can, and Name's answer has to be no: it is the column that
// absorbs whatever the others leave over, and under `table-layout: fixed` that is expressed by
// declaring no width at all. See `_table.css` for the layout and `responsiveColumns.js` for the
// ladder.
//
// THE PRIORITY ORDER, LOWEST FIRST — Collection, Folder, Updated, Size, Diagnosis, Scan, Status:
//
//   Collection and Folder go first because the rail and the breadcrumb both say where you are,
//   permanently, so these two are the only columns on the table that can merely agree with
//   something already on screen.
//   Updated goes next because it distinguishes least: an ingested TCGA cohort carries dates that
//   all cluster in the same fortnight, so the column is six hundred rows of 06-25.
//   Size after it — housekeeping, and the pane states it for the selected row anyway.
//   Then Diagnosis, which is content rather than housekeeping, and finally Scan and Status, which
//   are the two columns that make this a pathology tool rather than a file manager: one says
//   whether the slide is readable at all and the other is the triage state the whole page is
//   organised around.
//   Name and the select box carry no priority, which is how "Name never drops" is stated.
import React from 'react';
import { ChevronRight, Folder as FolderIcon } from 'lucide-react';
import { Checkbox } from '../ui/checkbox.tsx';
import SlideThumb, { useOnScreen } from './SlideThumb.jsx';
import { fmtSize, fmtDate, isSlideRow } from './browseUtils.js';
import { hasLargeImage } from './scanFacts.js';
import { useScanFacts } from './useScanFacts.js';
import StatusChip from './StatusChip.jsx';

export const HIDDEN_BY_DEFAULT = { diagnosis: false, folderPath: false, collectionName: false };

// The Scan column's cell, which is the one cell in the table that has to ask the server a
// question. It asks per row rather than by lifting the fetch into BrowserPage: a slide's scanner
// parameters belong to the slide, and hoisting them would mean the page holding a map keyed by
// item id that only this column reads.
//
// Two things keep the request count sane on the 500-row folders this instance actually has.
// `wantsTiles`, inside the hook, answers folders and non-slide items from the row itself with no
// request at all; and the query is held back until the row has been near the viewport, the same
// gate and the same observer the thumbnail beside it uses. React Query then dedups and caches, so
// scrolling back up a list costs nothing — and so does switching to the grid, which asks for the
// same key through the same hook.
function ScanCell({ row }) {
  const [ref, seen] = useOnScreen();
  const { text, kind } = useScanFacts(row, { enabled: seen });
  return <span ref={ref} className="browser-scan" data-kind={kind}>{text}</span>;
}

export function buildColumns({ onOpen }) {
  return [
    {
      id: 'select',
      enableSorting: false,
      enableHiding: false,
      // No priority: a table whose rows cannot be picked is not a narrower table, it is a
      // different one. 36px is the checkbox plus the cell's own padding, and under a fixed layout
      // it is now a rule rather than the hint it was — this column used to absorb the table's
      // slack and push the thumbnail a finger's width to the right.
      meta: { width: 36 },
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
      // No width, so it takes whatever the fixed columns leave; no priority, so it is never what
      // gets left out. `minWidth` is the only number it states, and it is a threshold rather than
      // a size: below 260px the name has less than ~180px of text after the thumbnail, which is
      // where a TCGA barcode stops distinguishing two slides, and the table is better off giving
      // up a column than showing eight rows of the same truncated prefix.
      meta: { minWidth: 260 },
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
      meta: { width: 120, priority: 7 },
      cell: ({ row }) => (isSlideRow(row.original) ? <StatusChip status={row.original.status} /> : null),
    },
    {
      // Sorted on the row's own kind and nothing else. The magnification arrives asynchronously
      // and per row, so sorting on it would reorder the table underneath the user as the
      // responses land — the column is there to be read, not to be sorted by.
      id: 'scan',
      header: 'Scan',
      meta: { width: 130, priority: 6 },
      enableSorting: false,
      cell: ({ row }) => <ScanCell row={row.original} />,
    },
    {
      id: 'size',
      accessorFn: (r) => r.size ?? -1,   // sort on the number, render the human form
      header: 'Size',
      meta: { width: 90, priority: 4 },
      cell: ({ row }) => <span className="browser-num">{fmtSize(row.original.size)}</span>,
    },
    {
      id: 'created',
      accessorKey: 'created',
      header: 'Updated',
      meta: { width: 90, priority: 3 },
      cell: ({ row }) => (
        <span className="browser-num" title={row.original.created || ''}>{fmtDate(row.original.created)}</span>
      ),
    },
    // The three opt-in columns. They are free text of unbounded length, so each states a width for
    // the same reason the fixed layout needs one at all, and each clips with an ellipsis rather
    // than wrapping — a row that grew to two lines because one diagnosis is long would break the
    // 56px rhythm the whole table is set to.
    { id: 'diagnosis', accessorKey: 'diagnosis', header: 'Diagnosis',
      meta: { width: 160, priority: 5 },
      cell: ({ row }) => <span className="browser-clip">{row.original.diagnosis || ''}</span> },
    { id: 'folderPath', accessorKey: 'folderPath', header: 'Folder',
      meta: { width: 160, priority: 2 },
      cell: ({ row }) => <span className="browser-clip">{row.original.folderPath || ''}</span> },
    { id: 'collectionName', accessorKey: 'collectionName', header: 'Collection',
      meta: { width: 160, priority: 1 },
      cell: ({ row }) => <span className="browser-clip">{row.original.collectionName || ''}</span> },
  ];
}
