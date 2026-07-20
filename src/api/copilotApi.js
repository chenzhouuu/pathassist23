// src/api/copilotApi.js — PathAgent v2 Copilot gateway client.
// Mirrors wsiAgentApi.js: env-configurable base + Girder-Token auth + raw fetch so
// we can read the SSE stream from response.body. Distinct base from the older
// pathagent gateway (/api/agent) so both coexist.
//
// Increment 1: conversations + turns persist. The panel loads history on mount,
// lazily creates a conversation on first send, and streams replies over SSE.
const COPILOT_BASE = (import.meta.env.VITE_COPILOT_API_URL || '/api/copilot').replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = localStorage.getItem('girderToken');
  return { ...(token ? { 'Girder-Token': token } : {}), ...extra };
}

// Turn a non-OK response into a message that names the actual failure mode, so an
// AGENT_GIRDER_BASE mismatch never masquerades as a generic auth error again.
function describeError(status, detail, what) {
  if (status === 401) {
    return "Girder rejected the session (401) — the copilot service's AGENT_GIRDER_BASE "
      + `must match the Girder your viewer is signed into. ${detail}`;
  }
  if (status === 422) return 'No Girder token found in this browser — sign in again.';
  if (status === 503) {
    return `Copilot backend unavailable (503) — is the container (and Postgres) up? ${detail}`;
  }
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

export async function checkHealth() {
  const r = await fetch(`${COPILOT_BASE}/health`);
  if (!r.ok) throw new Error(`health failed: ${r.status}`);
  return r.json();
}

// List the current user's conversations for a slide (newest first). Omit itemId
// for the user's full list.
export async function listConversations(itemId) {
  const q = itemId ? `?item_id=${encodeURIComponent(itemId)}` : '';
  const r = await fetch(`${COPILOT_BASE}/conversations${q}`, { headers: authHeaders() });
  const data = await asJson(r, 'List conversations');
  return data.conversations || [];
}

export async function createConversation({ itemId = null, title = null } = {}) {
  const r = await fetch(`${COPILOT_BASE}/conversations`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ item_id: itemId, title }),
  });
  return asJson(r, 'New conversation');
}

// Fetch a conversation plus its turns ({ id, item_id, title, ..., turns: [{role,text}] }).
export async function getConversation(id) {
  const r = await fetch(`${COPILOT_BASE}/conversations/${id}`, { headers: authHeaders() });
  return asJson(r, 'Load conversation');
}

// Delete a conversation (and its turns). Resolves on 204; throws with a named cause otherwise.
export async function deleteConversation(id) {
  const r = await fetch(`${COPILOT_BASE}/conversations/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (r.status === 204) return;
  let detail = '';
  try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  throw new Error(describeError(r.status, detail, 'Delete conversation'));
}

// Approve / reject a proposed plan (increment 4). Returns the updated plan; the state
// gate is server-side (404 if the plan is gone, 409 if it is no longer awaiting).
export async function approvePlan(conversationId, digest) {
  const r = await fetch(
    `${COPILOT_BASE}/conversations/${conversationId}/plan/${encodeURIComponent(digest)}/approve`,
    { method: 'POST', headers: authHeaders() },
  );
  return asJson(r, 'Approve plan');
}

export async function rejectPlan(conversationId, digest) {
  const r = await fetch(
    `${COPILOT_BASE}/conversations/${conversationId}/plan/${encodeURIComponent(digest)}/reject`,
    { method: 'POST', headers: authHeaders() },
  );
  return asJson(r, 'Reject plan');
}

// POST a message into a conversation and stream SSE `data:` frames to onEvent({type,...}).
// The server persists the user turn before streaming and the assistant turn at the end.
// A quantitative ask yields a `plan` frame instead of tokens (increment 4).
// Frame contract (start/token/plan/done/error) is stable across increments.
export async function streamMessage({ conversationId, text, roi = null, onEvent, signal }) {
  const r = await fetch(`${COPILOT_BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(roi ? { text, roi } : { text }),
    signal,
  });
  if (!r.ok || !r.body) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(describeError(r.status, detail, 'Copilot message'));
  }
  await readSse(r.body, onEvent);
}

// Parse an SSE byte stream: split frames on the blank line, JSON-parse each `data:`.
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // Strip CR so the blank-line frame delimiter matches regardless of line endings
    // (sse-starlette emits \r\n\r\n between events).
    buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data:')) {
          const payload = t.slice(5).trim();
          try { onEvent(JSON.parse(payload)); } catch { /* skip keepalive/non-JSON */ }
        }
      }
    }
  }
}
