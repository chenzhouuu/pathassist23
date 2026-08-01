# 07 — Whole-slide nuclei: coverage, stop, resume

**What to build:** Run nuclei over a whole slide from the Nuclei panel, watch the mask fill in tile
by tile, stop it mid-run, and resume it later without recomputing or double-counting what is already
done. This is the cooperative-stop and coverage machinery the tissue map already has, inherited by
the nuclei service.

**Blocked by:** 06 — The nuclei mask on the slide.

**Status:** ready-for-agent

- [ ] Starting a whole-slide run shows coverage growing on the slide, tile by tile, without a manual
      refresh.
- [ ] Stop halts the run within seconds and leaves the artifact in a stopped state the panel names —
      not a state that reads as failed or as ready.
- [ ] Resume continues from the stored coverage; the nucleus count after resume equals what a single
      uninterrupted run would produce, with no double-counting.
- [ ] Coverage and tallies are written atomically together: the tallies always describe exactly the
      tiles listed as done, at every point a reader can observe (the Inc 4 invariant).
- [ ] Record real disk usage and wall-clock for one whole-slide run before whole-slide is offered as
      a routine action — the store resolution is 16× the tissue map's pixel density (plan R3).
