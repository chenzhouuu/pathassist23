# 07 — Whole-slide nuclei: coverage, stop, resume

**What to build:** Run nuclei over a whole slide from the Nuclei panel, watch the mask fill in tile
by tile, stop it mid-run, and resume it later without recomputing or double-counting what is already
done. This is the cooperative-stop and coverage machinery the tissue map already has, inherited by
the nuclei service.

**Blocked by:** 06 — The nuclei mask on the slide.

**Status:** done

- [x] Starting a whole-slide run shows coverage growing on the slide, tile by tile, without a manual
      refresh.
- [x] Stop halts the run within seconds and leaves the artifact in a stopped state the panel names —
      not a state that reads as failed or as ready.
- [x] Resume continues from the stored coverage; the nucleus count after resume equals what a single
      uninterrupted run would produce, with no double-counting.
- [x] Coverage and tallies are written atomically together: the tallies always describe exactly the
      tiles listed as done, at every point a reader can observe (the Inc 4 invariant).
- [x] Record real disk usage and wall-clock for one whole-slide run before whole-slide is offered as
      a routine action — the store resolution is 16× the tissue map's pixel density (plan R3).
      **Measured on TCGA-3C-AAAU (151392×37993, 434 tissue cores of 1406):** 65 minutes end to end
      and 347 MB, for 323,634 nuclei — about 9 s and 0.8 MB per core, of which ~7 minutes is the
      finalisation pass that fixes the seams. The guard is in too: the worker refuses a whole-slide
      start below `CELLVIT_MIN_FREE_GB` (20 GB) and says the number, because filling the volume
      mid-job leaves a half-written pyramid that renders as holes rather than as an error.

      The number that decides whether this is routine is not the hour — it is that the run has to
      be watched. See the recycle note in the tracker README: without it the worker wedges after
      twenty-odd cores and nothing here can interrupt it.
