// The collection rail (Graphite · 07). What is worth asserting is the seam the rail is built on:
// expansion and navigation are two pieces of state, wired one way only. So the pair of tests that
// matter most are the two that would both pass if it were one piece of state and the design were
// wrong — collapsing the branch you are inside must not move the table, and moving the table must
// open the branch you land in.
import React, { useState } from 'react';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/index.js', () => ({ getCollections: vi.fn(), getFolders: vi.fn() }));

import CollectionTree from './CollectionTree.jsx';
import { getCollections, getFolders } from '../../api/index.js';

// Two collections: one uncounted, the way every folder in this instance actually is, and one
// carrying a number, which is the case the em-dash rule exists to be distinguished from.
const BRCA = { _id: 'c1', name: 'BRCA-DEMO' };
const PENN = { _id: 'c2', name: 'Penn Pathology', nItems: 40 };
const DEMO = { _id: 'f1', name: 'DEMO' };
const SLIDES = { _id: 'f2', name: 'slides' };
const BLOCK = { _id: 'f3', name: 'Block A' };

// `staleTime` mirrors main.jsx rather than taking the library default: whether a second observer
// on the same key revalidates is a property of that number, and a client configured differently
// from the app's would make the shared-cache test below assert something the app does not do.
const client = () => new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

/** Renders the rail on its own, with a rerender that keeps the same cache. */
const render = (props = {}) => {
  const qc = client();
  const ui = (p) => (
    <QueryClientProvider client={qc}>
      <CollectionTree collection={null} path={[]} onNavigate={() => {}} {...p} />
    </QueryClientProvider>
  );
  const utils = rtlRender(ui(props));
  return { ...utils, rerender: (p = {}) => utils.rerender(ui({ ...props, ...p })) };
};

// A harness that owns the position the way BrowserPage does, so a test can move the table and
// watch the rail follow. The second query is BrowserPage's own folder query, copied key for key.
function TableFolderQuery({ collection, path }) {
  const folder = path[path.length - 1] || null;
  useQuery({
    queryKey: ['browser', 'folders', collection?._id, folder?._id],
    queryFn: () => (folder ? getFolders('folder', folder._id) : getFolders('collection', collection._id)),
    enabled: !!collection,
  });
  return null;
}

function Harness({ start = { collection: null, path: [] }, onNavigate }) {
  const [pos, setPos] = useState(start);
  return (
    <>
      <button type="button" onClick={() => setPos({ collection: BRCA, path: [DEMO] })}>
        walk the table into DEMO
      </button>
      <TableFolderQuery {...pos} />
      <CollectionTree
        collection={pos.collection}
        path={pos.path}
        onNavigate={(c, p) => { setPos({ collection: c, path: p }); onNavigate?.(c, p); }}
      />
    </>
  );
}

const renderHarness = (props = {}) => rtlRender(
  <QueryClientProvider client={client()}><Harness {...props} /></QueryClientProvider>,
);

// Found by label rather than by accessible name: an expanded node's name includes its whole
// subtree, and a test that reads "BRCA-DEMO DEMO slides" is a test about name computation.
const node = (name) => screen.getByText(name, { selector: '.browser-tree-label' }).closest('[role="treeitem"]');
const caretIn = (name) => node(name).querySelector(':scope > .browser-tree-node > .browser-tree-caret');

beforeEach(() => {
  getCollections.mockResolvedValue([BRCA, PENN]);
  getFolders.mockImplementation(async (parentType, parentId) => {
    if (parentType === 'collection' && parentId === 'c1') return [DEMO, SLIDES];
    if (parentType === 'folder' && parentId === 'f1') return [BLOCK];
    return [];
  });
});

describe('CollectionTree — what it lists', () => {
  it('lists every collection, and no slides: the rail answers where you can go', async () => {
    render();
    await screen.findByText('BRCA-DEMO');
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  });

  it('renders a count where Girder computed one and an em dash where it did not', async () => {
    render();
    await screen.findByText('BRCA-DEMO');
    // "0" here would read as "this is empty, skip it", which is a different and false statement.
    expect(within(node('BRCA-DEMO')).getByText('—')).toBeInTheDocument();
    expect(within(node('Penn Pathology')).getByText('40')).toBeInTheDocument();
  });
});

describe('CollectionTree — fetching', () => {
  it('leaves a branch unfetched until it is first expanded', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('BRCA-DEMO');
    expect(getFolders).not.toHaveBeenCalled();

    await user.click(caretIn('BRCA-DEMO'));
    await screen.findByText('DEMO');
    expect(getFolders).toHaveBeenCalledTimes(1);
    expect(getFolders).toHaveBeenCalledWith('collection', 'c1');
  });

  it('goes on down: a folder fetches its own sub-folders when opened', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('BRCA-DEMO');
    await user.click(caretIn('BRCA-DEMO'));
    await user.click(await screen.findByText('DEMO'));

    expect(await screen.findByText('Block A')).toBeInTheDocument();
    expect(getFolders).toHaveBeenCalledWith('folder', 'f1');
  });

  it('shares the table\'s folder query instead of asking for the same list twice', async () => {
    // Same key, so revealing the branch the table is already in costs no request at all. If the
    // rail ever invents a key of its own, this count goes to two.
    renderHarness({ start: { collection: BRCA, path: [] } });
    await screen.findByText('DEMO');
    expect(getFolders).toHaveBeenCalledTimes(1);
  });
});

describe('CollectionTree — clicking a node moves the table', () => {
  it('hands over the whole position: collection and folder chain', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render({ onNavigate });
    await screen.findByText('BRCA-DEMO');

    await user.click(screen.getByText('BRCA-DEMO'));
    expect(onNavigate).toHaveBeenCalledWith(BRCA, []);

    // The same click opened the branch, so the folder under it is there to be clicked next.
    await user.click(await screen.findByText('DEMO'));
    expect(onNavigate).toHaveBeenLastCalledWith(BRCA, [DEMO]);
  });

  it('activates on Enter, and on Space', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render({ onNavigate });
    await screen.findByText('BRCA-DEMO');

    node('BRCA-DEMO').focus();
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith(BRCA, []);

    node('Penn Pathology').focus();
    await user.keyboard(' ');
    expect(onNavigate).toHaveBeenLastCalledWith(PENN, []);
  });
});

describe('CollectionTree — expansion is not navigation', () => {
  it('does not move the table when the branch you are standing in is collapsed', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render({ collection: BRCA, path: [DEMO], onNavigate });

    // Landing here revealed the branch; nothing was clicked to do it.
    expect(await screen.findByText('DEMO')).toBeInTheDocument();

    await user.click(caretIn('BRCA-DEMO'));
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument();
    // The table has not been asked to go anywhere, and the rail still knows where it is.
    expect(onNavigate).not.toHaveBeenCalled();
    expect(node('BRCA-DEMO')).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays collapsed through a re-render, because a re-render is not a move', async () => {
    const user = userEvent.setup();
    const { rerender } = render({ collection: BRCA, path: [DEMO] });
    await screen.findByText('DEMO');
    await user.click(caretIn('BRCA-DEMO'));

    // Same position, freshly built array: an effect keyed on the trail's identity rather than on
    // its contents would re-open the branch here, which is the bug this asserts against.
    rerender({ collection: BRCA, path: [DEMO] });
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument();
  });
});

describe('CollectionTree — the table moves the tree', () => {
  it('expands to reveal where the table landed, and marks it', async () => {
    const user = userEvent.setup();
    renderHarness();
    await screen.findByText('BRCA-DEMO');
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /walk the table/ }));

    expect(await screen.findByText('DEMO')).toBeInTheDocument();
    expect(node('DEMO')).toHaveAttribute('aria-current', 'true');
    expect(node('BRCA-DEMO')).not.toHaveAttribute('aria-current');
    expect(node('BRCA-DEMO')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('CollectionTree — a shallow tree', () => {
  it('drops the caret on a branch that turned out to be empty, keeping the labels aligned', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('Penn Pathology');

    await user.click(caretIn('Penn Pathology'));
    await waitFor(() => expect(caretIn('Penn Pathology')).toHaveAttribute('data-leaf'));
    // It is no longer expandable, so it no longer claims to be.
    expect(node('Penn Pathology')).not.toHaveAttribute('aria-expanded');
  });
});
