# 04 — Delete an artifact from the Workspace

**What to build:** A row in the Workspace can be deleted, and deleting it really frees the disk. If
anything in the DAG was built on top of it, the delete is refused and the user is told what is
holding it. Delete never cascades — one click must not be able to erase hours of GPU time
(decision D8).

Part of the service-side work already exists uncommitted in the working tree (tissue and biomarker
delete endpoints plus their tests); land it as part of this ticket.

**Blocked by:** 02 — The Workspace lists the slide's real artifacts.

**Status:** ready-for-agent

- [ ] Deleting a leaf artifact (e.g. a tissue map) removes the row and its on-disk directory; a page
      reload does not bring it back, and the freed space is real.
- [ ] Deleting an artifact something was built from is refused, and the dialog names the dependants
      by kind and params rather than by hash alone.
- [ ] The confirm dialog names the artifact and its size before anything is removed.
- [ ] The durable row is removed before the directory, so an interrupted delete leaves a recoverable
      orphan directory rather than a row pointing at nothing; re-issuing the delete finishes the job
      (the service-side delete is idempotent — an already-gone directory is a success).
- [ ] Every kind's owning service accepts the delete, including the preprocess-owned kinds.
- [ ] No path in this feature ever cascades.
