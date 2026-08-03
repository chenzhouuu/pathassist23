// The grid view (Graphite · 09). What is worth asserting is that this is a *view* and not a page:
// the whole claim of the segmented control is that switching it changes how the level is drawn and
// nothing else, so the tests that matter are the ones that would still pass if the grid were a
// second page and the design were wrong — the selection and the search surviving the switch, and
// the chosen view surviving a walk into a folder.
//
// It renders the real BrowserPage rather than SlideGrid on its own, because that is where the two
// claims live: the view mode is BrowserPage's state and the level change that must not clear it is
// `useBrowseNavigation`'s effect. A harness that re-implemented that wiring would be asserting
// against its own copy of the thing under test.
import React from 'react';
import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spread over the original rather than replaced wholesale: BrowserPage's import graph reaches this
// module from six files (ImportModal alone wants seven names), and a factory listing only what this
// test drives would fail at import time on the ones it forgot.
vi.mock('../../api/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getCollections: vi.fn(),
  getFolders: vi.fn(),
  getItems: vi.fn(),
  getTilesInfoSafe: vi.fn(),
  getThumbnailUrl: vi.fn(),
  updateItemMetadata: vi.fn(),
}));

import BrowserPage from './BrowserPage.jsx';
import { getCollections, getFolders, getItems, getThumbnailUrl, getTilesInfoSafe } from '../../api/index.js';

// jsdom has no IntersectionObserver, and every card holds one — the gate SlideThumb.jsx exports.
// The stub reports the element as visible immediately, which is what a card in a 1440px viewport
// would be anyway, and is what makes the thumbnail and the scan reading observable here at all.
class ImmediateObserver {
  constructor(cb) { this.cb = cb; }

  observe(el) { this.cb([{ target: el, isIntersecting: true }], this); }

  unobserve() {}

  disconnect() {}
}
globalThis.IntersectionObserver = ImmediateObserver;

const BRCA = { _id: 'c1', name: 'TCGA-BRCA' };
const SLIDES = { _id: 'f1', name: 'slides' };
// A sub-folder sitting beside the items, which Girder allows and this level therefore shows: it is
// what puts a folder card in the same wall as the slides.
const BLOCK = { _id: 'f2', name: 'Block A', nItems: 3 };

// The real thing, at its real length. 89 characters, dotted hex, not one space to break on.
const LONG_NAME = 'TCGA-3C-AAAU-01A-01-TS1.2F52DD63-7476-4E85-B7C6-E06092DB6CC1.a1b2c3d4e5f6a7b8c9d0e1f2.svs';

const slide = (id, name, extra = {}) => ({
  _id: id, name, size: 1_200_000_000, updated: '2026-07-01T00:00:00Z', largeImage: { fileId: 'x' }, ...extra,
});

const LONG = slide('i1', LONG_NAME, { meta: { status: 'Read' } });
const SHORT = slide('i2', 'TCGA-WT-AB44-01A-01-TS1.svs', { meta: { status: 'Flagged' } });
// An annotation file living in a slide folder: a Girder item with no tile source attached, which is
// the middle one of the three placeholder states.
const ANOT = { _id: 'i3', name: 'cellpose_test.anot', size: 2048, updated: '2026-07-01T00:00:00Z' };

const client = () => new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

const render = () => rtlRender(
  <QueryClientProvider client={client()}><BrowserPage /></QueryClientProvider>,
);

const gridButton = () => screen.getByRole('button', { name: 'Grid view' });
const tableButton = () => screen.getByRole('button', { name: 'Table view' });
const cards = () => Array.from(document.querySelectorAll('.browser-card'));
const frameIn = (card) => card.querySelector('.browser-card-image');

// Every name on this page appears twice — once in the collection rail and once in the level being
// listed — so every query here is scoped by the class of the thing it means. `rowName` is the
// table's name button, `cardName` the grid's, `crumb` the breadcrumb's tail.
const rowName = (name) => screen.getByText(name, { selector: '.browser-name-label' });
const cardName = (name) => screen.getByText(name, { selector: '.browser-card-name' });
const cardFor = (name) => cardName(name).closest('.browser-card');
const crumb = (name) => screen.findByText(name, { selector: '.browser-crumb.is-current' });

/** Walks the page down to TCGA-BRCA → slides, which is the level that holds all three card kinds. */
async function walkToSlides(user) {
  await user.click(await screen.findByText('TCGA-BRCA', { selector: '.browser-name-label' }));
  await user.click(await screen.findByText('slides', { selector: '.browser-name-label' }));
  await screen.findByText(LONG_NAME, { selector: '.browser-name-label' });
}

beforeEach(() => {
  getCollections.mockResolvedValue([BRCA]);
  getFolders.mockImplementation(async (parentType, parentId) => {
    if (parentType === 'collection' && parentId === 'c1') return [SLIDES];
    if (parentType === 'folder' && parentId === 'f1') return [BLOCK];
    return [];
  });
  getItems.mockResolvedValue([LONG, SHORT, ANOT]);
  getTilesInfoSafe.mockResolvedValue({ magnification: 40, mm_x: 0.0002519 });
  getThumbnailUrl.mockImplementation((id) => `/api/v1/item/${id}/tiles/thumbnail`);
});

describe('SlideGrid — the switch is a view, not a page', () => {
  it('keeps the previewed selection across table → grid → table', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);

    // Selected in the table, by clicking the row rather than the name — the name opens.
    const row = rowName(LONG_NAME).closest('tr');
    await user.click(row);
    expect(row).toHaveAttribute('data-selected');

    await user.click(gridButton());
    expect(cardFor(LONG_NAME)).toHaveAttribute('data-selected');
    expect(cardFor(SHORT.name)).not.toHaveAttribute('data-selected');

    await user.click(tableButton());
    expect(rowName(LONG_NAME).closest('tr')).toHaveAttribute('data-selected');
  });

  it('keeps the search, and the rows it had filtered down to', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);

    const search = screen.getByPlaceholderText(/search/i);
    await user.type(search, 'AB44');
    // The filter is debounced, so the table narrows a moment after the typing does.
    await waitFor(() => expect(screen.queryByText(LONG_NAME, { selector: '.browser-name-label' })).toBeNull(), { timeout: 2000 });

    await user.click(gridButton());
    expect(search).toHaveValue('AB44');
    expect(cards().map((c) => c.querySelector('.browser-card-name').textContent)).toEqual([SHORT.name]);
  });

  it('keeps the status filter', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);

    const filter = screen.getByLabelText('Filter by status');
    await user.selectOptions(filter, 'Flagged');
    await user.click(gridButton());

    expect(filter).toHaveValue('Flagged');
    // The folder stays: `filterRows` applies the status filter to slides only, because hiding a
    // folder behind a filter that cannot describe it strands everything inside it.
    expect(cards().map((c) => c.querySelector('.browser-card-name').textContent))
      .toEqual([BLOCK.name, SHORT.name]);
  });

  // The one the ticket's first checkbox is really about. `useBrowseNavigation` clears everything it
  // owns on a level change, so a view mode parked in that hook would silently snap back to the
  // table on every step into a folder. This fails if it ever moves there.
  it('keeps the chosen view when you walk into a folder', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('TCGA-BRCA', { selector: '.browser-name-label' });

    await user.click(gridButton());
    expect(document.querySelector('.browser-grid')).toBeInTheDocument();

    await user.click(cardName('TCGA-BRCA'));
    await screen.findByText('slides', { selector: '.browser-card-name' });
    expect(document.querySelector('.browser-grid')).toBeInTheDocument();
    expect(gridButton()).toHaveAttribute('aria-pressed', 'true');

    // And on down again, past the level change that clears the filters.
    await user.click(cardName('slides'));
    await screen.findByText(LONG_NAME, { selector: '.browser-card-name' });
    expect(document.querySelector('.browser-grid')).toBeInTheDocument();
  });

  it('hides the Columns menu in the grid, where a card has no columns', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('TCGA-BRCA', { selector: '.browser-name-label' });

    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
    await user.click(gridButton());
    expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
  });
});

describe('SlideGrid — what a click does', () => {
  it('opens on the name and only selects on the card', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    // The card body is not an open target: this click moves the preview and nothing else.
    await user.click(cardFor(BLOCK.name).querySelector('.browser-card-body'));
    expect(cardFor(BLOCK.name)).toHaveAttribute('data-selected');
    expect(await crumb('slides')).toBeInTheDocument();

    // The name is, and this one descends — the same rule as the table's name button.
    await user.click(cardName(BLOCK.name));
    expect(await crumb('Block A')).toBeInTheDocument();
  });

  it('opens on the image too, which is the mouse affordance for the same target', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    await user.click(frameIn(cardFor(BLOCK.name)));
    expect(await crumb('Block A')).toBeInTheDocument();
  });

  // Nested interactive elements are the trap this markup is shaped to avoid. A card that was itself
  // a button would put two buttons inside a button; React warns and the parser unnests them.
  it('puts no button inside a button', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    for (const b of document.querySelectorAll('.browser-grid button')) {
      expect(b.parentElement.closest('button')).toBeNull();
    }
    // One open target per card in the accessibility tree, as a table row has one: the image frame
    // duplicates the name for the mouse and is out of the tree and out of the tab order.
    const frame = frameIn(cardFor(SHORT.name));
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(frame).toHaveAttribute('tabindex', '-1');
  });
});

describe('SlideGrid — the image frame', () => {
  it('shows the thumbnail contained for a slide that has one', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    const frame = frameIn(cardFor(SHORT.name));
    expect(frame).toHaveAttribute('data-kind', 'image');
    expect(within(frame).getByRole('presentation', { hidden: true }))
      .toHaveAttribute('src', '/api/v1/item/i2/tiles/thumbnail');
  });

  // Three absences, three facts, three glyphs — the same rule scanFacts.js encodes for the Scan
  // column. One shared icon would assert that a folder, a stray file and a slide whose picture did
  // not arrive are the same kind of nothing.
  it('gives a folder, a non-slide item and a thumbnail-less slide three different placeholders', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    // The slide has a tile source, so its frame does ask for a thumbnail; the request is what
    // fails, which is the only way this state is reachable and the reason it is not the same
    // placeholder as the item that never had a picture to ask for.
    const slideFrame = frameIn(cardFor(SHORT.name));
    fireEvent.error(slideFrame.querySelector('img'));

    await waitFor(() => expect(slideFrame).toHaveAttribute('data-kind', 'slide'));
    expect(frameIn(cardFor(BLOCK.name))).toHaveAttribute('data-kind', 'folder');
    expect(frameIn(cardFor(ANOT.name))).toHaveAttribute('data-kind', 'file');

    const glyphs = [slideFrame, frameIn(cardFor(BLOCK.name)), frameIn(cardFor(ANOT.name))]
      .map((f) => f.querySelector('svg').outerHTML);
    expect(new Set(glyphs).size).toBe(3);
  });

  it('asks for no thumbnail at all for a folder or a non-slide item', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    expect(frameIn(cardFor(BLOCK.name)).querySelector('img')).toBeNull();
    expect(frameIn(cardFor(ANOT.name)).querySelector('img')).toBeNull();
    // And the /tiles round trip is skipped for both, the gate `wantsTiles` exists for.
    expect(getTilesInfoSafe.mock.calls.map(([id]) => id).sort()).toEqual(['i1', 'i2']);
  });
});

describe('SlideGrid — the caption', () => {
  it('reads the status chip and the scan parameters, and the item count for a folder', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    const card = cardFor(SHORT.name);
    expect(within(card).getByText('Flagged')).toHaveClass('browser-status');
    expect(await within(card).findByText('40× · 0.25 µm')).toHaveClass('browser-scan');

    expect(within(cardFor(BLOCK.name)).getByText('3 items')).toBeInTheDocument();
  });

  it('says "not a slide" rather than leaving a non-slide item blank', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    expect(within(cardFor(ANOT.name)).getByText('not a slide')).toHaveAttribute('data-kind', 'not-a-slide');
  });

  // An 89-character dotted hex string is the real worst case in this instance. Two things have to
  // hold, and only one of them is observable in jsdom: the name reaches the DOM whole — nothing
  // truncates it in JavaScript, so the title attribute and the search still see all of it — and the
  // element holding it is the one the stylesheet clamps. The clamp itself is layout, so the second
  // half is asserted against the partial that declares it; without this the rule could be deleted
  // and every DOM test here would still pass.
  it('lets an 89-character name reach the DOM whole, on an element the stylesheet clamps', async () => {
    const user = userEvent.setup();
    render();
    await walkToSlides(user);
    await user.click(gridButton());

    const name = screen.getByText(LONG_NAME, { selector: '.browser-card-name' });
    expect(LONG_NAME).toHaveLength(89);
    expect(name.textContent).toBe(LONG_NAME);
    expect(name).toHaveAttribute('title', LONG_NAME);

    // Read from the repo root, which is where vitest runs; `import.meta.url` is not a file URL
    // once the module has been through the transform.
    const css = readFileSync('src/styles/browser/_grid.css', 'utf8');
    const rule = css.slice(css.indexOf('.browser-card-name {'), css.indexOf('}', css.indexOf('.browser-card-name {')));
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/);
    // Without break-all a 40-character UUID with no spaces overflows the card instead of wrapping.
    expect(rule).toMatch(/word-break:\s*break-all/);
  });
});
