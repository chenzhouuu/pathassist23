# 03b — The eye owns every overlay, and the Workspace is where you land

**What to build:** What 03a did for the tissue map, done for the rest: the biomarker layer and the
segmentation outline are switched from the Workspace too, the panels that used to own those switches
keep only their parameters, and the last of the old mechanisms is deleted rather than left beside
the new one. The Workspace moves to the front of the tab bar and becomes where ai-users land, since
it now answers "what does this slide have" before you pick a panel to tune.

**Blocked by:** 03a — The eye switches the tissue map, from any tab.

**Status:** ready-for-agent

- [ ] A biomarker row's eye puts its layer on the slide and takes it off, from any tab. The Markers
      panel keeps the choice between its render modes and the per-channel controls, and loses the
      mode that only meant "off".
- [ ] A segmentation row's eye draws and hides the tissue outline. The Preprocess panel loses its
      View/Hide button; the outline it fetched is not re-fetched to switch it back on.
- [ ] The global tissue-overlay boolean is gone from the store — not shadowed, not derived, gone.
- [ ] Every drawable kind now has a working eye, so the distinction 03a introduced between "can be
      drawn" and "can currently be switched" disappears with it.
- [ ] The Workspace is the first tab and the default tab for ai-users; other roles are unaffected.
- [ ] Layers still stack: a tissue map, a biomarker layer and an outline switched on together
      compose in a defined order, and switching one off leaves the others alone.
