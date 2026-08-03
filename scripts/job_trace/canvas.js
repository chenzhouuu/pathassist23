// canvas.js — the two pictures.
//
// The first one is the whole point of this console: the rectangle you dragged and the core tiles
// the run actually computes, drawn in the same coordinate system so the difference is a thing you
// see rather than a sentence you are asked to believe.
//
// The second composites the H&E crop of what was computed with the nuclei layer's own tiles, so
// "it finished" is checked against pixels instead of against a status code.

/** The storage grid, mirrored from the cellvit service's own constant. One copy, exported. */
export const CORE = 2048;

/** Which core tiles a slide rectangle touches — the run's real extent. */
export function coresFor(r, core = CORE) {
  if (!r || r.width <= 0 || r.height <= 0) return [];
  const out = [];
  for (let ty = Math.floor(r.y / core); ty <= Math.floor((r.y + r.height - 1) / core); ty++) {
    for (let tx = Math.floor(r.x / core); tx <= Math.floor((r.x + r.width - 1) / core); tx++) {
      out.push([tx, ty]);
    }
  }
  return out;
}

export function makeMap(canvas, { onRegion }) {
  const ctx = canvas.getContext('2d');
  let slide = null;         // {width, height}
  let img = null;           // thumbnail
  let done = [];            // cores already on disk
  let core = CORE;
  let roi = null;
  let dragging = null;

  function fit() {
    if (!slide) return { s: 1, ox: 0, oy: 0 };
    const s = Math.min(canvas.width / slide.width, canvas.height / slide.height);
    return { s, ox: (canvas.width - slide.width * s) / 2, oy: (canvas.height - slide.height * s) / 2 };
  }

  function toSlide(ev) {
    const r = canvas.getBoundingClientRect();
    const { s, ox, oy } = fit();
    const cx = (ev.clientX - r.left) * (canvas.width / r.width);
    const cy = (ev.clientY - r.top) * (canvas.height / r.height);
    return {
      x: Math.max(0, Math.min(slide.width, Math.round((cx - ox) / s))),
      y: Math.max(0, Math.min(slide.height, Math.round((cy - oy) / s))),
    };
  }

  function box(t, c) {
    const { s, ox, oy } = fit();
    return [ox + c[0] * t * s, oy + c[1] * t * s, t * s, t * s];
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!slide) return;
    const { s, ox, oy } = fit();
    if (img) ctx.drawImage(img, ox, oy, slide.width * s, slide.height * s);

    ctx.fillStyle = 'rgba(107,118,132,.42)';
    for (const c of done) { const b = box(core, c); ctx.fillRect(b[0], b[1], b[2], b[3]); }

    if (roi) {
      const planned = coresFor(roi, core);
      ctx.fillStyle = 'rgba(92,200,255,.22)';
      ctx.strokeStyle = 'rgba(92,200,255,.9)';
      ctx.lineWidth = 1;
      for (const c of planned) {
        const b = box(core, c);
        ctx.fillRect(b[0], b[1], b[2], b[3]);
        ctx.strokeRect(b[0] + .5, b[1] + .5, b[2] - 1, b[3] - 1);
      }
      ctx.strokeStyle = '#ff5d5d';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + roi.x * s, oy + roi.y * s, roi.width * s, roi.height * s);
    }
  }

  canvas.addEventListener('mousedown', (ev) => {
    if (!slide) return;
    dragging = toSlide(ev);
    ev.preventDefault();
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const p = toSlide(ev);
    roi = norm(dragging, p);
    redraw();
  });
  window.addEventListener('mouseup', (ev) => {
    if (!dragging) return;
    const p = toSlide(ev);
    roi = norm(dragging, p);
    dragging = null;
    redraw();
    if (roi.width > 8 && roi.height > 8) onRegion?.(roi);
    else { roi = null; redraw(); onRegion?.(null); }
  });

  function norm(a, b) {
    return {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
    };
  }

  // No `getRoi`: the rectangle the run submits is the one in the page's own state, set from
  // `onRegion`. A second reader here would be a second source of truth, and the two would differ
  // the moment anything cleared one of them.
  return {
    setSlide(s, image) { slide = s; img = image; redraw(); },
    setDone(cores, coreSize) { done = cores || []; core = coreSize || CORE; redraw(); },
    setRoi(r) { roi = r; redraw(); },
    redraw,
  };
}

/**
 * The H&E crop of `rect`, with the nuclei layer's own tiles composited on top.
 *
 * Both are fetched as blobs rather than pointed at with `<img src>`: the tiles authenticate with
 * the `Girder-Token` header — there is deliberately no token in the query string — and an `<img>`
 * cannot send one.
 */
export async function drawResult(canvas, { blob, item, meta, artHash, taxonomy, rect }) {
  const ctx = canvas.getContext('2d');
  const aspect = rect.height / rect.width;
  canvas.height = Math.round(canvas.width * Math.min(aspect, 1.6));
  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const place = (sx, sy, sw, sh) => [
    ((sx - rect.x) / rect.width) * canvas.width,
    ((sy - rect.y) / rect.height) * canvas.height,
    (sw / rect.width) * canvas.width,
    (sh / rect.height) * canvas.height,
  ];

  const base = await blob(`/api/v1/item/${item}/tiles/region`
    + `?left=${rect.x}&top=${rect.y}&right=${rect.x + rect.width}&bottom=${rect.y + rect.height}`
    + `&width=${canvas.width}&encoding=PNG`);
  if (base) ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

  const layer = meta?.layers?.classes;
  if (!layer || !artHash) return { level: null, tiles: 0 };
  const levels = layer.levels;
  const scale = 2 ** (meta.level_offset || 0);      // slide px per layer px
  const tile = meta.tile || 256;

  // Coarsest level that still covers the crop in a handful of tiles. Ours run 0 = finest.
  let level = 0;
  while (level < levels - 1
         && Math.ceil(rect.width / scale / (tile * 2 ** level)) > 4) level++;
  const span = tile * 2 ** level * scale;           // slide px per tile at this level

  ctx.globalAlpha = 0.9;
  const jobs = [];
  for (let ty = Math.floor(rect.y / span); ty <= Math.floor((rect.y + rect.height - 1) / span); ty++) {
    for (let tx = Math.floor(rect.x / span); tx <= Math.floor((rect.x + rect.width - 1) / span); tx++) {
      const url = `/api/copilot/slides/${item}/nuclei/${artHash}/tile/classes/${level}/${tx}/${ty}.png`
        + `?taxonomy=${encodeURIComponent(taxonomy || meta.default_taxonomy || '')}`;
      jobs.push(blob(url).then((im) => {
        if (im) ctx.drawImage(im, ...place(tx * span, ty * span, span, span));
      }));
    }
  }
  await Promise.all(jobs);
  ctx.globalAlpha = 1;
  return { level, tiles: jobs.length };
}
