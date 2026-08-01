# 03b — The eye owns every overlay, and the Workspace is where you land

**What to build:** What 03a did for the tissue map, done for the rest: the biomarker layer and the
segmentation outline are switched from the Workspace too, the panels that used to own those switches
keep only their parameters, and the last of the old mechanisms is deleted rather than left beside
the new one. The Workspace moves to the front of the tab bar and becomes where ai-users land, since
it now answers "what does this slide have" before you pick a panel to tune.

**Blocked by:** 03a — The eye switches the tissue map, from any tab.

**Status:** done

- [x] A biomarker row's eye puts its layer on the slide and takes it off, from any tab. The Markers
      panel keeps the choice between its render modes and the per-channel controls, and loses the
      mode that only meant "off".
- [x] A segmentation row's eye draws and hides the tissue outline. The Preprocess panel loses its
      View/Hide button; the outline it fetched is not re-fetched to switch it back on.
- [x] The global tissue-overlay boolean is gone from the store — not shadowed, not derived, gone.
- [x] Every drawable kind now has a working eye, so the distinction 03a introduced between "can be
      drawn" and "can currently be switched" disappears with it.
- [x] The Workspace is the first tab and the default tab for ai-users; other roles are unaffected.
- [x] Layers still stack: a tissue map, a biomarker layer and an outline switched on together
      compose in a defined order, and switching one off leaves the others alone.

## Comments

`tissueContours` became a cache keyed by segmentation hash rather than a single document. That is
what makes "not re-fetched to switch it back on" true, and it also removes a way for one
segmentation's outline to be painted under another's name.

Removing the Markers panel's `he` mode had one consequence worth naming: the research-use footnote
used to be gated on `mode !== 'he'`, so it now shows unconditionally. It is a claim about what the
numbers are, not about which picture is up, so the gate was wrong to begin with.

`canSwitch` and `canDraw` now return the same answer. Both names stay because they ask different
questions of it — one about the artifact, one about what the viewer can mount — and ticket 06 adds
`nuclei` to each for its own reason.

The landing tab is resolved rather than stored: `rightPanelTab` starts null, meaning "not picked",
and RightPanel opens the first tab the role can see. A click pins it.

Verified: 257 tests green (8 new), typecheck and build clean, and clicked through in the running app
by Chen with all three overlays stacked.
