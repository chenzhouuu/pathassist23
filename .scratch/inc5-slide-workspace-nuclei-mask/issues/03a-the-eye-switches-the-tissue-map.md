# 03a — The eye switches the tissue map, from any tab

**What to build:** Click the eye on a tissue row in the Workspace and the tissue map appears on the
slide; click it again and it goes. It stays on while you move around the app — the Workspace, the
Tissue panel, Info, anywhere — because visibility now belongs to the slide's state rather than to a
panel that unmounts when you leave its tab.

This is half of the original ticket 03. The split is forced by what the code does today: the tissue
map's tile layer is mounted by `TissuePanel`, which removes it on unmount, and the right panel
unmounts a panel whenever you switch tabs. An eye in the Workspace could never have worked over
that. The repo already has the right shape for its canvas overlays — always mounted beside the
viewer, driven by the store — and this ticket brings the tile pyramids into it, for tissue only.

**Blocked by:** 02 — The Workspace lists the slide's real artifacts.

**Status:** done

- [x] Visibility lives in one store map keyed by artifact hash, shaped after the existing annotation
      visibility map; nothing else decides whether the tissue map is on screen.
- [x] Toggling a tissue row's eye mounts and unmounts the map, and it survives switching to any
      other tab and back.
- [x] The Tissue panel no longer has an on/off control. Its render parameters — layer, opacity,
      confidence floor, hidden classes, H&E fade — still change what is on screen, including while
      the panel was never opened and the eye was clicked in the Workspace.
- [x] Nothing mounts itself: opening a slide that already has a tissue artifact shows no overlay
      until its eye is clicked. This replaces the panel's default-on, and is what the ask asks for.
- [x] Switching slides drops visibility along with the rest of the per-slide state — no overlay from
      the previous slide survives and no layer is left stranded on the viewer.
- [x] Rows whose kind the viewer cannot yet switch carry no eye, so no eye in the UI is inert.

## Comments

Two deviations from D7's `{ [art_hash]: bool }`, both forced by what the reader needs:

- **The value is `{ kind }`, not a boolean.** ArtifactLayers has to know what to mount, and the
  Workspace is the only place that already holds it. A boolean would have sent the viewer back to
  the artifact list to look it up.
- **One layer slot per kind, so switching a second tissue map on switches the first off.** Without
  that rule the first row keeps an open eye over a map that is no longer drawn.

`canSwitch` is deliberately narrower than `canDraw` for the length of this ticket: segmentation and
biomarker can be drawn, but their layer owners have not moved across yet, and an inert eye is worse
than no eye. The two converge in 03b and `canSwitch` goes away with the gap.

Consequence carried into 03b: render parameters live in the store rather than in the panel, because
the layer keeps rendering while the panel that owns those controls is closed.

Verified: 248 tests green (12 new), typecheck and build clean, and clicked through in the running
app by Chen — including the point of the ticket, that the map survives a tab switch.
