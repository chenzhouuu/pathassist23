# 03 — The eye is the only visibility switch

**What to build:** Clicking a row's eye in the Workspace is what puts an overlay on the slide and
takes it off — for every drawable artifact. Today three different mechanisms do this (a panel's local
state, a global boolean, an annotation map); they collapse into one map keyed by artifact hash
(decision D7). The three panels keep their parameter controls and lose their on/off switches. The
Workspace moves to the front of the tab bar and becomes where ai-users land.

**Blocked by:** 02 — The Workspace lists the slide's real artifacts.

**Status:** ready-for-agent

- [ ] Visibility lives in one store map keyed by artifact hash; toggling a row's eye mounts or
      unmounts that artifact's layer on the viewer.
- [ ] Tissue, biomarker and segmentation rows each toggle their real overlay from the Workspace.
- [ ] The Tissue, Markers and Preprocess panels no longer contain an on/off control; changing a
      parameter in them still re-renders the layer that the Workspace has switched on.
- [ ] The old global tissue-overlay boolean no longer exists in the store when the ticket closes.
- [ ] Switching slides drops visibility state along with the rest of the per-slide state — no overlay
      from the previous slide survives.
- [ ] The Workspace is the first tab and the default tab for ai-users; other roles are unaffected.
