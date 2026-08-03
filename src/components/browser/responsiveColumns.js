// src/components/browser/responsiveColumns.js
// Which columns the table gives up when it runs out of room, as a pure function of one number.
//
// The mechanism is the one OHIF's StudyList uses for the same problem: every column carries a
// `meta.priority`, a hook measures the container, and the columns below the line are hidden. This
// module is the second half of that — the arithmetic — kept apart from the measuring so it can be
// checked without a browser. `useResponsiveColumns.js` is the half that needs one.
//
// WHY A LADDER AND NOT A MEDIA QUERY. The table's width is not the window's. The rail takes a
// fixed 240px and the preview takes whatever the user last dragged it to, anywhere between 15%
// and 50% of the window, so the same 1280px laptop is a 715px table with the preview at its
// default and a 395px table with it dragged out to the ceiling. A breakpoint on the window cannot
// tell those apart, and would drop columns on a table that had the room or keep them on one that
// did not.
//
// WHY A COLUMN WITH NO PRIORITY IS THE INVARIANT. Name never drops, and the way that is stated
// here is that it has no priority to compare — not a very large number that a future column could
// accidentally exceed. Same for the select checkbox: a table whose rows cannot be picked is not a
// narrower table, it is a different one.
//
// WHY THE MINIMUMS ARE NOT THE RENDERED WIDTHS. Every column except Name is laid out at a fixed
// width (see `_table.css` on `table-layout: fixed`), so for those two numbers are the same value
// and only one is stated. Name is the flexible column and takes whatever is left over, so its
// minimum is not a width it will be given — it is the width below which the name stops being
// readable and the table is better off shedding a column instead. 260px leaves ~184px of text
// after the thumbnail and the padding, which is where a TCGA filename still shows enough of its
// barcode to tell two slides apart.

/**
 * The columns to hide, in the order they were given up, for a container of `available` pixels.
 *
 * Nothing is hidden when `available` is not a positive number. A container that has not been
 * measured yet reports 0 in jsdom and null before the first observation, and a table that hid four
 * columns on first paint and put them back a frame later would read as a rendering bug.
 *
 * @param {number|null|undefined} available the table container's content width, in CSS pixels.
 * @param {{ id: string, min?: number, priority?: number }[]} spec one entry per column that would
 *   otherwise be showing. `priority` counts up from the first column to be given up; a column
 *   without one never drops.
 * @returns {string[]} column ids, lowest priority first.
 */
export function hiddenByWidth(available, spec) {
  const hidden = [];
  if (!Number.isFinite(available) || available <= 0) return hidden;

  const columns = spec || [];
  let needed = columns.reduce((sum, c) => sum + (c.min || 0), 0);

  const droppable = columns
    .filter((c) => Number.isFinite(c.priority))
    .sort((a, b) => a.priority - b.priority);

  for (const column of droppable) {
    if (needed <= available) break;
    hidden.push(column.id);
    needed -= column.min || 0;
  }
  return hidden;
}

/**
 * The spec `hiddenByWidth` wants, read off the column definitions the table is already built from.
 *
 * A column the caller is hiding for another reason is left out entirely rather than passed through
 * with a zero width: it is not competing for the space, and including it would let a hidden column
 * push a visible one off the table.
 *
 * @param {{ id: string, meta?: { width?: number, minWidth?: number, priority?: number } }[]} columns
 * @param {Record<string, boolean>} visibility @tanstack's visibility map; absent means visible.
 * @returns {{ id: string, min: number, priority: number|undefined }[]}
 */
export function specFor(columns, visibility = {}) {
  return (columns || [])
    .filter((c) => visibility[c.id] !== false)
    .map((c) => ({
      id: c.id,
      min: c.meta?.minWidth ?? c.meta?.width ?? 0,
      priority: c.meta?.priority,
    }));
}
