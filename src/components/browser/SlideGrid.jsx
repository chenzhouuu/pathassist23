// src/components/browser/SlideGrid.jsx
// The second way to read a level: the same rows the table shows, with the slide image promoted to
// the primary thing and the metadata demoted to a caption under it.
//
// This is the view where `contain` rather than `cover` earns its keep. Slides in this instance run
// from 0.62 : 1 to 4.33 : 1, and one letterboxed frame in a table row is a detail — a wall of forty
// of them is a map of the level, because the difference between a square block of tissue and a long
// strip is legible before a single filename has been read. A wall of square crops says nothing.
//
// WHY THE CARD IS NOT A BUTTON. The card has two jobs: clicking it selects, and clicking the image
// or the name opens. A `<button>` card would put those two open targets *inside* a button, which is
// invalid HTML — the parser unnests it and React warns — so the card is a plain `<li>` with a click
// handler and the two open targets are real buttons. This is exactly the table's arrangement, where
// `<TableRow onClick>` selects and the name `<button>` inside it opens, and it is deliberately the
// same so the two views do not teach different habits. Neither the table nor this stops propagation
// from the open target, so clicking a name selects the row on its way to opening it.
//
// WHY THE IMAGE IS HIDDEN FROM ASSISTIVE TECHNOLOGY. In the table the thumbnail and the name are one
// button, so a row exposes exactly one open target. Here they cannot be one element, so the image is
// marked `aria-hidden` and taken out of the tab order: it is a mouse affordance duplicating the
// button beside it, and a screen reader that announced both would hear every card twice. Hiding a
// *focusable* element is the thing to avoid; `tabIndex={-1}` is what makes this legitimate.
//
// WHY THREE PLACEHOLDERS AND NOT ONE. The same principle the Scan column encodes: three different
// absences are three different facts, and one shared icon asserts they are the same. A folder is a
// destination, `cellpose_test.anot` is a file that was never a slide, and a slide whose thumbnail
// did not come back is a slide — the picture is what is missing, not the slide. So they get a
// folder, a document and a struck-through image respectively.
//
// WHERE THE SCAN QUERY LIVES. In `useScanFacts.js`, which the table's Scan column and the preview
// pane call too. It used to be written out here as well, and what held the three copies together
// was that their query keys happened to be identical character for character — React Query then
// served all three from one cache entry, so switching table → grid cost no request. That property
// is the reason the hook exists rather than a happy accident it replaced.
import React, { useState } from 'react';
import { FileText, Folder as FolderIcon, ImageOff } from 'lucide-react';
import { useOnScreen } from './SlideThumb.jsx';
import { getThumbnailUrl } from '../../api/index.js';
import { isSlideRow } from './browseUtils.js';
import { hasLargeImage } from './scanFacts.js';
import { useScanFacts } from './useScanFacts.js';
import StatusChip from './StatusChip.jsx';

/**
 * What the image frame is holding, which is both the placeholder to draw and the hook the
 * stylesheet hangs the three colours off.
 *
 * @returns {'folder'|'file'|'slide'|'image'} `image` covers the frame that is waiting for its
 *   thumbnail as well as the one showing it — an empty sunken bed is what a pending decode looks
 *   like, and claiming a placeholder for it would flicker a lie on every scroll.
 */
function frameKind(row, failed) {
  if (!isSlideRow(row)) return 'folder';
  if (!hasLargeImage(row)) return 'file';
  if (failed) return 'slide';
  return 'image';
}

const PLACEHOLDER = {
  folder: <FolderIcon size={26} strokeWidth={1.5} />,
  file: <FileText size={22} strokeWidth={1.5} />,
  slide: <ImageOff size={22} strokeWidth={1.5} />,
};

function SlideCard({ row, selected, onSelect, onOpen }) {
  // One observer per card, not two. The image and the scan reading are both held back until the
  // card is near the viewport, for the reason SlideThumb.jsx spells out: Girder decodes a WSI
  // thumbnail out of the pyramid, and a folder of five hundred would otherwise ask for five hundred
  // decodes at once. The ref goes on the frame because that is the element whose arrival matters.
  const [ref, seen] = useOnScreen();
  const [failed, setFailed] = useState(false);
  const slide = isSlideRow(row);

  const scan = useScanFacts(row, { enabled: seen });
  const kind = frameKind(row, failed);

  return (
    <li
      className="browser-card"
      data-selected={selected ? '' : undefined}
      onClick={() => onSelect(row.id)}
    >
      <button
        ref={ref}
        type="button"
        className="browser-card-image"
        data-kind={kind}
        onClick={() => onOpen(row)}
        tabIndex={-1}
        aria-hidden="true"
      >
        {kind === 'image'
          ? seen && <img src={getThumbnailUrl(row.id)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : PLACEHOLDER[kind]}
      </button>

      <div className="browser-card-body">
        {/* `title` because the name clamps at two lines and an 89-character TCGA filename does not
            fit in two lines of a 190px card. The table has the same problem and answers it with an
            ellipsis; here the browser hides the overflow, so the hover is the only way back to it. */}
        <button type="button" className="browser-card-name" title={row.name} onClick={() => onOpen(row)}>
          {row.name}
        </button>

        <div className="browser-card-meta">
          {slide ? (
            // The table's chip, the component itself and not a copy of its markup, so the status
            // vocabulary is spelled and coloured in exactly one place.
            <StatusChip status={row.status} />
          ) : (
            <span className="browser-card-count">
              {row.count === null ? '—' : row.count} item{row.count === 1 ? '' : 's'}
            </span>
          )}
          <span className="browser-scan" data-kind={scan.kind}>{scan.text}</span>
        </div>
      </div>
    </li>
  );
}

/**
 * The grid.
 *
 * @param {object}   props
 * @param {object[]} props.rows       — the rows the level is showing, already filtered and sorted.
 * @param {string?}  props.selectedId — the previewed row, the same one the table marks.
 * @param {(id: string) => void}  props.onSelect
 * @param {(row: object) => void} props.onOpen — descends into a folder, opens a slide.
 */
export default function SlideGrid({ rows, selectedId, onSelect, onOpen }) {
  // The page owns the empty state, and it says something the grid cannot know — whether the level
  // is empty or the filters have emptied it. Rendering an empty `<ul>` here would put a padded gap
  // above that message.
  if (!rows.length) return null;

  return (
    // `role="list"` is restated because `display: grid` drops list semantics in WebKit, and this is
    // the one place on the page where the list *is* the layout.
    <ul className="browser-grid" role="list">
      {rows.map((r) => (
        <SlideCard
          key={r.id}
          row={r}
          selected={r.id === selectedId}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}
