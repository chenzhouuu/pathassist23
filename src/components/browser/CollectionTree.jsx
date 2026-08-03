// src/components/browser/CollectionTree.jsx
// The permanent left rail: every collection, expandable down to folder level, and any node in it
// openable. It answers "where can I go"; the table beside it answers "what is here".
//
// WHY SLIDES ARE NOT IN THE TREE. Girder puts sub-folders and items at the same level, so the
// rail could show slides too — and it deliberately does not. A rail that lists slides is a second
// copy of the table, which makes it long enough to need scrolling past the one collection you
// wanted and makes clicking a row ambiguous: does it move the table or open the viewer? Keeping
// the rail to containers means every node in it does exactly one thing, and the deepest branch in
// this instance stays forty rows rather than several hundred.
//
// WHY EXPANSION IS NOT NAVIGATION. Which branches are open lives here, in the rail, and is not
// part of `useBrowseNavigation`'s `(collection, path)` pair. They look like the same thing on a
// first read and they are not: collapsing the branch you are standing in must leave the table
// exactly where it is, and the classic file-tree bug is a single piece of state that makes the
// twist-down and the current directory the same fact. So the two are wired in one direction only
// — navigating is an *input* to expansion, through the effect below that opens the ancestors of
// wherever the table has landed, and expansion is never an input to navigation. Nothing outside
// the rail reads this state, which is the other reason it is not in the hook: BrowserPage is
// still growing a grid view and a resizable preview, and this is not state they need to see.
//
// Children are fetched per branch on first expansion, under the same query key BrowserPage uses
// for the folder level, so walking down through the table and opening the same branch in the rail
// share one cache entry instead of issuing the request twice.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { getCollections, getFolders } from '../../api/index.js';
import { toFolderRow } from './browseUtils.js';

/**
 * The rail.
 *
 * @param {object}   props
 * @param {object?}  props.collection — the collection the table is inside, or null at the root.
 * @param {object[]} props.path       — the folder docs from that collection down to the table's
 *                                      current level; together with `collection` this is exactly
 *                                      `useBrowseNavigation`'s position.
 * @param {(collection: object|null, path: object[]) => void} props.onNavigate — moves the table.
 */
export default function CollectionTree({ collection, path = [], onNavigate }) {
  // Girder ids are ObjectIds and unique across collections and folders alike, so one flat set of
  // ids is enough to say which branches are open; there is no need to key by kind or by ancestry.
  const [expanded, setExpanded] = useState(() => new Set());

  const toggle = useCallback((id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);

  const open = useCallback((ids) => setExpanded((prev) => {
    if (ids.every((id) => prev.has(id))) return prev;   // no new set, so no re-render
    const next = new Set(prev);
    for (const id of ids) next.add(id);
    return next;
  }), []);

  // The chain of ids from the collection down to where the table is pointing. The last of them is
  // the node to mark.
  const trail = useMemo(
    () => (collection ? [collection._id, ...path.map((f) => f._id)] : []),
    [collection, path],
  );
  const trailKey = trail.join('/');
  const currentId = trail.length ? trail[trail.length - 1] : null;

  // The one direction the sync runs: the table (or the breadcrumb, or Backspace) has moved, so
  // open whatever is needed to reveal where it landed. Held in a ref and keyed on the flattened
  // trail so the effect fires on a change of *location* and on nothing else — in particular not
  // when `expanded` changes, which is what lets a collapse of the current branch stay collapsed.
  const trailRef = useRef(trail);
  trailRef.current = trail;
  useEffect(() => {
    if (trailRef.current.length) open(trailRef.current);
  }, [trailKey, open]);

  const collections = useQuery({ queryKey: ['browser', 'collections'], queryFn: getCollections });

  return (
    <nav className="browser-tree" aria-label="Collections">
      <h2 className="browser-tree-heading" id="browser-tree-heading">Collections</h2>
      <ul className="browser-tree-list" role="tree" aria-labelledby="browser-tree-heading">
        {(collections.data || []).map((c) => (
          <TreeNode
            key={c._id}
            collection={c}
            folders={[]}
            expanded={expanded}
            currentId={currentId}
            onToggle={toggle}
            onOpen={open}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
      {collections.isLoading && <p className="browser-tree-note">Loading…</p>}
      {collections.error && <p className="browser-tree-note">Could not load collections.</p>}
    </nav>
  );
}

/**
 * One node and, when it is open, its folder children.
 *
 * `folders` is the chain of folder docs from `collection` down to and including this node, and is
 * empty for a collection node. Carrying the whole chain rather than a parent id is what lets a
 * click hand `onNavigate` a complete position without the rail having to walk back up the tree.
 */
function TreeNode({ collection, folders, expanded, currentId, onToggle, onOpen, onNavigate }) {
  const self = folders.length ? folders[folders.length - 1] : collection;
  const isExpanded = expanded.has(self._id);
  const isCurrent = self._id === currentId;

  // Deliberately the same key shape and the same fetch BrowserPage runs for the folder level:
  // `['browser', 'folders', collectionId, folderId]`, with the folder id absent at the top of a
  // collection. Sharing the key is what stops the rail and the table asking for the same list
  // twice when you walk into a branch that is already open.
  const parentId = folders.length ? self._id : undefined;
  const children = useQuery({
    queryKey: ['browser', 'folders', collection._id, parentId],
    queryFn: () => (parentId ? getFolders('folder', parentId) : getFolders('collection', collection._id)),
    enabled: isExpanded,
  });

  // Leafness is not knowable until the branch has been opened once — Girder's folder document
  // carries no child count — so the caret shows until a fetch comes back empty and only then
  // fades out. It fades rather than unmounts so the labels either side of it stay on one line.
  const kids = children.data || [];
  const isLeaf = children.isSuccess && kids.length === 0;

  // The count Girder has computed, or null where it has not. `toFolderRow` already owns the
  // distinction between "no items" and "not counted" for the table, and the rail asks it rather
  // than re-deriving it: two answers to the same question would eventually disagree.
  const { count } = toFolderRow(self);

  const navigate = () => {
    // Opening a node also reveals what is under it, which is what a nav rail is for. It never
    // collapses: the caret is the control for that, so a click on the label cannot take away the
    // children the same click just asked to see.
    onOpen(folders.length ? [collection._id, ...folders.map((f) => f._id)] : [collection._id]);
    onNavigate(collection, folders);
  };

  // Clicks and keys are handled on the treeitem itself, which is also what holds focus, so every
  // one of them is stopped from bubbling: without this, activating a child would run its parent's
  // handler on the way up and navigate to the parent instead.
  const onClick = (e) => { e.stopPropagation(); navigate(); };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation(); navigate();
    } else if (e.key === 'ArrowRight' && !isExpanded && !isLeaf) {
      e.preventDefault(); e.stopPropagation(); onToggle(self._id);
    } else if (e.key === 'ArrowLeft' && isExpanded) {
      e.preventDefault(); e.stopPropagation(); onToggle(self._id);
    }
  };

  return (
    <li
      className="browser-tree-item"
      role="treeitem"
      tabIndex={0}
      aria-expanded={isLeaf ? undefined : isExpanded}
      aria-current={isCurrent ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="browser-tree-node" data-current={isCurrent ? '' : undefined}>
        <span
          className="browser-tree-caret"
          data-open={isExpanded ? '' : undefined}
          data-leaf={isLeaf ? '' : undefined}
          aria-hidden="true"
          onClick={(e) => { e.stopPropagation(); onToggle(self._id); }}
        >
          <ChevronRight size={13} />
        </span>
        <span className="browser-tree-label">{self.name}</span>
        {/* An em dash is a placeholder for a number nobody has computed, and reading it aloud as
            "em dash" says less than saying nothing, so only a real count is announced. */}
        <span className="browser-tree-count" aria-hidden={count === null ? 'true' : undefined}>
          {count === null ? '—' : count}
        </span>
      </div>

      {isExpanded && (
        <ul className="browser-tree-children" role="group">
          {kids.map((f) => (
            <TreeNode
              key={f._id}
              collection={collection}
              folders={[...folders, f]}
              expanded={expanded}
              currentId={currentId}
              onToggle={onToggle}
              onOpen={onOpen}
              onNavigate={onNavigate}
            />
          ))}
          {children.isLoading && <li className="browser-tree-note" role="none">Loading…</li>}
        </ul>
      )}
    </li>
  );
}
