# 06 — The nuclei mask on the slide

**What to build:** Switch on the nuclei row's eye and see the nuclei — each one filled with its class
colour, aligned with the H&E at every zoom, stacking with the tissue and marker layers. The picture
is rasterised server-side from the polygons stored in 05 and served as pyramid tiles through the
authenticated proxy, the same way the tissue map already works (decision D5).

**Blocked by:** 05 — Nuclei as a stored artifact (region); 03a — The eye switches the tissue map
(the always-mounted layer owner and the visibility map; 03b is not needed).

**Status:** done

- [x] Class raster tiles and their pyramid are built from the stored rings at the nuclei store
      resolution (0.25 µm/px, plan §4.3), paletted rather than one plane per class.
- [x] Tiles are served through the authenticated tile proxy, like tissue and biomarker tiles.
- [x] Toggling the nuclei row's eye shows and hides the mask; it is aligned with the H&E at low and
      high zoom (check a vessel or a tissue edge, not just the centre).
- [x] The nuclei layer has a defined place in the layer stack and composes with a tissue map and a
      phenotype layer switched on at the same time.
- [x] Opacity is adjustable from the Nuclei panel; the class list and palette come from the
      artifact's own meta or the service catalog, never hardcoded in the frontend.
- [x] The rasterised nucleus count for a region matches the stored vector count — one number, one
      source (decision D3).
