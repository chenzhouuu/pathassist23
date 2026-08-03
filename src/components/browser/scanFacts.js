// src/components/browser/scanFacts.js
// What the Scan column says about a row, as a pure function of the row and the tiles metadata.
//
// Split out from browserColumns.jsx for the reason browseUtils.js is split out from the table:
// the interesting part here is not the markup but the three *empty* states, and those are only
// checkable without a browser if they live in a function that takes data and returns a string.
//
// The three states are three different facts and the column must not conflate them:
//
//   a folder          → nothing at all. A folder has no scanner and saying so is noise.
//   a non-slide item  → "not a slide". Girder items are not all images; `cellpose_test.anot` in
//                       TCGA-NSCLC/slides is an annotation file sitting in a slide folder.
//   a slide whose     → "not recorded". The 14 MDA `.tiff` files answer /tiles with
//   source recorded     `magnification: null, mm_x: null` and still carry a full pyramid and a
//   no magnification    thumbnail. Calling those "not a slide" would be false on every one of
//                       them, and it is exactly the mistake a two-state column makes.
//
// The slide/not-a-slide split is answered from the item the table already holds — Girder puts a
// `largeImage` field on an item only once a tile source has been attached — so it costs no
// request. Only a real slide needs the /tiles round trip, which is what `wantsTiles` is for.
import { isSlideRow } from './browseUtils.js';

const MICRONS_PER_MM = 1000;

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// Girder's tiles metadata quotes the pixel pitch in millimetres, and pathology quotes it in
// microns per pixel, so the conversion is part of reading the field rather than a presentation
// choice. Two significant figures: 0.2519 µm is a scanner tolerance, not a measurement anyone
// reads past the second digit, and `Number()` then drops the trailing zero that `toPrecision`
// leaves behind so 0.50 prints as 0.5.
function fmtMicrons(mmX) {
  if (!isPositiveNumber(mmX)) return null;
  return `${Number((mmX * MICRONS_PER_MM).toPrecision(2))} µm`;
}

// Objective power. Held to one decimal so a scanner that reports 40.0 prints as 40 while one
// that reports 20.5 keeps the half step it means.
function fmtMagnification(mag) {
  if (!isPositiveNumber(mag)) return null;
  return `${Number(mag.toFixed(1))}×`;
}

/**
 * Whether Girder has attached a tile source to the item behind this row.
 *
 * @param {object} row a row from browseUtils' `toSlideRow` / `toFolderRow`.
 * @returns {boolean}
 */
export function hasLargeImage(row) {
  return isSlideRow(row) && row?.raw?.largeImage != null;
}

/**
 * Whether asking `/item/{id}/tiles` about this row could tell us anything. False for folders and
 * for items with no tile source, both of which the row itself already answers — this is what
 * keeps a folder of five hundred rows from firing five hundred pointless requests.
 *
 * @param {object} row a row from browseUtils.
 * @returns {boolean}
 */
export function wantsTiles(row) {
  return hasLargeImage(row);
}

/**
 * The Scan column's content for one row.
 *
 * `kind` is separate from `text` because the four outcomes are typeset differently: a real
 * reading is a number and belongs in mono, whereas "not recorded" is prose about the slide's
 * provenance and belongs in the UI face, quieter.
 *
 * @param {object} row a row from browseUtils.
 * @param {object|null|undefined} tiles the parsed /tiles response, or null/undefined if it has
 *   not arrived — `getTilesInfoSafe` returns null rather than throwing, and a request that is
 *   still in flight is indistinguishable from one that failed as far as this column is concerned.
 * @returns {{ text: string, kind: 'folder'|'not-a-slide'|'unknown'|'not-recorded'|'ok' }}
 */
export function scanCell(row, tiles) {
  if (!isSlideRow(row)) return { text: '', kind: 'folder' };
  if (!hasLargeImage(row)) return { text: 'not a slide', kind: 'not-a-slide' };
  if (!tiles) return { text: '', kind: 'unknown' };

  // Magnification and pixel pitch are recorded independently — a source can carry one without
  // the other — so each is rendered when it is there rather than gating the pair on both.
  const parts = [fmtMagnification(tiles.magnification), fmtMicrons(tiles.mm_x)].filter(Boolean);
  if (!parts.length) return { text: 'not recorded', kind: 'not-recorded' };
  return { text: parts.join(' · '), kind: 'ok' };
}
