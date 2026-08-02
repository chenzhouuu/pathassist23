// src/api/preprocessApi.js — the preprocess DAG's client: submit a build, read a slide's
// artifacts, delete one, fetch a segmentation's contours.
//
// Mirrors copilotApi's base + Girder-Token auth. Bulk arrays never come here — an artifact's own
// numbers are on its row and its pixels are tiles.
//
// The Inc-2a flat index (`POST /slides/{item}/preprocess`, `GET .../index`) is gone with its two
// clients (Inc 6 · 09). It predates the content-addressed DAG and had been unreachable from the UI
// since Inc 2b-3; what replaced it is `startBuild`, which addresses every stage and reuses what a
// slide already has.
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

// List a slide's DAG artifacts. Every row here is bytes on disk (Inc 6 · D9) — a run still in
// flight is in the Runs feed, not in this list. [] for a slide nothing has been built on.
export async function listArtifacts(itemId) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/artifacts`,
    { headers: authHeaders() },
  );
  const data = await asJson(r, 'List preprocess artifacts');
  return data.artifacts || [];
}

// Every submission route takes the same `mode` (Inc 6 · 08): `plan` asks what it *would* queue
// and enqueues nothing, `next` queues only the step that can run without waiting for another, and
// the default runs the lot. One planner answers all three, so the sentence a form shows and the
// submission it makes cannot disagree.
export const withMode = (path, mode) => (mode ? `${path}?mode=${mode}` : path);

// Stage 1 — enqueue a tissue segmentation. Returns the durable artifact row (its art_hash is the
// seg_hash the tiling stage needs).
export function startSegment(itemId, params = {}, mode) {
  const body = {};
  for (const k of ['segmenter', 'seg_conf_thresh',
    'remove_artifacts', 'remove_holes', 'remove_penmarks']) {
    if (params[k] !== undefined && params[k] !== null) body[k] = params[k];
  }
  return postJson(itemId, withMode('segment', mode), body, 'Start segmentation');
}

// A feature index: segment, tile, encode — one submission (Inc 6 · 07). The three stages had a
// route each until the panel that advanced them one at a time was deleted; they are steps of a
// Celery chain now, and the server drops the ones this slide already has. The reply says which
// steps were actually queued, or `status: 'ready'` when the whole build already existed.
export function startBuild(itemId, form = {}, mode) {
  const body = {};
  for (const k of ['encoder', 'segmenter', 'seg_conf_thresh', 'remove_artifacts', 'remove_holes',
    'remove_penmarks', 'mag', 'patch_size', 'overlap']) {
    if (form[k] !== undefined && form[k] !== null && form[k] !== '') body[k] = form[k];
  }
  return postJson(itemId, withMode('build', mode), body, 'Start feature build');
}

// Fetch a segmentation's tissue contours (level-0 px GeoJSON) for the viewer overlay (Phase 5).
export async function getSegmentationContours(itemId, segHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/segmentation/${encodeURIComponent(segHash)}/contours`,
    { headers: authHeaders() },
  );
  return asJson(r, 'Load tissue contours');
}


// ── Artifact removal (Inc 5, ticket 04) ────────────────────────────────────────────────

// What deleting this artifact would free, and what is holding it. Asked together because a dialog
// that offers a size for something it will then be refused permission to delete is a worse dialog
// than one that leads with the refusal.
export async function getArtifactUsage(itemId, artHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/artifacts/${encodeURIComponent(artHash)}/usage`,
    { headers: authHeaders() },
  );
  const data = await asJson(r, 'Check artifact usage');
  return { bytes: data.bytes || 0, dependants: data.dependants || [] };
}

// Delete the artifact's row and its bytes. Resolves to the dependants when the gateway refuses,
// so the caller can name them; never cascades, so a refusal is the whole answer.
export async function deleteArtifact(itemId, artHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/artifacts/${encodeURIComponent(artHash)}`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (r.status === 409) {
    let dependants = [];
    try { dependants = (await r.json())?.detail?.dependants || []; } catch { /* keep the empty list */ }
    return { deleted: false, dependants };
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(describeError(r.status, detail, 'Delete artifact'));
  }
  return { deleted: true, dependants: [] };
}
