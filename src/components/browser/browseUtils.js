// src/components/browser/browseUtils.js
// Pure logic for the slide browser: where in the Girder hierarchy we are, what a row looks like
// once a collection / folder / item has been flattened into one table, and how the search and
// status filters apply. No React and no network, so the rules are testable without a harness —
// the same split preprocessUtils.js and copilotTurn.js use.
//
// The hierarchy is Girder's: collection → folder → (sub)folder → item. The browser shows exactly
// one level at a time and the breadcrumb is the path back, so the whole navigation state is
// `(collection, path[])` and every question below is answered from that pair.

export const ROOT = Object.freeze({ _id: null, name: 'All collections', kind: 'root' });

// The triage vocabulary carried in item.meta.status. 'All' is the filter's no-op, not a status a
// slide can hold; 'New' doubles as the reading for a slide that has never been triaged.
export const STATUSES = Object.freeze(['All', 'New', 'In Review', 'Read', 'Flagged']);

const DEFAULT_STATUS = 'New';

// ── Navigation ─────────────────────────────────────────────────────────────────────────

// The breadcrumb trail for the current position. Always starts at ROOT so there is a way back to
// the top from anywhere. A folder path without a collection is not reachable, so it is dropped
// rather than rendered as an orphan.
export function crumbsFor(collection, path = []) {
  const crumbs = [ROOT];
  if (!collection) return crumbs;
  crumbs.push({ _id: collection._id, name: collection.name, kind: 'collection' });
  for (const f of path) crumbs.push({ _id: f._id, name: f.name, kind: 'folder' });
  return crumbs;
}

// Which level the table is listing. Drives which query runs and which columns make sense.
export function levelOf(collection, path = []) {
  if (!collection) return 'collections';
  if (!path.length) return 'folders';
  return 'items';
}

// One step up. Returns the new `(collection, path)` pair; at the root it returns the root, so a
// stray Back never produces a negative depth.
export function parentOf(collection, path = []) {
  if (path.length) return { collection, path: path.slice(0, -1) };
  if (collection) return { collection: null, path: [] };
  return { collection: null, path: [] };
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────
// Folders and slides share one table, so both are normalised to the same shape. The fields a
// kind cannot have are null rather than absent, so a column renderer never has to ask which kind
// it is holding before reading a field.

export function toFolderRow(folder) {
  return {
    id: folder._id,
    name: folder.name,
    kind: 'folder',
    // A folder Girder has not counted yet is unknown, which is not the same as empty — showing
    // "0 images" for an uncounted folder reads as "this is empty, skip it".
    count: typeof folder.nItems === 'number' ? folder.nItems : null,
    size: null,
    status: null,
    diagnosis: null,
    created: folder.created ?? folder.updated ?? null,
    folderPath: null,
    raw: folder,
  };
}

export function toSlideRow(item, { folderPath = null, collectionName = null } = {}) {
  const meta = item.meta || {};
  return {
    id: item._id,
    name: item.name,
    kind: 'slide',
    count: null,
    size: typeof item.size === 'number' ? item.size : null,
    status: meta.status ?? null,
    diagnosis: meta.diagnosis ?? null,
    created: item.updated ?? item.created ?? null,
    folderPath,
    collectionName,
    raw: item,
  };
}

export function isSlideRow(row) {
  return row?.kind === 'slide';
}

// ── Filtering ──────────────────────────────────────────────────────────────────────────

export function matchesSearch(row, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return `${row.name || ''} ${row.diagnosis || ''}`.toLowerCase().includes(q);
}

export function matchesStatus(row, status) {
  if (!status || status === 'All') return true;
  return (row.status || DEFAULT_STATUS) === status;
}

// Search applies to everything; the status filter applies only to slides. A folder has no status,
// and hiding it would strand its contents behind a filter that cannot describe them — the user
// would see an empty level and conclude the slides are gone.
export function filterRows(rows, { search = '', status = 'All' } = {}) {
  return (rows || []).filter(
    (r) => matchesSearch(r, search) && (isSlideRow(r) ? matchesStatus(r, status) : true),
  );
}

// Folders before slides, whatever the active sort. A Girder folder can hold sub-folders and
// items side by side, so sorting purely on the sort column interleaves them and a folder ends up
// stranded between two slides — the one place in the list where clicking descends rather than
// opens. Every file manager groups by kind first for this reason; the column sort then applies
// within each group. Passed to @tanstack/react-table as a custom sortingFn.
export function foldersFirst(rowA, rowB, columnId) {
  const a = rowA.original, b = rowB.original;
  if (isSlideRow(a) !== isSlideRow(b)) return isSlideRow(a) ? 1 : -1;
  const va = rowA.getValue(columnId), vb = rowB.getValue(columnId);
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true });
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────

const UNITS = [
  [1e9, 'GB'],
  [1e6, 'MB'],
  [1e3, 'kB'],
];

// Decimal units, not binary: a WSI's size is quoted in GB everywhere else in pathology, and
// 2.1 GB is the number a user can check against the scanner's output.
export function fmtSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  for (const [scale, unit] of UNITS) {
    if (bytes >= scale) {
      const v = bytes / scale;
      // A whole number keeps no decimal point: "3 GB", not "3.0 GB".
      return `${v % 1 === 0 ? v : v.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} B`;
}

// MM-DD. Inside a working set everything is from the last few weeks, so the year is noise; the
// full timestamp lives in the row's title attribute for when it is actually wanted.
export function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}
