# 09 — Removal, one `jobs.py`, and clearing the deployment debris

**What to build:** the tidy-up that only becomes safe once every kind is across.

**Blocked by:** 08.

**Status:** needs-triage

- [ ] Four copies of `jobs.py` (preprocess, biomarker, tissue, cellvit) collapse into one shared
      module. `cellvit/jobs.py:1` recorded the third copy as the agreed trigger; this is the fourth.
      It keeps its role — the box-local serialiser under Celery's cross-service one.
- [ ] Cooperative stop lives in that shared module rather than three times.
- [ ] `RightPanel` is 7 tabs. No dead imports, no `hasRole` entries for tabs that no longer exist.
- [ ] `preprocessApi.js` loses the routes that no longer exist; `taskApi.js`, `tissueApi.js`,
      `nucleiApi.js`, `biomarkerApi.js` keep only their tile and meta surfaces.
- [ ] `dsa-worker-1`'s healthcheck no longer reports unhealthy. It is a 10 s timeout against a
      `celery inspect ping` that answers `OK / pong` — a timeout, not a dead worker — so raise the
      timeout rather than pretending it was broken.
- [ ] `pathagent-redis` is either wired to something or removed. It has idled since mid-July with
      no importer in the repo; Girder 5's notification layer wants exactly one, which makes it the
      obvious input to the WebSocket ticket rather than a container to delete blindly.
- [ ] The plan's §9 out-of-scope list is still out of scope. Note anything that drifted.
- [ ] **Verified on DEMO:** full sweep — build every artifact kind on the slide from empty, using
      only Analysis and the Workspace, with no reference to a removed panel.
