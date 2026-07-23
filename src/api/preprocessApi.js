// src/api/preprocessApi.js — Preprocess gateway client (Inc 2b Trident index control plane).
// Mirrors copilotApi's base + Girder-Token auth. The panel triggers a Trident feature-index
// build (POST /slides/{item}/preprocess) and polls its status (GET /slides/{item}/index); the
// resulting index is what Copilot's find_regions searches. Bulk arrays never come here — only
// the durable slide_index control rows (status, stage, progress, n_patches, feature_ref).
const COPILOT_BASE = (import.meta.env.VITE_COPILOT_API_URL || '/api/copilot').replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = localStorage.getItem('girderToken');
  return { ...(token ? { 'Girder-Token': token } : {}), ...extra };
}

// Name the actual failure mode so a Girder mismatch or a disabled service never reads as a
// generic error (parallels copilotApi.describeError).
function describeError(status, detail, what) {
  if (status === 401) {
    return "Girder rejected the session (401) — the copilot service's AGENT_GIRDER_BASE "
      + `must match the Girder your viewer is signed into. ${detail}`;
  }
  if (status === 422) return 'No Girder token found in this browser — sign in again.';
  if (status === 503) {
    return 'Preprocessing is unavailable (503) — the preprocess service is not configured '
      + `(AGENT_PREPROCESS_SERVICE_URL). ${detail}`;
  }
  if (status === 502) return `Could not reach the preprocess worker (502). ${detail}`;
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

// List a slide's feature indexes (one row per params hash), reconciled server-side against the
// worker for any in-flight build. Returns [] for a slide that has never been preprocessed.
export async function listSlideIndex(itemId) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/index`,
    { headers: authHeaders() },
  );
  const data = await asJson(r, 'List slide index');
  return data.indexes || [];
}

// Enqueue a Trident index build for a slide. `params` overrides (encoder/mag/patch_size/
// segmenter) are optional; the worker fills defaults. Returns the durable slide_index row
// (status `queued`), which the panel then polls via listSlideIndex.
export async function startPreprocess(itemId, params = {}) {
  const body = {};
  for (const k of ['encoder', 'mag', 'patch_size', 'segmenter']) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') body[k] = params[k];
  }
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/preprocess`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    },
  );
  return asJson(r, 'Start preprocess');
}
