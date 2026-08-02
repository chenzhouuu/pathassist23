// src/components/workspace/ArtifactSegments.jsx — one row per class, with its own eye and swatch.
//
// Modelled on OHIF's platform/ui-next/src/components/SegmentationTable/SegmentationSegments.tsx
// at v3.10.0-beta.151 (4e09f85d5). Upstream's own description of that file is "a loop that hands
// every segment to a DataRow", and `DataRow` is already vendored verbatim here (Inc 5 · 02) —
// swatch, eye, number box, details block and all. This is the loop.
//
// It is not a verbatim copy, for the reason `DataRow`'s header already gives: upstream reads
// `representation.segments` out of `useSegmentationTableContext`, so vendoring the file would mean
// vendoring the two contexts under it and then assembling a fake Cornerstone representation per
// nuclei class — "an adapter pretending to be a segmentation", which that header says was
// rejected. What was kept is what carries the design: the DataRow per segment, `colorHex` from the
// segment's own colour, `isVisible` on the eye, `space-y-px` between rows, and the `max-h-80`
// scroll bound. What was dropped is `ScrollArea` (a vendored radix wrapper for `overflow-y-auto`,
// not worth a dependency for five rows) and the `HoverCard` + `SegmentStatistics` pair — our count
// and fraction are two short strings and belong on the row rather than behind a hover.
import React, { useRef } from 'react';
import { DataRow } from './vendor/ohif/DataRow.tsx';

/**
 * `10,955 · 72.2%` — the numbers a segment row carries, in the details slot DataRow gives it.
 *
 * `note` is the third slot and is used where a number alone would mislead: a tissue class whose
 * soft fraction differs from its hard one, a marker with no separable positive population.
 */
function detailLines(segment) {
  const count = Number.isFinite(segment.count) ? segment.count.toLocaleString() : null;
  const pct = Number.isFinite(segment.fraction) ? `${(segment.fraction * 100).toFixed(1)}%` : null;
  const line = [count, pct, segment.note].filter(Boolean).join(' · ');
  return line ? [line] : [];
}

export default function ArtifactSegments({ segments, onToggle, onColor }) {
  // Upstream's "Change Color" is a menu item, so the picker it opens has to be somewhere; a single
  // hidden input, retargeted per click, is the least of it. One per list, not one per row.
  const picker = useRef(null);
  const target = useRef(null);

  if (!segments?.length) return null;

  return (
    <div className="max-h-80 space-y-px overflow-y-auto" data-cy="artifact-segments">
      {onColor && (
        <input
          ref={picker} type="color" className="sr-only" tabIndex={-1} aria-hidden="true"
          data-cy="artifact-segment-color"
          onChange={(e) => target.current && onColor(target.current, e.target.value)}
        />
      )}
      {segments.map((s, i) => (
        <DataRow
          key={s.key}
          number={i + 1}
          title={s.label}
          colorHex={s.colorHex}
          details={{ primary: detailLines(s), secondary: [] }}
          isVisible={s.visible}
          // The eye hides the class from the *picture*. Its count is in `details` either way —
          // hiding a class from the map must not hide it from the arithmetic.
          onToggleVisibility={onToggle ? () => onToggle(s.key) : undefined}
          // Upstream's own colour affordance, offered only where a colour is genuinely the user's
          // (a marker channel, whose colours are a choice about legibility). A tissue class's or a
          // phenotype's colour is the artifact's own and is not editable — that is what makes a
          // swatch a reliable key to the picture.
          onColor={onColor ? () => {
            target.current = s.key;
            picker.current?.click();
          } : undefined}
          // No rename, no delete, no lock: a class is a property of the artifact, not a row the
          // user owns. `disableEditing` is upstream's way of saying that, and it renders the
          // spacer that keeps these rows aligned with the artifact rows above them. It also hides
          // the menu outright, so a row that *does* offer a colour has to opt back in.
          disableEditing={!onColor}
        />
      ))}
    </div>
  );
}
