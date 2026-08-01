# 03 — The Runs section: everything that is running, everywhere

**What to build:** the answer to the original ask. One list, under the catalog, of every job in
flight or recently finished — across slides and across users — grouped with the current slide
first. A queued job says what is ahead of it. A running one can be stopped.

Its source is Girder's `GET /job`, which means the HistomicsTK CLIs are in it from the first commit
without any work (plan §1, "determined by fact").

**Blocked by:** 01 — jobs must exist as Girder jobs before there is anything to list.

**Status:** needs-triage

- [ ] One global poller (~2.5 s) over `GET /job` filtered by type. Not one per panel, and not
      per-slide (plan D3).
- [ ] Rows are grouped `THIS SLIDE` / `OTHER SLIDES`, with the slide named — a bare item id is not
      an answer to "what is ahead of me".
- [ ] A queued row states its position. With `concurrency=1` this is the number that explains the
      wait, so it is not optional.
- [ ] Progress renders the counts the job carries (`142 / 338 · nuclei`), falling back to a percent
      only when a job reports no total.
- [ ] Stop is offered for running jobs and goes through `PUT /job/{id}/cancel`. A stopping job says
      `Stopping…` until it settles, matching the existing cooperative-stop vocabulary.
- [ ] A failed job shows its reason inline from the job's own log — not a link to somewhere else.
- [ ] The frontend entry point is `applyJobEvent(job)`, fed by the poller's diff, so the WebSocket
      ticket later swaps the feed without touching the UI (plan D8).
- [ ] **Verified on DEMO:** submit two jobs; the first runs, the second says it is behind one. Open
      a second slide and confirm both are still visible under `OTHER SLIDES`. Reload the page and
      confirm the list is unchanged.
