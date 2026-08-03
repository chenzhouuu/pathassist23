// src/components/browser/StatusChip.jsx
// The triage status, as the table row and the grid card both draw it.
//
// It is its own module rather than a private function inside the column definitions because the
// grid needs it too, and a grid that imported the table's column factory to get one span would be
// reaching through the wrong door. Both views showing the identical chip is the claim the view
// switch makes — the same rows, drawn two ways — so the vocabulary has to be spelled in one place.
import React from 'react';

/**
 * @param {object} props
 * @param {string|null|undefined} props.status the row's `meta.status`, if it has ever been triaged.
 */
export default function StatusChip({ status }) {
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
