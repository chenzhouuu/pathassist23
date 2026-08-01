# 08 — Instance-id raster

**What to build:** A second raster in which every nucleus carries its own identity rather than its
class, written in the OME-NGFF `labels` convention (instance id packed into RGBA). The Nuclei panel
gains a switch between the class view and the instance view, which is how you can see that the ids
are there and correct. This is what makes per-nucleus hover and selection possible later without
shipping a million polygons to the browser.

**Blocked by:** 06 — The nuclei mask on the slide.

**Status:** done

- [x] Instance tiles are written in the same rasterisation pass as the class tiles, from the same
      rings — not a second inference and not a second walk over the slide.
- [x] The Nuclei panel switches the layer between classes and instances.
- [x] In the instance view, adjacent nuclei are visibly distinct — touching nuclei do not merge into
      one blob.
- [x] Ids are unique within the artifact and stable across stop/resume: interrupt a run, resume it,
      and a nucleus computed before the stop keeps the same id (and therefore the same colour).
- [x] The packing follows the OME-NGFF `labels` convention, so a future export is a re-container
      rather than a re-compute.
- [x] No client-side picking or hover is wired up — this ticket makes it possible, not present
      (plan §9).
