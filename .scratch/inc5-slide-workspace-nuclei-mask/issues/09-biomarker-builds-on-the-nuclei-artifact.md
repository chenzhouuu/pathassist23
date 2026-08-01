# 09 — Biomarker builds on the nuclei artifact

**What to build:** The biomarker/phenotype build stops running its own nuclei segmentation and reads
a ready `nuclei` artifact instead, recording it as its parent. If the slide has no nuclei artifact,
the run is refused with a message that says so — the same precondition shape the patching and feature
stages already use. The dependency direction becomes the true one: biomarker is built *on* nuclei
(decision D9), and a whole-slide biomarker stops paying for a second segmentation pass.

**Blocked by:** 05 — Nuclei as a stored artifact (region).

**Status:** ready-for-agent

- [ ] On a slide with no nuclei artifact, starting a biomarker run is refused in the UI with a
      message telling the user to build nuclei first — not a generic error and not a silent stall.
- [ ] With a nuclei artifact present, the run succeeds, records it as its parent, and no second
      nuclei segmentation is executed (verifiable in the service log and in the wall-clock).
- [ ] Phenotype counts for one region are identical before and after the switch — compare against a
      biomarker artifact built the old way, number by number (plan R6).
- [ ] Biomarker artifacts built before this change keep working and keep rendering; only new builds
      take the new path.
- [ ] The Workspace shows the parent relationship, and deleting a nuclei artifact that a biomarker
      artifact depends on is refused, naming it (ticket 04).
- [ ] The client function name that says "centroids" no longer describes what is fetched — rename it
      along with the change.
