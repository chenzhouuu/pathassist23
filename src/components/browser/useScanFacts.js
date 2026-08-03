// src/components/browser/useScanFacts.js
// The one place the browser asks Girder what a slide was scanned at.
//
// Three surfaces want that answer — the table's Scan column, the grid card's caption and the
// preview pane's field set — and until this ticket all three wrote the same query out again. What
// held it together was that the three keys happened to be identical character for character, so
// React Query served all three from one cache entry and switching table → grid → preview cost no
// request. That is a real property worth keeping and a terrible thing to leave depending on three
// string literals staying in agreement, which is the whole reason this module exists.
//
// WHY THE GATE IS THE CALLER'S. The three differ in exactly one respect and it is not incidental.
// The column and the card hold their request back until the row has been near the viewport,
// because a folder of five hundred rows would otherwise ask five hundred times at once; the pane
// has one row at a time and no reason to wait. So the query's shape is here and the decision to
// run it yet is passed in.
//
// `staleTime: Infinity` because a slide's objective power is a property of the scan and does not
// change while the page is open. `retry: false` because `getTilesInfoSafe` swallows the error and
// resolves null — a retry would only repeat a request that already told us what it could.
import { useQuery } from '@tanstack/react-query';
import { getTilesInfoSafe } from '../../api/index.js';
import { scanCell, wantsTiles } from './scanFacts.js';

/**
 * The scan facts for one row: the raw tiles document, and the Scan column's reading of it.
 *
 * @param {object|null} row a row from browseUtils, or null when nothing is selected.
 * @param {object}  [options]
 * @param {boolean} [options.enabled] the caller's own gate, ANDed with "is this row worth asking
 *   about at all". Defaults to true, which is the pane's case.
 * @returns {{ tiles: object|null|undefined, text: string, kind: string }} `tiles` is undefined
 *   while the request is out and null when it failed; `text` and `kind` are `scanCell`'s.
 */
export function useScanFacts(row, { enabled = true } = {}) {
  const { data: tiles } = useQuery({
    queryKey: ['browser', 'tiles', row?.id],
    queryFn: () => getTilesInfoSafe(row.id),
    enabled: enabled && !!row && wantsTiles(row),
    staleTime: Infinity,
    retry: false,
  });

  const { text, kind } = scanCell(row, tiles);
  return { tiles, text, kind };
}
