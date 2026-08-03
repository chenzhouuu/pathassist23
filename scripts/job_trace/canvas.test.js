// The rounding claim the console is built to make, pinned.
//
// `coresFor` is the whole of "you drew this, the run computes that": every number the page quotes
// about the difference — the tile list, the px², the multiplier — comes out of it. It is also the
// one piece of this tool that restates a rule owned by another process (the cellvit service's
// 2048 px storage grid), so it is the piece most able to drift without anyone noticing.

import { describe, expect, it } from 'vitest';

import { CORE, coresFor } from './canvas.js';

const box = (x, y, width, height) => ({ x, y, width, height });

describe('which core tiles a drawn rectangle costs', () => {
  it('is one tile when the rectangle sits inside one', () => {
    expect(coresFor(box(100, 100, 200, 200))).toEqual([[0, 0]]);
  });

  it('is two when it crosses a vertical boundary', () => {
    expect(coresFor(box(2000, 100, 100, 100))).toEqual([[0, 0], [1, 0]]);
  });

  it('is four when it crosses a corner — the worst case a small box can reach', () => {
    expect(coresFor(box(2000, 2000, 100, 100)))
      .toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it('does not count the tile a rectangle only touches the edge of', () => {
    // Exactly one tile wide, starting exactly on a boundary: the far edge lands on the *next*
    // tile's first pixel, which the run does not compute. An off-by-one here would silently
    // double every quoted cost.
    expect(coresFor(box(CORE, CORE, CORE, CORE))).toEqual([[1, 1]]);
  });

  it('costs nothing for a rectangle with no area', () => {
    expect(coresFor(box(100, 100, 0, 50))).toEqual([]);
    expect(coresFor(box(100, 100, 50, 0))).toEqual([]);
    expect(coresFor(null)).toEqual([]);
  });

  it('honours a grid the artifact reports instead of the default', () => {
    // The service tells the page its own `core`; the constant here is only the fallback for a
    // slide that has no artifact yet.
    expect(coresFor(box(0, 0, 1500, 100), 512)).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it('rounds outwards, never inwards', () => {
    // The property the tool exists to show: what runs always contains what was drawn.
    const drawn = box(5800, 8600, 900, 700);
    const cores = coresFor(drawn);
    const xs = cores.map(c => c[0]);
    const ys = cores.map(c => c[1]);
    expect(Math.min(...xs) * CORE).toBeLessThanOrEqual(drawn.x);
    expect(Math.min(...ys) * CORE).toBeLessThanOrEqual(drawn.y);
    expect((Math.max(...xs) + 1) * CORE).toBeGreaterThanOrEqual(drawn.x + drawn.width);
    expect((Math.max(...ys) + 1) * CORE).toBeGreaterThanOrEqual(drawn.y + drawn.height);
  });
});
