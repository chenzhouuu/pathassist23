// src/api/tissueApi.js — Tissue map gateway client (Inc 4, Route B).
// Mirrors biomarkerApi: the panel drives the tissue service's own job/artifact control plane
// (POST /slides/{item}/tissue → poll /slides/{item}/artifacts) and reads tiles through an
// authenticated proxy. Imagery never comes through this module — OpenSeadragon fetches tiles
// directly from the URL built by tileUrl(), which is why that helper lives here too.
const COPILOT_BASE = (import.meta.env.VITE_COPILOT_API_URL || '/api/copilot').replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = localStorage.getItem('girderToken');
  return { ...(token ? { 'Girder-Token': token } : {}), ...extra };
}

function describeError(status, detail, what) {
  if (status === 401) {
    return "Girder rejected the session (401) — the copilot service's AGENT_GIRDER_BASE "
      + `must match the Girder your viewer is signed into. ${detail}`;
  }
  if (status === 422) return 'No Girder token found in this browser — sign in again.';
  if (status === 503) {
    return 'Tissue segmentation is unavailable (503) — the tissue service has no segmentation '
      + `weights, or is not configured (AGENT_TISSUE_SERVICE_URL). ${detail}`;
  }
  if (status === 502) return `Could not reach the tissue worker (502). ${detail}`;
  return `${what} failed (${status})${detail ? ` — ${detail}` : ''}`;
}

async function asJson(r, what) {
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(describeError(r.status, detail, what));
  }
  return r.json();
}

// Backends, their class lists and palettes, straight from the service — so the UI never hardcodes
// a class set that the deployed backend might not actually predict.
export async function getTissueCatalog() {
  const r = await fetch(`${COPILOT_BASE}/tissue/catalog`, { headers: authHeaders() });
  return asJson(r, 'Load tissue catalog');
}

// Enqueue a build. `bbox: null` means the whole slide — the same route, the same pipeline, the
// same artifact. Returns the durable artifact row to poll via listArtifacts().
export async function startTissue(itemId, { seg_hash, bbox = null, backend = null } = {}) {
  const r = await fetch(`${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/tissue`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ seg_hash, bbox, backend }),
  });
  return asJson(r, 'Start tissue segmentation');
}

// Ask a running build to stop at its next core-tile boundary. Returns the job's *current* status:
// the worker finishes the tile it is on first, so this resolves while the job is still `running`
// with stage `stopping`, and the panel learns the rest from its next poll. Everything already
// computed stays on disk — starting the same build again resumes from there.
export async function cancelTissue(itemId, artHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/tissue/${encodeURIComponent(artHash)}/cancel`,
    { method: 'POST', headers: authHeaders() },
  );
  return asJson(r, 'Stop tissue segmentation');
}

// Backend, class list, layer geometry, coverage and composition for a built artifact.
export async function getTissueMeta(itemId, artHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/tissue/${encodeURIComponent(artHash)}/meta`,
    { headers: authHeaders() },
  );
  if (r.status === 404) return null;
  return asJson(r, 'Load tissue map metadata');
}

// Class composition for a sub-rectangle (bbox = {x, y, width, height}) or the whole artifact.
export async function getTissueStats(itemId, artHash, bbox = null) {
  const qs = bbox
    ? `?bbox=${[bbox.x, bbox.y, bbox.width, bbox.height].map((n) => Math.round(n)).join(',')}`
    : '';
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/tissue/${encodeURIComponent(artHash)}/stats${qs}`,
    { headers: authHeaders() },
  );
  if (r.status === 404) return null;
  return asJson(r, 'Load tissue composition');
}

// The tile URL OpenSeadragon fetches directly. No token in the query string: the layer is mounted
// with `loadTilesWithAjax` + `ajaxHeaders`, so tiles authenticate with the same header as every
// other call and the gateway needs no second auth surface.
export function tileUrl(itemId, artHash, layer, level, x, y, params = {}) {
  const qs = new URLSearchParams(params);
  return `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/tissue/`
    + `${encodeURIComponent(artHash)}/tile/${layer}/${level}/${x}/${y}.png?${qs.toString()}`;
}

// The headers OSD must send for tile requests (see tileUrl).
export function tileAjaxHeaders() {
  const token = localStorage.getItem('girderToken');
  return token ? { 'Girder-Token': token } : {};
}
