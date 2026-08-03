// src/components/browser/SkeletonRows.jsx
// What the table shows while it is waiting, instead of the word "Loading…".
//
// WHY SKELETONS AND NOT A LINE OF TEXT. Carbon's rule is the one that applies here: use skeleton
// states rather than spinners on container-based components, and on data-based components like
// data tables. The reason is layout, not decoration — a text line collapses the table to a single
// row and then expands it again when the rows land, so the page jumps twice for every folder you
// walk into. Blocks at the real row height hold the frame still and the arrival is a swap.
//
// WHY THE WIDTHS CYCLE. Primer varies its placeholder widths on a five-step cycle so a block of
// them does not look stamped from one die. These are its five steps.
//
// WHAT THIS DELIBERATELY IS NOT. It does not mirror the live column set. A skeleton that tracked
// `columnVisibility`, the level rule and the responsive ladder would be a second implementation of
// three things that already compose in BrowserPage, kept in step by hand, in order to be accurate
// about content nobody can read yet. Name, one metadata block and one number is the shape of every
// level; the frame is what has to be right.
import React from 'react';

// 85 / 67.5 / 80 / 60 / 75.
const WIDTHS = ['85%', '67.5%', '80%', '60%', '75%'];

/**
 * @param {object} props
 * @param {number} [props.rows] how many placeholder rows to draw; nine fills a 900px window.
 */
export default function SkeletonRows({ rows = 9 }) {
  return (
    <div className="browser-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="browser-skeleton-row" key={i}>
          <span className="browser-skeleton-box browser-skeleton-thumb" />
          <span className="browser-skeleton-box" style={{ width: WIDTHS[i % WIDTHS.length] }} />
          <span className="browser-skeleton-box browser-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}
