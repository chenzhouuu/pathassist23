// src/api/biomarkerApi.js — Markers map gateway client (Inc 3b).
// Mirrors preprocessApi's base + Girder-Token auth. This panel is deliberately independent of the
// copilot conversation: it drives the biomarker service's own job/artifact control plane
// (POST /slides/{item}/biomarker → poll /slides/{item}/artifacts) and reads tiles through an
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
    return 'Marker analysis is unavailable (503) — the biomarker service has no GigaTIME-Flash '
      + `weights, or is not configured (AGENT_BIOMARKER_SERVICE_URL). ${detail}`;
  }
  if (status === 502) return `Could not reach the biomarker worker (502). ${detail}`;
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

// Marker vocabulary, presets and the phenotype palette, straight from the service — so the UI
// never hardcodes biology that the model might not actually have.
export async function getCatalog() {
  const r = await fetch(`${COPILOT_BASE}/biomarker/catalog`, { headers: authHeaders() });
  return asJson(r, 'Load marker catalog');
}

// Enqueue a map build. `bbox: null` means the whole slide — the same route, the same pipeline,
// the same artifact (D5/D6). Returns the durable artifact row to poll via listArtifacts().
export async function startBiomarker(
  itemId, { seg_hash = null, nuclei_hash = null, bbox = null } = {}, mode,
) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/biomarker`
    + (mode ? `?mode=${mode}` : ''), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    // `nuclei_hash` names the cells the phenotypes attach to (Inc 5 · D9): a phenotype is an
    // attribute of a nucleus. Left null it is *planned* rather than refused (Inc 6 · 08).
    body: JSON.stringify({ seg_hash, nuclei_hash, bbox }),
  });
  return asJson(r, 'Start marker analysis');
}

// Layer geometry, thresholds, coverage and whole-map counts for a built artifact.
export async function getBiomarkerMeta(itemId, artHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/biomarker/${encodeURIComponent(artHash)}/meta`,
    { headers: authHeaders() },
  );
  if (r.status === 404) return null;
  return asJson(r, 'Load marker map metadata');
}

// The tile URL OpenSeadragon fetches directly. No token in the query string: the layer is mounted
// with `loadTilesWithAjax` + `ajaxHeaders: {'Girder-Token': ...}`, so tiles authenticate with the
// same header as every other call and the gateway needs no second auth surface.
export function tileUrl(itemId, artHash, layer, level, x, y, params = {}) {
  const qs = new URLSearchParams(params);
  return `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/biomarker/`
    + `${encodeURIComponent(artHash)}/tile/${layer}/${level}/${x}/${y}.png?${qs.toString()}`;
}

// The headers OSD must send for tile requests (see tileUrl).
export function tileAjaxHeaders() {
  const token = localStorage.getItem('girderToken');
  return token ? { 'Girder-Token': token } : {};
}
