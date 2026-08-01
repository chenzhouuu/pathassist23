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
import React from 'react';
import { DataRow } from './vendor/ohif/DataRow.tsx';

/** `10,955 · 72.2%` — the two numbers a class row carries, in the details slot DataRow gives it. */
function detailLines(segment) {
  const count = Number.isFinite(segment.count) ? segment.count.toLocaleString() : null;
  const pct = Number.isFinite(segment.fraction) ? `${(segment.fraction * 100).toFixed(1)}%` : null;
  const line = [count, pct].filter(Boolean).join(' · ');
  return line ? [line] : [];
}

export default function ArtifactSegments({ segments, onToggle }) {
  if (!segments?.length) return null;

  return (
    <div className="max-h-80 space-y-px overflow-y-auto" data-cy="artifact-segments">
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
          // No rename, no delete, no lock: a class is a property of the artifact, not a row the
          // user owns. `disableEditing` is upstream's way of saying that, and it renders the
          // spacer that keeps these rows aligned with the artifact rows above them.
          disableEditing
        />
      ))}
    </div>
  );
}
