# 08 — One planner for every missing upstream

**What to build:** a single pure function that answers "what does this slide still need before this
tool can run", for every kind. It replaces `preprocessUtils.nextChainStep`,
`taskUtils.pendingStages`, and the hand-rolled checks in the biomarker and nuclei forms.

The form then says what it is about to do before it does it — "this slide still needs two
upstreams, 3 steps total" — and offers to submit the whole chain or only the part that can run now.

**Blocked by:** 07 — every kind has to be on the new path before one function can cover them all.

**Status:** needs-triage

- [ ] `plan(kind, params, rows)` → the ordered missing upstreams and their computed hashes. Pure,
      unit-tested against every kind, no network.
- [ ] Every form's readiness statement is rendered from it. Four ad-hoc implementations are deleted,
      not left beside it.
- [ ] The count of queue slots the submission will occupy is stated before submitting. Under
      `concurrency=1` this is a wait the user is agreeing to, so it is said out loud.
- [ ] "Run everything" and "run only what can run now" are both offered; neither is a default that
      quietly costs hours of GPU.
- [ ] **Verified on DEMO:** on a slide with nothing built, the marker-map entry states three steps;
      submitting runs them in order and the map appears at the end without a second click.
