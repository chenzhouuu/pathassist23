# 06 — Tissue and biomarker move across

**What to build:** the two remaining JobQueue-shaped kinds follow nuclei. Their submission moves to
the catalog, their numbers and layer controls to the Workspace, and their tabs go.

Mostly replication of 05. The one new thing is that `biomarker` has a real upstream requirement
(`nuclei_hash`, refused without — Inc 5 · D9), so it is the first entry whose form has to say what
it needs before 08 generalises that.

**Blocked by:** 05.

**Status:** needs-triage

- [ ] Both kinds submit through the catalog and appear in Runs with the same vocabulary as nuclei.
- [ ] Biomarker's form names its missing upstreams explicitly and refuses rather than guessing.
      A hand-rolled check here is expected; 08 replaces it.
- [ ] Marker mode/preset/channel controls and the tissue class list land in the Workspace row
      (04's components), including the two mutually exclusive marker modes.
- [ ] `TissuePanel.jsx`, `MarkersPanel.jsx` and their tabs removed; `tissueUtils` / `markerUtils`
      keep the pure logic and their tests.
- [ ] Cooperative stop for biomarker, which does not have it today — the pattern is tissue's and
      nuclei's, and this is the third and last copy before 09 extracts it.
- [ ] **Verified on DEMO:** a tissue map and a marker map built, drawn, tuned and stopped; the
      marker map correctly refusing until the nuclei artifact from 05 exists.
