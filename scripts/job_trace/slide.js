// slide.js — the slide, its artifacts, and the map you draw a rectangle on.

import { blob, get } from './api.js';
import { CORE, coresFor, makeMap } from './canvas.js';
import { $, S } from './state.js';

export const map = makeMap($('map'), { onRegion });

function onRegion(r) {
  S.roi = r;
  if (!r) { $('region-out').textContent = '还没画。'; return; }
  const cores = coresFor(r, S.meta?.core);
  const px = r.width * r.height;
  const got = cores.length * CORE * CORE;
  const perPx = Math.round(S.slide.width / $('map').width);
  $('region-out').innerHTML = `你画的：<code>${r.x}, ${r.y}, ${r.width}×${r.height}</code>`
    + `（${px.toLocaleString()} px²）<br>它会算：<b>${cores.length}</b> 块核心瓦片`
    + `（${got.toLocaleString()} px²，<b>${(got / px).toFixed(1)} 倍</b>）`
    + ` — ${cores.map(c => `(${c[0]},${c[1]})`).join(' ')}`
    + `<br><span class="muted">缩略图上 1 px ≈ ${perPx} 个切片像素，所以这里画的框本身就是粗的；`
    + '真正决定范围的是上面那几块核心瓦片。</span>';
}

export async function loadSlide() {
  S.item = $('item').value.trim();
  localStorage.setItem('jobTraceItem', S.item);
  const tiles = await get(`/api/v1/item/${S.item}/tiles`);
  if (!tiles.ok) { $('slide-out').textContent = `拿不到切片信息（${tiles.status}）`; return; }
  S.slide = { width: tiles.data.sizeX, height: tiles.data.sizeY };
  const thumb = await blob(
    `/api/v1/item/${S.item}/tiles/thumbnail?width=520&height=520&encoding=PNG`);
  map.setSlide(S.slide, thumb);
  $('slide-out').innerHTML = `${S.slide.width.toLocaleString()} × `
    + `${S.slide.height.toLocaleString()} px · ${tiles.data.magnification || '?'}× · `
    + `mpp ${(tiles.data.mm_x * 1000).toFixed(4)}`;
  await refresh();
  await loadCatalog();
}

/** Re-read what this slide has. Called after every dispatch, which is why it replaces its text. */
export async function refresh() {
  const r = await get(`/api/copilot/slides/${S.item}/artifacts`);
  S.artifacts = r.data?.artifacts || [];
  S.art = S.artifacts.find(a => a.kind === 'nuclei')?.art_hash || null;
  S.meta = null;
  if (S.art) {
    const m = await get(`/api/copilot/slides/${S.item}/nuclei/${S.art}/meta`);
    if (m.ok) S.meta = m.data;
  }
  map.setDone(S.meta?.coverage?.done || [], S.meta?.core);
  // Replaced, not appended: an append would leave the panel showing the slide's history as if it
  // were its state.
  $('art-out').innerHTML = `artifacts：${S.artifacts.map(a => a.kind).join('、') || '（空）'}`
    + (S.meta ? `<br>nuclei 覆盖 <b>${S.meta.coverage.done.length}</b> 块核心瓦片`
      + ` · ${S.meta.summary.n_nuclei.toLocaleString()} 个细胞`
      + ` · 命名 ${(S.meta.taxonomies || []).map(t => t.id).join(' / ')}` : '');
  return S.meta;
}

/** Which classifier heads this deployment has. Asked, not hardcoded — same call the panel makes. */
async function loadCatalog() {
  const c = await get('/api/copilot/nuclei/catalog');
  const heads = (c.data?.taxonomies || []).filter(t => t.produced_by === 'classifier');
  $('taxonomy').innerHTML = heads.map(t =>
    `<option value="${t.id}">${t.label} · ${t.organ}</option>`).join('');
}

/**
 * The counts for the naming that is actually being shown.
 *
 * Each taxonomy carries its **own** summary and its own coverage, and they legitimately differ:
 * the top-level `summary` is whatever the last run wrote, so reading the counts from there while
 * naming a different taxonomy above them prints PanNuke's classes under a NuCLS label. It also
 * hides the more interesting fact — a naming can cover fewer tiles than the artifact does,
 * because outlines were extended after that classifier last ran.
 */
export function countsHtml(meta) {
  if (!meta) return '没有 artifact。';
  const list = meta.taxonomies || [];
  const t = list.find(x => x.id === $('taxonomy').value)
    || list.find(x => x.id === meta.default_taxonomy) || list[0];
  const s = t?.summary || meta.summary || {};
  const lag = (meta.coverage?.done?.length || 0) - (s.n_tiles || 0);
  return `这条 artifact 覆盖 <b>${meta.coverage.done.length}</b> 块核心瓦片<br>`
    + `<span class="muted">命名 <b>${t?.id || '—'}</b>：`
    + `${(s.n_nuclei || 0).toLocaleString()} 个细胞 · ${(s.area_mm2 || 0).toFixed(2)} mm² · `
    + Object.entries(s.counts_by_class || {})
      .map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')
    + (lag > 0
      ? `<br>还有 ${lag} 块核心瓦片有轮廓、但这套命名没跑到 —— `
        + '轮廓是在它跑完之后才扩出去的，再跑一次这个模型就补上。'
      : '')
    + '</span>';
}
