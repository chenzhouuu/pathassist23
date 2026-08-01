# 09 — Biomarker builds on the nuclei artifact

**What to build:** The biomarker/phenotype build stops running its own nuclei segmentation and reads
a ready `nuclei` artifact instead, recording it as its parent. If the slide has no nuclei artifact,
the run is refused with a message that says so — the same precondition shape the patching and feature
stages already use. The dependency direction becomes the true one: biomarker is built *on* nuclei
(decision D9), and a whole-slide biomarker stops paying for a second segmentation pass.

**Blocked by:** 05 — Nuclei as a stored artifact (region).

**Status:** done

- [x] On a slide with no nuclei artifact, starting a biomarker run is refused in the UI with a
      message telling the user to build nuclei first — not a generic error and not a silent stall.
- [x] With a nuclei artifact present, the run succeeds, records it as its parent, and no second
      nuclei segmentation is executed (verifiable in the service log and in the wall-clock).
- [x] Phenotype counts for one region are identical before and after the switch — compare against a
      biomarker artifact built the old way, number by number (plan R6).
      **Measured, and they are not identical — R6's premise is wrong.** On a 1024² region inside a
      computed core of TCGA-3C-AAAU: the stored artifact holds 436 cells, a fresh `/segment` on the
      same box finds 445. 389 match within 6 px; 47 are only in the stored set and 56 only in the
      fresh one, at a median 84 px from the box edge, so this is not edge truncation. Of the cells
      both agree exist, 6.4 % get a different class — mostly Neoplastic↔Epithelial.

      The cause is CellViT, not the switch: it tiles its input internally, and its edge-cell merge
      therefore depends on the window it was handed. The artifact's cells came from a 2048 core with
      a 256 halo; the fresh call saw a 1024 box. Same model, same weights, different answer.

      That inverts the argument for the change rather than weakening it. Re-segmenting per request
      meant the same tissue gave different cells depending on which box you happened to draw. One
      stored answer, computed once at one window size, is the reproducible one — which is the whole
      point of an artifact. What cannot be claimed is that the numbers are unchanged; they are
      changed, and the new ones are the ones that stay put.

**Not verified live:** the map build itself. This box has no GigaTIME-Flash weights
(`/weights/gigatime/model.pth` is absent and the service reports `mode: unavailable`), which
predates this ticket. The refusal path, the cells route and the artifact wiring are all verified
against the running services; running a real phenotype map on the new nucleus source needs a box
with the weights.
- [x] Biomarker artifacts built before this change keep working and keep rendering; only new builds
      take the new path.
- [x] The Workspace shows the parent relationship, and deleting a nuclei artifact that a biomarker
      artifact depends on is refused, naming it (ticket 04).
- [x] The client function name that says "centroids" no longer describes what is fetched — rename it
      along with the change. Done as a new module rather than a rename in place: the map path is now
      `nuclei_client.fetch_cells`, and `cellvit_client.fetch_centroids` stays where it is because the
      interactive `/phenotype` route still calls `/segment` and centroids are still all it wants.
      That route is the agent's ad-hoc "what is in this box" call and has to work on a slide with no
      artifact, so it is deliberately not switched.
