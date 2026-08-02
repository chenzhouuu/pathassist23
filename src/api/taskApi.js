// src/api/taskApi.js — Downstream-task gateway client (Inc 2c).
// The task registry, one prediction per (feature index, task), and a prediction's per-patch
// arrays. Split from preprocessApi because 503 means something different here: preprocessApi
// reads it as "the service is not configured", while a task 503 is the worker saying it ships
// without torch — a state the panel must be able to explain rather than blame on config.
const COPILOT_BASE = (import.meta.env.VITE_COPILOT_API_URL || '/api/copilot').replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = localStorage.getItem('girderToken');
  return { ...(token ? { 'Girder-Token': token } : {}), ...extra };
}

// Errors carry the HTTP status and the server's own detail so the panel can distinguish
// "needs the GPU worker" (503) from "build the features first" (409) from a real failure.
export class TaskApiError extends Error {
  constructor(status, detail, what) {
    super(TaskApiError.describe(status, detail, what));
    this.name = 'TaskApiError';
    this.status = status;
    this.detail = detail;
  }

  static describe(status, detail, what) {
    if (status === 401) {
      return "Girder rejected the session (401) — the copilot service's AGENT_GIRDER_BASE "
        + `must match the Girder your viewer is signed into. ${detail}`;
    }
    if (status === 422) return 'No Girder token found in this browser — sign in again.';
    if (status === 503) {
      return detail || 'Task inference is unavailable — the preprocess worker cannot run it.';
    }
    if (status === 409) return detail || 'Build this slide’s feature index first.';
    if (status === 404) return detail || 'Not found.';
    if (status === 502) return `Could not reach the preprocess worker (502). ${detail}`;
    return `${what} failed (${status})${detail ? ` — ${detail}` : ''}`;
  }
}

async function asJson(r, what) {
  if (!r.ok) {
    let detail = '';
    try {
      const body = await r.json();
      detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body).slice(0, 300);
    } catch { /* non-JSON body */ }
    throw new TaskApiError(r.status, detail, what);
  }
  return r.json();
}

// The task registry plus whether this worker can actually run one. `available: false` is a CPU
// deployment: the registry still comes through so the panel renders the task card and says why.
export async function listTasks() {
  const r = await fetch(`${COPILOT_BASE}/tasks`, { headers: authHeaders() });
  const data = await asJson(r, 'List tasks');
  return { tasks: data.tasks || [], available: data.available !== false };
}

// Run a task on this slide. `feat_hash` is optional (Inc 6 · 07): without one the server looks for
// an index matching what the task's weights were trained on, and plans the build when the slide has
// none — so a slide with nothing on it reaches a call in one submission. The reply says how many
// steps were queued.
export async function startPredict(itemId, { feat_hash, task_id } = {}) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}/predict`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(feat_hash ? { feat_hash, task_id } : { task_id }),
    },
  );
  return asJson(r, 'Run task');
}

// A prediction's per-patch arrays — level-0 coords, attention and signed class evidence.
// Fetched only when a heatmap is actually drawn; it is thousands of floats.
export async function getPredictionHeatmap(itemId, predHash) {
  const r = await fetch(
    `${COPILOT_BASE}/slides/${encodeURIComponent(itemId)}`
    + `/prediction/${encodeURIComponent(predHash)}/heatmap`,
    { headers: authHeaders() },
  );
  return asJson(r, 'Load evidence map');
}
