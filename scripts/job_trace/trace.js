// trace.js — the shell: health, sign-in, the log stream, and the wiring between them.
//
// The run itself lives in `runs.js`; what a hop *means* lives in `hops.js`. This file is only
// what has to happen once, at boot.

import { get } from './api.js';
import { again, planWhole, runClassify, runNuclei, stop } from './runs.js';
import { loadSlide } from './slide.js';
import { $, S } from './state.js';
import { addWire, hopState, mountHops, mountLogs, setHop, updateWire } from './ui.js';

// ── health ──────────────────────────────────────────────────────────────────────────────

async function health() {
  const cfg = (await get('/trace/config')).data;
  // Both endpoints are unauthenticated, so this reads the same before and after signing in.
  const g = await get('/api/v1/system/version');
  const c = await get('/api/copilot/health');
  $('health').innerHTML = [['Girder', g.ok], ['gateway', c.ok], ['容器日志', !!cfg.logs]]
    .map(([n, up]) => `<span><b>${n}</b> `
      + `<span class="${up ? 'up' : 'down'}">${up ? '通' : '断'}</span></span>`)
    .join('');
}

// ── auth ────────────────────────────────────────────────────────────────────────────────

async function useToken(tok) {
  S.token = tok.trim();
  sessionStorage.setItem('jobTraceToken', S.token);
  const me = await get('/api/v1/user/me');
  if (!me.ok || !me.data?.login) {
    $('auth-out').textContent = `这个 token 用不了（${me.status}）。`;
    return false;
  }
  $('auth-out').innerHTML = `已登录：<b>${me.data.login}</b>${me.data.admin ? ' · admin' : ''}`;
  setHop('auth', 'done');
  addWire('auth', 'GET /api/v1/user/me', { login: me.data.login, admin: !!me.data.admin });
  return true;
}

async function login() {
  const basic = btoa(`${$('user').value}:${$('pass').value}`);
  const res = await fetch('/api/v1/user/authentication',
    { headers: { Authorization: `Basic ${basic}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('auth-out').textContent = `登录失败（${res.status}）：${body.message || ''}`;
    return;
  }
  // The token itself is never shown in full and never leaves the browser except as a header.
  addWire('auth', 'GET /api/v1/user/authentication',
    { token: `${body.authToken.token.slice(0, 8)}…` });
  $('pass').value = '';
  await useToken(body.authToken.token);
}

// ── container stdout → hops 7, 8, 9 ─────────────────────────────────────────────────────

let polls = 0;

function onLogLine(e) {
  if (!S.running) return;
  const l = e.line;
  // The hop is idle only at the start of a run, which is where the count belongs back at zero —
  // otherwise the second run says "第 47 次轮询" for its first poll.
  if (hopState('poll') === 'idle') polls = 0;
  if (e.c === 'agent-celery-1' && /\/(nuclei|classify|tissue|biomarker)\/status\//.test(l)) {
    polls += 1;
    setHop('poll', 'live');
    updateWire('poll', `driver → 服务，第 ${polls} 次轮询`, l);
  } else if (e.c === 'agent-celery-1' && /HTTP Request: POST/.test(l)) {
    setHop('poll', 'live');
    addWire('poll', 'driver 提交', l);
  } else if (e.c === 'agent-celery-1' && /succeeded in/.test(l)) {
    setHop('poll', 'done');
    addWire('poll', 'Celery 任务返回', l, 'ok');
  } else if (e.c === 'agent-cellvit-1') {
    setHop('gpu', 'live');
    updateWire('gpu', 'GPU 服务 stdout', l);
  } else if (e.c === 'agent-copilot-1' && /\/result/.test(l)) {
    setHop('report', 'live');
    addWire('report', '服务回报结果', l, 'ok');
  }
}

function relevant(e) {
  // The GPU service logs the model's own stdout, which names neither the slide nor the artifact —
  // so it is shown while something is running and hidden when nothing is. Everything else can be
  // matched on content. This is a heuristic, and the checkbox says so.
  if (e.c === 'agent-cellvit-1') return S.running;
  const l = e.line;
  return !S.item || l.includes(S.item) || (S.art && l.includes(S.art))
    || l.includes('cellvit:8020') || l.includes('pathassist');
}

// ── boot ────────────────────────────────────────────────────────────────────────────────

mountHops($('hops'));
mountLogs($('logs'), { relevant, onLine: onLogLine });

// Everything this page knows, in one place a devtools console — or the Playwright check that
// keeps this tool honest — can read. It is a diagnostic console; hiding its own state from the
// person debugging with it would be the wrong kind of tidy.
window.__trace = S;

$('item').value = S.item;
$('btn-login').onclick = login;
$('btn-token').onclick = () => useToken($('token').value);
$('btn-slide').onclick = loadSlide;
$('btn-nuclei').onclick = runNuclei;
$('btn-classify').onclick = runClassify;
$('btn-plan').onclick = planWhole;
$('btn-again').onclick = again;
$('btn-stop').onclick = stop;
$('btn-stop').disabled = true;

health();
if (S.token) useToken(S.token).then(ok => { if (ok) loadSlide(); });
