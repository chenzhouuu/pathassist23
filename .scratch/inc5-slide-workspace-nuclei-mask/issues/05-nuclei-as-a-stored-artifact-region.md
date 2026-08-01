# 05 — Nuclei as a stored artifact (region), counts in the UI

**What to build:** A **Nuclei** panel — same shape as the Tissue panel: draw a region, pick a
backend, run — whose result is a stored `nuclei` artifact rather than a pile of Girder point
annotations. The per-nucleus polygon that the segmenter already computes and currently throws away is
kept. The panel reports the nucleus count, class mix and area **read back from the stored artifact**,
and a `nuclei` row appears in the Workspace.

There is no picture in this ticket. What it delivers is that the contours are on disk and addressable
— the mask is 06.

**Blocked by:** 02 — The Workspace lists the slide's real artifacts; 04 — Delete an artifact from the
Workspace. (04 is not a technical gate; it is here because 05–08 accumulate hundreds of MB of trial
artifacts and there must be a way to remove them from the UI. Drop the edge if you would rather run
the two in parallel.)

**Status:** done

- [x] A Nuclei panel exists: region selection, run, progress, errors. No backend chooser — there is
      exactly one backend today, so the artifact records which one produced it (`backend=cellvit-sam-h`
      is part of the hash) but the panel does not offer a choice it cannot honour.
- [x] The panel's counts are read back from the stored artifact, not held over from the inference
      call — reload the page and the same numbers come back.
- [x] Vector truth is stored per core tile with, per nucleus: centroid in level-0 slide pixels, class
      index, CSR ring offsets, ring points **relative to the tile origin**, and an instance id unique
      within the artifact (plan §4.1).
- [x] The artifact carries meta, coverage and summary in the same layout the tissue and biomarker
      artifacts use, so the third copy stays recognisable as a copy.
- [x] A `nuclei` row appears in the Workspace with its brief line (n nuclei · mm² · class mix) and no
      eye yet.
- [x] Ring round-trip: rings read back from storage reproduce the same nucleus count and class
      histogram as the inference output.
- [x] Deleting the nuclei row from the Workspace removes its directory (the owning service gains the
      delete endpoint added in 04).
- [x] The existing agent/Copilot nuclei path still works — this ticket adds an artifact path, it does
      not remove the annotation one. Existing point annotations stay as ordinary annotations; there
      is nothing to migrate, because the contour was never stored (plan §1).
