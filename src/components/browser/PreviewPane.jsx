// src/components/browser/PreviewPane.jsx
// The right-hand pane: a large thumbnail plus the facts that tell one slide from another.
//
// The row-level thumbnail is 40px, which is enough to tell a bloc of tissue from a control section
// but not enough to recognise a specific case. This is where a slide gets looked at before it gets
// opened — one decode, on demand, for the row the user is actually considering.
//
// WHAT THE FIELD SET IS FOR. It used to restate the row: status, diagnosis, size, folder,
// collection, date — six fields of which four were already on screen in the table beside it, and
// none of which distinguishes two slides from the same case. What actually does is the scan:
// objective power, pixel pitch, how many pixels there are and what shape they make, and how deep
// the pyramid goes. Folder and Collection are gone for the same reason they were only ever worth
// having — the rail and the breadcrumb now both say where you are, permanently, and a third copy
// in the pane is a field that can only ever agree with them.
//
// WHY THE FRAME IS 3:2. Slides in this instance run from 0.62 : 1 to 4.33 : 1 with a median of
// 1.66, so a square frame — what this pane had — spent most of its height on empty bed for the
// typical slide while still letterboxing the extremes. A frame wider than it is tall fits the
// median snugly and both tails still contain, because `contain` is what makes a 4.33 : 1 strip
// readable as a strip rather than as a crop.
//
// WHY THE TILES QUERY IS THE SCAN COLUMN'S. It is literally the column's, through `useScanFacts` —
// the same key, the same fetch and the same `staleTime` — so a row the table has already asked
// about costs this pane nothing at all. Only the gate differs, and that is the hook's one
// parameter: the column and the grid hold their request back until the row is near the viewport,
// because a folder of five hundred would otherwise ask five hundred times, and there is only ever
// one selected row here.
//
// The pane lays the two optical readings out as two labelled fields where the column joins them
// into one sentence, so it takes the formatters from the shared module and arranges them itself.
// It kept private copies of both until ticket 10, and the reason they looked unshareable is that
// the pane captions the pitch `µm/px` and the column captions it `µm` — each right where it sits.
// That is one parameter, not two functions with the same rounding rules to keep in step.
import React from 'react';
import { getThumbnailUrl } from '../../api/index.js';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { fmtSize, isSlideRow, STATUSES } from './browseUtils.js';
import { fmtMagnification, fmtMicrons } from './scanFacts.js';
import { useScanFacts } from './useScanFacts.js';

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// The other readings the pane takes off the tiles document, each returning null where the scanner
// did not record the value — which for the 14 MDA `.tiff` files is magnification and pitch both,
// while dimensions and pyramid depth are still there. That per-field independence is the whole
// point: they are recorded separately and a slide can carry any subset.
//
// Grouped, because these run to five and six digits — `83664 × 58852` has to be counted before it
// can be compared with the slide next to it, and `83,664 × 58,852` does not. The locale is fixed
// rather than the reader's: this is a measurement in a fixed-width column beside other
// measurements, and a separator that changes with the browser's language would break the alignment
// the mono face is there to provide.
function fmtDimensions(tiles) {
  if (!isPositiveNumber(tiles?.sizeX) || !isPositiveNumber(tiles?.sizeY)) return null;
  return `${tiles.sizeX.toLocaleString('en-US')} × ${tiles.sizeY.toLocaleString('en-US')}`;
}

// Derived, never stored: the ratio is two numbers the tiles document already carries, and keeping
// a third copy of it would be a value that could disagree with them. Quoted against 1 in both
// directions — a portrait slide reads 0.62 : 1 rather than being flipped into 1.61 : 1, because
// which way round it is, is the fact.
function fmtAspect(tiles) {
  if (!isPositiveNumber(tiles?.sizeX) || !isPositiveNumber(tiles?.sizeY)) return null;
  return `${(tiles.sizeX / tiles.sizeY).toFixed(2)} : 1`;
}

function fmtLevels(levels) {
  return isPositiveNumber(levels) ? String(levels) : null;
}

// A field with no value is absent, not blank. An empty row with a label on it is a claim that the
// value is missing; no row at all is the honest statement that this slide does not carry the fact.
function Field({ label, value, mono }) {
  if (!value) return null;
  return (
    <div className="browser-preview-field">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}

/**
 * The preview pane.
 *
 * @param {object}   props
 * @param {object?}  props.row    — the selected row, or null.
 * @param {number}   props.width  — from `usePreviewResize`; the pane is sized by the user, so the
 *                                  number is inline rather than in the stylesheet.
 * @param {string?}  props.id     — so the resizer beside it can name what it resizes.
 * @param {(row: object) => void} props.onOpen
 * @param {(status: string|null) => void} props.onStatus
 * @param {(folder: object) => void} props.onShare
 */
export default function PreviewPane({ row, width, id, onOpen, onStatus, onShare }) {
  const slide = isSlideRow(row);

  // Called unconditionally, with the row's own id in the key, so switching selection is a cache
  // lookup rather than a remount — and so the empty pane below does not have to be a second
  // component just to avoid a conditional hook.
  const { tiles } = useScanFacts(row);

  const style = { width, flexBasis: width };

  if (!row) {
    return (
      <aside className="browser-preview is-empty" id={id} style={style}>
        <p className="browser-preview-hint">Select a row to preview it.</p>
      </aside>
    );
  }

  return (
    <aside className="browser-preview" id={id} style={style}>
      {slide ? (
        <div className="browser-preview-image">
          {/* Keyed on the row id so switching selection swaps the src rather than showing the
              previous slide's pixels until the new decode returns. */}
          <img key={row.id} src={getThumbnailUrl(row.id)} alt={`Thumbnail of ${row.name}`} />
        </div>
      ) : (
        <div className="browser-preview-image is-folder">
          {/* A folder Girder has not counted is `—`, not 0: "nobody has counted this" and "this is
              empty" are different facts and only one of them means skip it. */}
          <span>{row.count === null ? '—' : row.count}</span>
          <small>item{row.count === 1 ? '' : 's'}</small>
        </div>
      )}

      <h2 className="browser-preview-title" title={row.name}>{row.name}</h2>

      <dl className="browser-preview-fields">
        <Field label="Status" value={slide ? (row.status || 'New') : null} />
        <Field label="Diagnosis" value={row.diagnosis} />
        <Field label="Magnification" value={fmtMagnification(tiles?.magnification)} mono />
        <Field label="Resolution" value={fmtMicrons(tiles?.mm_x, 'µm/px')} mono />
        <Field label="Dimensions" value={fmtDimensions(tiles)} mono />
        <Field label="Aspect" value={fmtAspect(tiles)} mono />
        <Field label="Levels" value={fmtLevels(tiles?.levels)} mono />
        <Field label="Size" value={fmtSize(row.size)} mono />
        {/* The date without the time. The table's `fmtDate` drops the year because inside a working
            set everything is from the last few weeks; here there is room for the year and no room
            for a timestamp, and the minute a slide was ingested has never been the question. */}
        <Field
          label="Updated"
          value={row.created ? new Date(row.created).toLocaleDateString() : null}
          mono
        />
      </dl>

      <div className="browser-preview-actions">
        <Button size="sm" onClick={() => onOpen(row)}>
          {slide ? 'Open slide' : 'Open folder'}
        </Button>
        {/* `browser-quiet` for the reason the toolbar's controls carry it: `variant="secondary"`
            is a sunken fill, which on the pane's own near-white ground leaves the button with no
            visible boundary at all. The class gives it an edge and leaves the brand fill to the
            one button here that is a primary action. */}
        {slide ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" className="browser-quiet">Status</Button>
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
          <Button variant="secondary" size="sm" className="browser-quiet" onClick={() => onShare(row.raw)}>
            Share
          </Button>
        )}
      </div>
    </aside>
  );
}
