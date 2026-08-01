# 04 — Delete an artifact from the Workspace

**What to build:** A row in the Workspace can be deleted, and deleting it really frees the disk. If
anything in the DAG was built on top of it, the delete is refused and the user is told what is
holding it. Delete never cascades — one click must not be able to erase hours of GPU time
(decision D8).

Part of the service-side work already exists uncommitted in the working tree (tissue and biomarker
delete endpoints plus their tests); land it as part of this ticket.

**Blocked by:** 02 — The Workspace lists the slide's real artifacts.

**Status:** done

- [x] Deleting a leaf artifact (e.g. a tissue map) removes the row and its on-disk directory; a page
      reload does not bring it back, and the freed space is real.
- [x] Deleting an artifact something was built from is refused, and the dialog names the dependants
      by kind and params rather than by hash alone.
- [x] The confirm dialog names the artifact and its size before anything is removed.
- [x] The durable row is removed before the directory, so an interrupted delete leaves a recoverable
      orphan directory rather than a row pointing at nothing; re-issuing the delete finishes the job
      (the service-side delete is idempotent — an already-gone directory is a success).
- [x] Every kind's owning service accepts the delete, including the preprocess-owned kinds.
- [x] No path in this feature ever cascades.

## Comments

The biomarker half of the working-tree WIP was tests without a route — those three had never
passed. The route landed here.

`usage` answers size and dependants in one call. Asking separately invites a dialog that offers a
size for something it is then refused permission to delete.

A refusal is not a confirm dialog. There is nothing for the user to agree to, so it is shown in the
panel with the dependants named the way their own rows name them.

The preprocess service owns four kinds, so its route takes the row's `kind` and maps it to its own
directory layout; the gateway never learns that layout. Tissue and biomarker own one kind each, so
theirs is implicit in the path.

A worker that cannot be reached still returns 204: the row is gone, so the artifact is gone as far
as the app is concerned, and failing a delete the user cannot retry would be worse than the orphan
directory the next build of that hash overwrites.

Verified: 267 frontend tests (16 new), agent 217, tissue 98, biomarker map routes 17 — all green.
`preprocess/test_predict.py` and `biomarker/test_infer.py` fail identically on HEAD (torch
environment) and are untouched by this ticket. Clicked through in the running app by Chen.
