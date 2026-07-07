// src/api/wsiAgentApi.js — PathAgent (M3 gateway) client: preprocess, status, SSE query, heatmap.
const AGENT_BASE = (import.meta.env.VITE_AGENT_API_URL || '/api/agent').replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = localStorage.getItem('girderToken');
  return { ...(token ? { 'Girder-Token': token } : {}), ...extra };
}

export async function preprocessCase(itemId, { backbone, consensus, slidechat = false } = {}) {
  const body = {
    backbone: backbone || { patchEncoder: 'conch_v1', mag: 20, patchSize: 256 },
    consensus: consensus || { patchEncoder: 'uni_v1', mag: 20, patchSize: 512 },
    slidechat,
  };
  const r = await fetch(`${AGENT_BASE}/cases/${encodeURIComponent(itemId)}/preprocess`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`preprocess failed: ${r.status}`);
  return r.json();
}

export async function pollStatus(itemId, cacheKey) {
  const u = `${AGENT_BASE}/cases/${encodeURIComponent(itemId)}/status?cacheKey=${encodeURIComponent(cacheKey)}`;
  const r = await fetch(u, { headers: authHeaders() });
  if (!r.ok) throw new Error(`status failed: ${r.status}`);
  return r.json();
}

export function heatmapUrl(itemId, taskId, cacheKey) {
  return `${AGENT_BASE}/cases/${encodeURIComponent(itemId)}/heatmap/${encodeURIComponent(taskId)}`
       + `?cacheKey=${encodeURIComponent(cacheKey)}`;
}

export async function streamAgentQuery({ itemId, cacheKey, question, task = 'Diagnosis', roi = null,
                                         onEvent, signal }) {
  const r = await fetch(`${AGENT_BASE}/query`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ itemId, cacheKey, question, task, roi }), signal,
  });
  if (!r.ok || !r.body) throw new Error(`query failed: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
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
