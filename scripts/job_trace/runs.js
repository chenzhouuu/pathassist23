// runs.js — the five buttons.
//
// Each one makes the same calls the Analysis panel makes, and marks each hop as the evidence for
// it arrives. Hops 7 and 8 are the exception: they have no request of their own to await and are
// fed by the log matcher in `trace.js`, then settled here when the job settles.

import { blob, call, get, post } from './api.js';
import { CORE, coresFor, drawResult } from './canvas.js';
import { countsHtml, refresh } from './slide.js';
import { $, JOB_STATE, S, stateFor, TERMINAL } from './state.js';
import { addWire, hopState, openHop, setHop, startRun, updateWire } from './ui.js';

function busy(on) {
  S.running = on;
  for (const id of ['btn-nuclei', 'btn-classify', 'btn-plan', 'btn-again']) $(id).disabled = on;
  $('btn-stop').disabled = !on;
}

/** Poll one Girder job to a terminal status, narrating hop 6 as it goes. */
async function watchJob(jobId) {
  S.job = jobId;
  let last = null;
  for (;;) {
    const j = await get(`/api/v1/job/${jobId}`);
    if (!j.ok) {
      setHop('job', 'fail');
      addWire('job', `GET /job/${jobId}`, j.data, 'bad');
      closeWorkerHops(4);
      return null;
    }
    const p = j.data.progress || {};
    const line = `${JOB_STATE[j.data.status] ?? j.data.status}`
      + `  ${p.current ?? '-'} / ${p.total ?? '-'}  ${p.message || ''}`;
    if (line !== last) {
      updateWire('job', `job ${jobId}`, line, j.data.status === 4 ? 'bad' : '');
      last = line;
    }
    if (j.data.status >= 2) {
      setHop('job', TERMINAL.has(j.data.status) ? stateFor(j.data.status) : 'live');
    }
    if (TERMINAL.has(j.data.status)) {
      if (j.data.status === 5) {
        addWire('job', '停止，不是失败',
          '协作式停止在核心瓦片的边界落地，所以已经算完的瓦片留在磁盘上，这条 artifact 仍然可用，'
          + '再点一次同样的运行就从断点接着算。它落 CANCELED 而不是 ERROR，正是为了不把这些'
          + '字节说成垃圾。');
      } else if (j.data.status === 4) {
        // girder_worker writes the exception first and the frames after it, so the reason a run
        // failed is the log's FIRST line, not its last.
        const log = (j.data.log || []).join('').slice(0, 1200);
        if (log) addWire('job', '失败原因（日志第一行）', log.split('\n')[0], 'bad');
      }
      closeWorkerHops(j.data.status);
      return j.data;
    }
    await new Promise(r => setTimeout(r, 700));
  }
}

/**
 * Settle the two hops that are only ever *observed*, when the job they belong to settles.
 *
 * Left to the log matcher alone, hop 8 stays lit for ever after a run that finished, and stays
 * dark after a run that printed nothing. Neither is true, and the second is the worse lie: a
 * classify run reuses the embeddings the segmentation stored, touches no GPU and is silent, so
 * "idle" would read as "this never happened" when what happened is that it was quiet.
 */
function closeWorkerHops(status) {
  const quiet = {
    poll: '这一跳没在容器日志里留下痕迹（sidecar 没连上 docker，或者这一跳快到没来得及打日志）。'
      + '它一定发生了 —— driver 的轮询是唯一能把这个 job 推到终态的东西。',
    gpu: 'cellvit 这次没往 stdout 写东西。分类走的是分割时存下来的 per-nucleus embedding，不碰 '
      + 'GPU，通常就是安静的 —— 上一跳 celery 那边的 /classify/status/ 轮询就是它在干活的证据。',
  };
  for (const id of ['poll', 'gpu']) {
    if (hopState(id) === 'idle') addWire(id, '没有可见输出', quiet[id]);
    setHop(id, stateFor(status));
  }
}

/**
 * Read a planner answer out loud.
 *
 * `plan` is every step the submission implies, each with a `built` flag; `steps` is the subset
 * that is actually going to run. A step can be in both — built *and* queued — and that is not a
 * contradiction, it is the whole of the growable rule. An earlier version of this readout said
 * "built ⇒ skipped", which is the exact misunderstanding that let a second region be a silent
 * no-op for as long as it was.
 */
function explainPlan(data) {
  if (!Array.isArray(data.plan)) return;
  const todo = new Set((data.steps || []).map(s => s.art_hash));
  const say = (s) => `${s.title}（${s.built ? '字节已在磁盘上' : '还没有'}）`;
  const skipped = data.plan.filter(s => !todo.has(s.art_hash));
  const running = data.plan.filter(s => todo.has(s.art_hash));
  const grew = running.filter(s => s.built).map(s => s.title);
  addWire('plan', '读法',
    `这次跳过：${skipped.map(say).join('、') || '（无）'}\n`
    + `这次要跑：${running.map(say).join('、') || '（无）'}`
    + (grew.length
      ? `\n\n注意「${grew.join('、')}」：字节已经在磁盘上，但仍然要跑。会长大的产物，`
        + '它的地址由模型和分辨率算出、和矩形无关 —— '
        + '所以"这条产物存在"从来不代表"它已经覆盖了你刚要的那块"。'
      : ''));
}

/** Hops 1–5, shared by every dispatch: probe the cost, then send the real thing. */
async function dispatch(kind, body, label) {
  const path = `/api/copilot/slides/${S.item}/${kind}`;
  S.lastBody = { kind, body };

  addWire('form', label, body);
  setHop('form', 'done');

  const probe = await post(`${path}?mode=plan`, body);
  setHop('plan', probe.ok ? 'done' : 'fail');
  addWire('plan', `POST ${kind}?mode=plan → ${probe.status} · ${probe.ms}ms`, probe.data,
    probe.ok ? 'ok' : 'bad');
  if (probe.ok) explainPlan(probe.data);

  setHop('post', 'live');
  const run = await post(path, body);
  setHop('post', run.ok ? 'done' : 'fail');
  addWire('post', `POST ${kind} → ${run.status} · ${run.ms}ms`, body);
  addWire('post', '响应', run.data, run.ok ? 'ok' : 'bad');
  if (!run.ok) { setHop('dispatch', 'fail'); return null; }

  const ack = run.data;
  setHop('dispatch', 'done');
  addWire('dispatch', 'ack', {
    status: ack.status, art_hash: ack.art_hash,
    chain_id: ack.chain_id, girder_job_id: ack.girder_job_id,
  }, ack.status === 'queued' ? 'ok' : '');
  if (ack.status === 'ready') {
    addWire('dispatch', '没有排队', '这一发被判定为无事可做：需要的字节已经在磁盘上了。');
    return ack;
  }
  if (!ack.girder_job_id) return ack;

  const job = await get(`/api/v1/job/${ack.girder_job_id}`);
  setHop('queue', 'done');
  addWire('queue', `GET /job/${ack.girder_job_id}`, {
    title: job.data.title, type: job.data.type, handler: job.data.handler,
    status: `${job.data.status} · ${JOB_STATE[job.data.status]}`,
    celeryTaskId: job.data.celeryTaskId, pathassist: job.data.pathassist,
  });
  return ack;
}

/** Hops 9–10: what landed on disk, and what it looks like. */
async function settle(ack, rect) {
  const before = S.meta;
  const meta = await refresh();
  setHop('report', 'done');
  addWire('report', 'artifact 行（跑完之后）', {
    art_hash: ack.art_hash,
    n_tiles: meta?.summary?.n_tiles, n_nuclei: meta?.summary?.n_nuclei,
    taxonomies: (meta?.taxonomies || []).map(t => t.id),
  }, 'ok');
  if (before && meta) {
    addWire('report', '和跑之前的差', {
      核心瓦片: `${before.coverage.done.length} → ${meta.coverage.done.length}`,
      细胞数: `${before.summary.n_nuclei} → ${meta.summary.n_nuclei}`,
      命名: `${(before.taxonomies || []).length} → ${(meta.taxonomies || []).length}`,
    });
  }

  setHop('render', 'live');
  const info = await drawResult($('shot'), {
    blob, item: S.item, meta, artHash: ack.art_hash, taxonomy: $('taxonomy').value, rect,
  });
  setHop('render', 'done');
  addWire('render', '出图', `瓦片层 classes，level ${info?.level}，取了 ${info?.tiles} 块`);
  $('result-out').innerHTML = '画的是这一发算的那块：'
    + `<code>${rect.x}, ${rect.y}, ${rect.width}×${rect.height}</code>`
    + '（H&E 底图 + nuclei 的 classes 瓦片叠上去）<br>' + countsHtml(meta);
  openHop('render');
}

/** The bounding box of a set of core tiles — what a region run actually computes. */
function boundsOf(cores) {
  const xs = cores.map(c => c[0]);
  const ys = cores.map(c => c[1]);
  return {
    x: Math.min(...xs) * CORE, y: Math.min(...ys) * CORE,
    width: (Math.max(...xs) - Math.min(...xs) + 1) * CORE,
    height: (Math.max(...ys) - Math.min(...ys) + 1) * CORE,
  };
}

export async function runNuclei() {
  const roi = S.roi;
  if (!roi) { $('run-out').textContent = '先在缩略图上拖一个框。'; return; }
  busy(true);
  startRun();
  setHop('auth', 'done');
  const cores = coresFor(roi, S.meta?.core);
  const drawn = roi.width * roi.height;
  const got = cores.length * CORE * CORE;
  $('run-out').innerHTML = `画的是 ${roi.width}×${roi.height} px（${drawn.toLocaleString()} px²），`
    + `它会算 ${cores.length} 块核心瓦片（${got.toLocaleString()} px²，`
    + `<b>${(got / drawn).toFixed(1)} 倍</b>）。`;

  const ack = await dispatch('nuclei', { bbox: roi, seg_hash: null }, '表单值 → 请求体');
  if (ack?.girder_job_id) await watchJob(ack.girder_job_id);
  if (ack) await settle(ack, boundsOf(cores));
  busy(false);
}

export async function runClassify() {
  if (!S.art) { $('run-out').textContent = '这张片还没有 nuclei artifact，先跑一次分割。'; return; }
  busy(true);
  startRun();
  setHop('auth', 'done');
  $('run-out').innerHTML = `给已有的 <code>${S.art}</code> 再挂一套命名。轮廓不重算 —— `
    + '分割时每个细胞的 embedding 已经存下来了。';
  const ack = await dispatch('classify',
    { art_hash: S.art, taxonomy: $('taxonomy').value }, '表单值 → 请求体');
  if (ack?.girder_job_id) await watchJob(ack.girder_job_id);
  if (ack) {
    const b = S.meta?.coverage?.bounds || [0, 0, CORE, CORE];
    await settle(ack, { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] });
  }
  busy(false);
}

export async function planWhole() {
  startRun();
  setHop('auth', 'done');
  setHop('form', 'done');
  addWire('form', '整片，只问不跑', { bbox: null, seg_hash: null, mode: 'plan' });
  const r = await post(`/api/copilot/slides/${S.item}/nuclei?mode=plan`,
    { bbox: null, seg_hash: null });
  setHop('plan', r.ok ? 'done' : 'fail');
  addWire('plan', `POST nuclei?mode=plan → ${r.status} · ${r.ms}ms`, r.data, r.ok ? 'ok' : 'bad');
  if (r.ok) explainPlan(r.data);
  addWire('plan', '整片和区域的差别',
    '整片跑需要一份组织分割，才知道哪些瓦片值得上 GPU。这张片没有合适的分割时，规划器不会拒绝 —— '
    + '它把分割排在前面，同一次提交里解决。区域跑不需要：矩形本身就是掩膜。');
  for (const id of ['post', 'dispatch', 'queue', 'job', 'poll', 'gpu', 'report', 'render']) {
    setHop(id, 'skip');
  }
  openHop('plan');
  $('run-out').textContent = '只问了成本，没有排任何 job。';
}

export async function again() {
  if (!S.lastBody) { $('run-out').textContent = '还没有可以重放的请求。'; return; }
  const { kind, body } = S.lastBody;
  busy(true);
  startRun();
  setHop('auth', 'done');
  $('run-out').innerHTML = '同一个请求再发一次。会长大的产物（nuclei / tissue / biomarker）'
    + '仍然会排队 —— 它们的地址由模型和分辨率算出、和矩形无关，所以"字节已存在"不代表'
    + '"你要的那块已经算过"。';
  const ack = await dispatch(kind, body, '重放，一模一样的请求体');
  if (ack?.girder_job_id) await watchJob(ack.girder_job_id);
  if (ack) await refresh();
  busy(false);
}

export async function stop() {
  if (!S.job) return;
  const r = await call('PUT', `/api/v1/job/${S.job}/cancel`);
  addWire('job', `PUT /job/${S.job}/cancel → ${r.status}`,
    '协作式停止：worker 会把请求带到 cellvit 的核心瓦片边界，已经算完的留在磁盘上，'
    + 'job 落 CANCELED 而不是 ERROR。', r.ok ? 'ok' : 'bad');
}
