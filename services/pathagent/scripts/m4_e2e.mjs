// M4 live end-to-end: drive the REAL built PathAssist frontend in a REAL browser against the
// LIVE M3 gateway + a REAL public DSA slide (BRACS_1648). Exercises the PathAgent panel UI:
// Prepare → Diagnosis query stream → OSD co-navigation → heatmap overlay → save-as-annotation.
//
// Slide-opening (existing, non-M4 functionality) is done via the dev-only window.__pathStore handle
// so the test is deterministic; every M4-specific interaction below is a real DOM click/keypress.
//
// Prereqs: the M3 gateway on :8000 wired to the DSA (+ pre-cached slide); the dev server running
//   (`VITE_AGENT_API_URL=http://localhost:8000/api/agent npm run dev`); Playwright + Chromium
//   (`npm i -D playwright && npx playwright install chromium`); the dev build exposes
//   window.__pathStore (dev-only handle in src/store/index.js).
// Run from the repo root so `playwright` resolves:
//   M4_TOKEN=<girderToken> M4_APP_URL=http://localhost:<devPort> node services/pathagent/scripts/m4_e2e.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const TOKEN = process.env.M4_TOKEN;
const APP = process.env.M4_APP_URL || 'http://localhost:3001';
const ITEM_ID = process.env.M4_ITEM_ID || '6a3efdab9cb269b0b0bb615c';
const GIRDER = process.env.M4_GIRDER || 'http://192.168.191.109:9080/api/v1';
const SHOT = '/tmp/pathagent-m4-cache';
if (!TOKEN) { console.error('M4_TOKEN required'); process.exit(2); }

const checks = [];
const ck = (name, cond) => { checks.push([name, !!cond]); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); return !!cond; };
const shot = (page, n) => page.screenshot({ path: `${SHOT}/m4_${n}.png` }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 950 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('   [console-error]', m.text().slice(0, 160)); });

try {
  // 1) Auto-auth via ?girderToken= (App.jsx OAuth-callback path → getMe → setAuth).
  console.log('[m4] auth…');
  await page.goto(`${APP}/?girderToken=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(3500);
  ck('store handle present (dev)', await page.evaluate(() => !!window.__pathStore));
  ck('authenticated (user set)', await page.evaluate(() => !!window.__pathStore?.getState().user));
  await shot(page, '1_authed');

  // 2) Open the slide via the store (existing functionality; not the M4 code under test).
  console.log('[m4] opening slide via store…');
  await page.evaluate(async ([g, id, t]) => {
    const r = await fetch(`${g}/item/${id}`, { headers: { 'Girder-Token': t } });
    const item = await r.json();
    window.__pathStore.getState().setActiveItem(item);
  }, [GIRDER, ITEM_ID, TOKEN]);
  // Wait for OSD + tilesInfo to be ready.
  let osdReady = false;
  for (let i = 0; i < 40; i++) {
    osdReady = await page.evaluate(() => {
      const s = window.__pathStore.getState();
      return !!(s.viewer && s.viewer.viewport && s.tilesInfo);
    });
    if (osdReady) break; await sleep(1000);
  }
  ck('slide open (OSD viewer + tilesInfo ready)', osdReady);
  await shot(page, '2_slide');

  // 3) Open the PathAgent panel via the tab store action, then verify the REAL panel DOM rendered.
  console.log('[m4] opening PathAgent panel…');
  await page.evaluate(() => {
    window.__pathStore.getState().setRightPanelTab('agent');
    window.__pathStore.getState().setRightPanelOpen(true);
  });
  await sleep(1500);
  ck('PathAgent panel rendered', (await page.getByText(/Prepare|Diagnosis|PathAgent/i).first().count()) > 0);
  await shot(page, '3_panel');

  // 4) Prepare (real click) — pre-cached → reaches ready quickly.
  console.log('[m4] Prepare…');
  const prepare = page.getByRole('button', { name: /Prepare/i }).first();
  if (await prepare.count()) await prepare.click().catch(() => {});
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await page.evaluate(() => window.__pathStore.getState().agentStatus?.ready?.features === true);
    if (ready) break; await sleep(3000);
  }
  ck('case ready (agentStatus.ready.features)', ready);
  await shot(page, '4_ready');

  // 5) Ask the Diagnosis question (real textarea + Enter) and stream.
  console.log('[m4] sending Diagnosis query…');
  const boundsBefore = await page.evaluate(() => {
    const b = window.__pathStore.getState().viewer.viewport.getBounds(); return { x: b.x, y: b.y, w: b.width };
  });
  const input = page.locator('textarea').last();
  await input.click(); await input.fill('What is the invasive carcinoma subtype and what features support it?');
  await input.press('Enter');
  // Wait for the final event in the store.
  let final = null;
  for (let i = 0; i < 120; i++) {
    final = await page.evaluate(() => window.__pathStore.getState().agentFinal);
    if (final) break; await sleep(3000);
  }
  ck('stream produced a final answer', !!final);
  ck('final has answer + confidence', !!(final && final.answer && typeof final.confidence === 'number'));
  ck('final has non-empty trail', !!(final && final.trail && final.trail.length > 0));
  if (final) console.log(`   → answer: "${String(final.answer).slice(0, 120)}" | confidence ${final.confidence} | trail ${final.trail?.length}`);
  await shot(page, '5_final');

  // 6) Co-navigation: the viewer viewport actually moved during the run.
  const boundsAfter = await page.evaluate(() => {
    const b = window.__pathStore.getState().viewer.viewport.getBounds(); return { x: b.x, y: b.y, w: b.width };
  });
  const moved = Math.abs(boundsAfter.x - boundsBefore.x) > 1e-4 || Math.abs(boundsAfter.w - boundsBefore.w) > 1e-4;
  ck('co-navigation moved the viewport', moved);
  const traceLen = await page.evaluate(() => window.__pathStore.getState().agentTrace.length);
  const navCount = await page.evaluate(() => window.__pathStore.getState().agentNavTrail.length);
  ck(`trace populated (events=${traceLen}, navTrail=${navCount})`, traceLen >= 5 && navCount >= 1);

  // 7) Heatmap toggle → a world item is added to the OSD viewer.
  console.log('[m4] heatmap toggle…');
  const worldBefore = await page.evaluate(() => window.__pathStore.getState().viewer.world.getItemCount());
  const heat = page.getByRole('button', { name: /Heatmap/i }).first();
  if (await heat.count()) await heat.click().catch(() => {});
  await sleep(4000);
  const worldAfter = await page.evaluate(() => window.__pathStore.getState().viewer.world.getItemCount());
  ck(`heatmap overlay added a world item (${worldBefore}→${worldAfter})`, worldAfter > worldBefore);
  await shot(page, '6_heatmap');

  // 8) Save-as-annotation → verify it lands in the DSA.
  console.log('[m4] save annotation…');
  await sleep(1500); // let the final card + trail settle so the handler closes over the full trail
  const annCount = () => page.evaluate(async ([g, id, t]) =>
    (await (await fetch(`${g}/annotation?itemId=${id}&limit=0`, { headers: { 'Girder-Token': t } })).json()).length,
    [GIRDER, ITEM_ID, TOKEN]);
  const before = await annCount();
  await page.getByRole('button', { name: /Save ROIs/i }).first()
    .click({ timeout: 5000 }).catch((e) => console.log('   save click:', e.message.slice(0, 60)));
  let after = before;
  for (let i = 0; i < 8; i++) { await sleep(1500); after = await annCount(); if (after > before) break; }
  ck(`save created a DSA annotation (${before}→${after})`, after > before);
  await shot(page, '7_saved');

} catch (err) {
  console.error('[m4] ERROR', err?.stack || err?.message || err);
  await shot(page, 'error');
} finally {
  const passed = checks.filter(([, o]) => o).length;
  const allok = checks.length > 0 && passed === checks.length;
  console.log(`\n[m4] ${allok ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} (${passed}/${checks.length})`);
  fs.writeFileSync(`${SHOT}/m4_e2e_result.json`, JSON.stringify(checks, null, 2));
  await browser.close();
  process.exit(allok ? 0 : 1);
}
