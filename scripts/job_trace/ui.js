// ui.js — the hop list and the log panel. Rendering only; it decides nothing about the run.

import { HOPS } from './hops.js';

const state = new Map();          // hop id -> { el, wire: [] }
let t0 = 0;                       // wall clock of the current run, for the elapsed column

export function mountHops(el) {
  el.innerHTML = '';
  for (const h of HOPS) {
    const li = document.createElement('li');
    li.className = 'hop';
    li.dataset.state = 'idle';
    const d = document.createElement('details');
    d.className = 'hop-d';
    d.innerHTML = `
      <summary>
        <span class="num">${h.num}</span>
        <span>
          <span class="ttl">${h.title}</span><br>
          <span class="lead">${h.lead}</span>
        </span>
        <span class="when"></span>
      </summary>
      <div class="body">
        ${h.logs ? `<p class="only-logs">这一跳没有自己的请求可以等 —— `
          + `它只在 <code>${h.logs}</code> 的输出里看得见，所以下面的证据来自日志面板。</p>` : ''}
        <p class="why">${h.why}</p>
        <div class="src">${h.src.map(([sym, path]) =>
          `<span><b>${sym}</b> · ${path}</span>`).join('')}</div>
        <div class="wire-list"></div>
      </div>`;
    li.appendChild(d);
    el.appendChild(li);
    state.set(h.id, { el: li, list: d.querySelector('.wire-list'), when: d.querySelector('.when') });
  }
}

export function startRun() {
  t0 = Date.now();
  for (const [, s] of state) {
    s.el.dataset.state = 'idle';
    s.list.innerHTML = '';
    s.when.textContent = '';
  }
}

const SETTLED = new Set(['done', 'fail', 'stop']);

/** Mark a hop. `state` is one of idle | live | done | stop | fail | skip. */
export function setHop(id, next) {
  const s = state.get(id);
  if (!s) return;
  // A hop never walks backwards out of a terminal state: a late log line arriving after the run
  // finished must not relight a hop that already settled.
  if (SETTLED.has(s.el.dataset.state) && next === 'live') return;
  s.el.dataset.state = next;
  if (next !== 'idle' && !s.when.textContent) s.when.textContent = elapsed();
}

/** Attach one piece of evidence to a hop: a label, and the text it is evidence of. */
export function addWire(id, label, text, cls = '') {
  const s = state.get(id);
  if (!s) return;
  const pre = document.createElement('pre');
  pre.className = 'wire';
  const tag = `<span class="tag ${cls}">${escapeHtml(label)}</span>`;
  pre.innerHTML = tag + escapeHtml(typeof text === 'string' ? text : pretty(text));
  s.list.appendChild(pre);
  s.when.textContent = s.when.textContent || elapsed();
}

/** Replace a hop's last wire entry — for a reading that updates rather than accumulates. */
export function updateWire(id, label, text, cls = '') {
  const s = state.get(id);
  if (!s) return;
  const last = s.list.lastElementChild;
  if (!last || last.dataset.label !== label) {
    addWire(id, label, text, cls);
    if (s.list.lastElementChild) s.list.lastElementChild.dataset.label = label;
    return;
  }
  last.innerHTML = `<span class="tag ${cls}">${escapeHtml(label)}</span>`
    + escapeHtml(typeof text === 'string' ? text : pretty(text));
}

export function hopState(id) {
  return state.get(id)?.el.dataset.state || null;
}

export function openHop(id) {
  const s = state.get(id);
  if (s) s.el.querySelector('details').open = true;
}

function elapsed() {
  return t0 ? `+${((Date.now() - t0) / 1000).toFixed(2)}s` : '';
}

function pretty(v) {
  try { return JSON.stringify(v, null, 1); } catch { return String(v); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ── log panel ──────────────────────────────────────────────────────────────────────────
//
// The filter is a heuristic and is labelled as one in the UI. Two rules, because the three
// containers say different kinds of thing: the gateway and the worker name the slide and the
// artifact, so those lines can be matched on content; the GPU service logs the model's own
// stdout, which mentions neither, so it is shown while a run is live and hidden when nothing is
// running. A filter that pretended to be exact would hide the one line that explained a failure.

const SHORT = { 'agent-copilot-1': 'copilot', 'agent-celery-1': 'celery', 'agent-cellvit-1': 'cellvit' };

export function mountLogs(el, { relevant, onLine }) {
  const filter = document.getElementById('log-filter');
  document.getElementById('log-clear').onclick = () => { el.innerHTML = ''; };

  const src = new EventSource('/logs/stream');
  src.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    onLine?.(e);
    if (filter.checked && !relevant(e)) return;
    const row = document.createElement('div');
    const short = SHORT[e.c] || e.c;
    row.innerHTML = `<span class="c c-${short}">${escapeHtml(short)}</span>`
      + `<span class="t">${escapeHtml((e.t || '').slice(11, 19))}</span>`
      + `<span>${escapeHtml(e.line)}</span>`;
    const stuck = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    el.appendChild(row);
    while (el.childElementCount > 600) el.removeChild(el.firstChild);
    if (stuck) el.scrollTop = el.scrollHeight;
  };
  src.onerror = () => { /* the browser reconnects on its own */ };
  return src;
}
