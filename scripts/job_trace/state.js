// state.js — everything the page knows, in one object, plus the vocabulary shared across modules.

export const $ = (id) => document.getElementById(id);

/** The slide every test in this repo runs on. A convenience default, not a constraint. */
const DEMO = '6a6e1ca82ae96ce927e33818';

export const JOB_STATE = { 0: '未激活', 1: '排队', 2: '运行中', 3: '成功', 4: '失败', 5: '已停止' };
export const TERMINAL = new Set([3, 4, 5]);

/** A Girder job status as a hop state. CANCELED is its own thing, on purpose — see trace.css. */
export const stateFor = (status) => ({ 3: 'done', 5: 'stop' }[status] || 'fail');

export const S = {
  token: sessionStorage.getItem('jobTraceToken') || '',
  item: localStorage.getItem('jobTraceItem') || DEMO,
  slide: null,          // {width, height} in level-0 pixels
  meta: null,           // the nuclei artifact's own meta, off the cellvit service
  artifacts: [],
  art: null,            // the nuclei art_hash this page is working on
  roi: null,            // the rectangle the run will be submitted with
  job: null,            // the Girder job currently being watched
  running: false,
  lastBody: null,       // what "再提交一次" replays
};
