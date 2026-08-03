// api.js — every call this page makes.
//
// All same-origin, because serve.py reverse-proxies both APIs. There is no CORS anywhere in this
// tool and no second auth surface: the token rides in `Girder-Token`, exactly as it does from the
// app.

import { S } from './state.js';

/** One call, with everything the hop list wants to show about it. Never throws on an HTTP error. */
export async function call(method, path, body) {
  const t = performance.now();
  const res = await fetch(path, {
    method,
    headers: {
      ...(S.token ? { 'Girder-Token': S.token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* a non-JSON body is still worth showing */ }
  return { status: res.status, ok: res.ok, data, ms: Math.round(performance.now() - t) };
}

export const get = (p) => call('GET', p);
export const post = (p, b) => call('POST', p, b);

/**
 * An image element for a token-protected PNG, or null.
 *
 * Fetched as a blob rather than pointed at with `<img src>`: the tiles authenticate with the
 * `Girder-Token` header — there is deliberately no token in the query string — and an `<img>`
 * cannot send one.
 */
export async function blob(path) {
  try {
    const res = await fetch(path, { headers: S.token ? { 'Girder-Token': S.token } : {} });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    const img = new Image();
    try {
      await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
    } finally {
      // Decoded already, so the object URL has done its job. Without this a session that draws a
      // few hundred tiles keeps every one of them alive for as long as the tab is open.
      URL.revokeObjectURL(url);
    }
    return img;
  } catch { return null; }
}
