# 03 — The Runs section: everything that is running, everywhere

**What to build:** the answer to the original ask. One list, under the catalog, of every job in
flight or recently finished — across slides and across users — grouped with the current slide
first. A queued job says what is ahead of it. A running one can be stopped.

Its source is Girder's `GET /job`, which means the HistomicsTK CLIs are in it from the first commit
without any work (plan §1, "determined by fact").

**Blocked by:** 01 — jobs must exist as Girder jobs before there is anything to list.

**Status:** done

- [x] One global poller (~2.5 s), over a **new route** rather than `GET /job` — see below. Not one
      per panel, and not per-slide (plan D3).
- [x] Rows are grouped `THIS SLIDE` / `OTHER SLIDES`, with the slide named — a bare item id is not
      an answer to "what is ahead of me". Grouping is on the **image file**, not the item.
- [x] A queued row states its position. With `concurrency=1` this is the number that explains the
      wait, so it is not optional.
- [x] Progress renders the counts the job carries (`1 / 5 · nuclei`), falling back to a percent
      only when a job reports no total.
- [x] Stop is offered for running jobs and goes through `PUT /job/{id}/cancel`. A stopping job says
      `Stopping…` until it settles, matching the existing cooperative-stop vocabulary.
- [x] A failed job shows its reason inline from the job's own log — not a link to somewhere else.
- [x] The frontend entry point is `applyJobEvent(job)`, fed by the poller's diff, so the WebSocket
      ticket later swaps the feed without touching the UI (plan D8).
- [x] **Verified on DEMO:** submit two jobs; the first runs, the second says it is behind one. Open
      a second slide and confirm both are still visible under `OTHER SLIDES`. Reload the page and
      confirm the list is unchanged.

## Why `GET /job` could not be the source

The first criterion is the only one that changed, and it changed against three measurements:

1. **Scope.** `GET /job` lists *one user's* jobs (`job_rest.py:44`) and `GET /job/all` is
   `@access.admin`. D3's whole reason for a global list is that the A6000 is shared — this
   deployment has seven users — so a queue position is unexplainable without the run ahead of you.
2. **The join key is filtered out.** `pathassist` — the `girder_job_other_fields` carrying kind,
   item and artHash — is stored on the job doc and dropped by `exposeFields` (`models/job.py:29`).
   Ticket 01 already flagged this as this ticket's problem.
3. **The alternatives are credentials.** The fields that *would* identify the slide each hold a
   live Girder token: `kwargs.girder_token`, `_original_params.girderToken`
   (`rest_slicer_cli.py:460`), `jobInfoSpec.headers['Girder-Token']`. A row that filtered a job doc
   would be one forgotten key away from publishing a token to every authenticated browser.

So `GET /pathassist/runs` builds each row field by field, joins it to its slide, and redacts what
the caller cannot read — the one route D3 budgeted for. A row the caller has no READ access to is
still returned, named `Another user's run` and carrying only `status`, `created`, `lane` and
`started`: exactly the fields a position is computed from, none of which say whose work it is.

## Three things the deployment corrected

- **A CLI and a native run on the same slide named two different items.** A docker CLI's slide is
  recovered from its submitted params by resolving a file id to `file['itemId']` — upstream's own
  rule (`prepare_task.py:298-310`). On a `copyOfItem` that lands on the **original**, while the
  native run names the copy the user opened. Grouping on the item split one slide into two groups.
  Rows now carry `slideKey` = the `largeImage.fileId`, which is what upstream already treats as the
  slide's identity (`ItemSelectorWidget.js:249`), and the two rows sit together.
- **The reason is the *first* line of the log, not the last.** `girder_worker/app.py:180` formats a
  failure as `'%s: %s\n%s' % (type, exception, format_tb(...))` — exception first, frames after,
  which is not Python's own traceback layout. Taking the tail returned
  `raise ServiceRefused(f"{kind} was refused ...")` where the answer was
  `ServiceRefused: nuclei was refused (400): slide_ref is required`.
- **`Stopping…` is the wrong word for a run that never started.** `PUT /job/{id}/cancel` puts any
  live job into CANCELING (`event_handlers.py:107`) and leaves it for its runner to settle. A
  *queued* run has no runner: celery holds the revoked message in the worker's prefetch buffer and
  only discovers the revocation at execute time, which at `--concurrency=1` is after the run ahead
  finishes. Measured: 824 for the full 60 s a probe was watched, then settled the instant the
  previous task returned. So 824 means two different things, and the job's own status history
  (`timestamps`) separates them. A run that reached RUNNING says `Stopping…`; one that never did
  says `Cancelled · the worker drops it after the run ahead`. This is the same correction ticket 01
  made for INACTIVE, on the other end of the run.

  It also has a knock-on: a cancelled-but-undiscarded run costs the worker milliseconds, so it is
  not counted in anyone's "N ahead" and not counted as active. A unit test caught the two counters
  disagreeing before the browser did.

## Where the section sits

Under the catalog, as the ticket says, and **pinned** there rather than following it in the scroll.
The catalog is nineteen rows deep; a Runs section below it in the same scroll container was, in the
first browser run, the one part of the panel never on screen — which is the problem it exists to
fix. It gets the bottom 45 % of the panel and scrolls internally.

`applyJobEvent(job)` is the store's only mutator. `syncRuns(page)` is built on top of it and adds
the one thing an event feed cannot do for itself: forgetting a row the page no longer lists. An
identical row is a no-op down to object identity, so a 2.5 s poll over a quiet queue does not
re-render the panel twice a second.

## What the runs showed (2026-08-01, DEMO slide)

- **The queue explains itself.** Two nuclei runs back to back: `Nuclei · C` **Running** with
  `1 / 5 · nuclei` and a bar, `Nuclei · D` **Waiting** with `Waiting · 1 ahead`, header `2 active`.
- **The counts are the job's own words.** The row repeats `progress.message`, which the driver
  composed from the numbers the service reported — it never recomputes a message that exists, so
  the row and the job cannot disagree on screen. A percentage appears only where there is no
  message.
- **A CLI submitted from the panel appears in the same list**, under the same slide, beside the
  native runs — `Compute Background Intensity` alongside `Nuclei segmentation`.
- **Another slide keeps them visible.** Opening `BRACS_1647` moved both DEMO runs under
  `OTHER SLIDES` with `TCGA-WT-AB44…svs` named on each row, and surfaced that slide's own history
  under `THIS SLIDE` — including a failed run showing
  `ServiceRefused: nuclei was refused (400): slide_ref is required` in the row itself.
- **Reload changes nothing** but the tail: the in-flight rows returned identical, and the oldest
  settled row had aged off the fifteen-row history. The list is server state.
- **Stop, end to end.** Click → `Stopping…` in the same tick → the driver logged
  `asked the nuclei service to stop job ccfe3bb28447` → ~20 s later the Girder job settled
  `CANCELED` with progress `stopped` at 98/100, and the row read **Stopped**, not Failed.

Suppressed on the way through: a finished run's last progress reading is `done` at 100 %, a line
that only repeats the status badge beside it. A *stopped* run keeps its, because how far it got is
the whole question.

Noted, not fixed: row titles truncate in a narrow panel, so `Nuclei segmentation · first` and
`· second` are told apart by hover rather than at a glance. And there is still no `?item=` route,
so a reload returns to the collection browser — pre-existing, first noted in 02.
