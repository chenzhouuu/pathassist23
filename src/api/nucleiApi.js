// src/api/nucleiApi.js — the nuclei artifact's control plane (Inc 5).
//
// Separate from the stateless `/segment` call the agent makes (wsiAnalysis.js): that one answers
// "what is in this box" and returns; this one builds a stored artifact the Workspace lists and the
// viewer draws. Same gateway, same Girder session, different lifetime.
// Each api module carries its own base + auth + refusal vocabulary, like tissueApi and
// biomarkerApi do — the refusals are what differ, and they are what a user actually reads.
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
    return 'Nuclei segmentation is unavailable (503) — the cellvit service has no weights, or is '
      + `not configured (AGENT_CELLVIT_SERVICE_URL). ${detail}`;
  }
  if (status === 502) return `Could not reach the nuclei worker (502). ${detail}`;
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

// Enqueue a nuclei build over a region. Returns the durable artifact row (status `queued`), which
// the panel then polls through listArtifacts like every other kind.
export async function startNuclei(itemId, { bbox } = {}) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/nuclei`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ bbox: bbox || null }),
    },
  );
  return asJson(r, 'Start nuclei');
}

// The artifact's own meta: slide dims, mpp, store resolution, class list, coverage and summary.
// Everything the panel reports comes from here, so a number on screen is a number off disk.
export async function getNucleiMeta(itemId, artHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/nuclei/${encodeURIComponent(artHash)}/meta`,
    { headers: authHeaders() },
  );
  return asJson(r, 'Load nuclei artifact');
}

// The tile URL OpenSeadragon fetches directly. No token in the query string: the layer is mounted
// with `loadTilesWithAjax` + `ajaxHeaders`, so tiles authenticate with the same header as every
// other call and the gateway needs no second auth surface.
export function tileUrl(itemId, artHash, layer, level, x, y, params = {}) {
  const qs = new URLSearchParams(params);
  return `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/nuclei/`
    + `${encodeURIComponent(artHash)}/tile/${layer}/${level}/${x}/${y}.png?${qs.toString()}`;
}

// The headers OSD must send for tile requests (see tileUrl).
export function tileAjaxHeaders() {
  const token = localStorage.getItem('girderToken');
  return token ? { 'Girder-Token': token } : {};
}
