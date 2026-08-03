// src/store/index.js
import { create } from 'zustand';

export const useStore = create((set, get) => ({
  // ── Auth ────────────────────────────────────────────────────────────────
  token: localStorage.getItem('girderToken') || null,
  user: JSON.parse(localStorage.getItem('girderUser') || 'null'),
  userGroups: JSON.parse(localStorage.getItem('girderGroups') || '[]'),
  setAuth: (token, user) => {
    localStorage.setItem('girderToken', token);
    localStorage.setItem('girderUser', JSON.stringify(user));
    set({ token, user });
  },
  setUserGroups: (groups) => {
    localStorage.setItem('girderGroups', JSON.stringify(groups));
    set({ userGroups: groups });
  },
  // Feature → which groups can access it.
  // Girder site admins (user.admin) bypass all checks automatically.
  ROLE_MAP: {
    'worklist-users':          ['lab-manager', 'pathologist', 'fellow', 'researcher', 'lab-technician'],
    'annotation-users':        ['lab-manager', 'pathologist', 'fellow', 'researcher', 'second-opinion-reviewer', 'individual', 'lab-technician', 'lab-admin'],
    'ai-users':                ['lab-manager', 'pathologist', 'fellow', 'researcher'],
    'import-users':            ['lab-manager'],
    'case-create-users':       ['lab-manager', 'pathologist'],
    'projects-users':          ['lab-manager', 'pathologist'],
    'second-opinion-users':    ['lab-manager', 'pathologist', 'fellow', 'second-opinion-reviewer', 'referring-physician'],
    'referring-portal-users':  ['referring-physician'],
    'patient-portal-users':    ['patient'],
  },

  // Org collection this user belongs to (resolved post-login from their Girder groups).
  activeOrgCollection: null,
  setActiveOrgCollection: (col) => set({ activeOrgCollection: col }),
  // hasRole('projects-users') → true if user is admin OR belongs to any group
  // that is mapped to that feature in ROLE_MAP.
  hasRole: (feature) => {
    const { user, userGroups, ROLE_MAP } = get();
    if (!user) return false;
    if (user.admin) return true;
    const allowed = ROLE_MAP[feature] ?? [feature]; // fallback: treat as literal group name
    return userGroups.some((g) => allowed.includes(g.name));
  },
  clearAuth: () => {
    localStorage.removeItem('girderToken');
    localStorage.removeItem('girderUser');
    localStorage.removeItem('girderGroups');
    set({ token: null, user: null, userGroups: [] });
  },

  // ── Page routing ─────────────────────────────────────────────────────────
  currentPage: 'browse',
  setPage: (page) => set({ currentPage: page }),

  // ── Navigation ───────────────────────────────────────────────────────────
  activeCollection: null,
  activeFolder: null,
  activeItem: null,
  breadcrumb: [],
  setActiveCollection: (col) =>
    set({
      activeCollection: col,
      activeFolder: null,
      // activeItem is intentionally NOT cleared — the viewer keeps the current
      // slide while the user browses collections/folders. Only setActiveItem resets it.
      breadcrumb: col ? [col] : [],
    }),
  setActiveFolder: (folder) => {
    if (!folder) {
      const { activeCollection } = get();
      set({
        activeFolder: null,
        breadcrumb: activeCollection ? [activeCollection] : [],
      });
      return;
    }
    const { breadcrumb } = get();
    const idx = breadcrumb.findIndex((b) => b._id === folder._id);
    const newCrumb = idx >= 0 ? breadcrumb.slice(0, idx + 1) : [...breadcrumb, folder];
    set({ activeFolder: folder, breadcrumb: newCrumb });
  },
  clearActiveNavigation: () =>
    set({ activeCollection: null, activeFolder: null, activeItem: null, breadcrumb: [],
          copilotRoi: null, shownRoi: null, roiSelectResult: null, copilotNuclei: null,
          copilotPhenotypes: null,
          copilotRegions: [], tissueContours: {}, taskHeatmap: null,
          visibleArtifacts: {}, tissueLayerParams: {}, markerLayerParams: {}, nucleiLayerParams: {}, artifactRuns: {} }),
  setActiveItem: (item) => {
    const { breadcrumb, autoCollapseViewerPanels } = get();
    const filtered = breadcrumb.filter((b) => b._type !== 'item');
    set({
      activeItem: item,
      annotations: [],          // clear stale annotations on item change
      visibleAnnotations: {},
      selectedAnnotation: null,
      drawingMode: null,
      copilotMessages: [], copilotConversationId: null, copilotStreaming: false, copilotError: null,
      copilotRoi: null, shownRoi: null, roiSelectResult: null, copilotNuclei: null, copilotPhenotypes: null, copilotRegions: [], tissueContours: {}, taskHeatmap: null,   // drop grounded/shown region + overlay from the old slide
      visibleArtifacts: {},      // the new slide's artifacts are its own; nothing carries over
      tissueLayerParams: {}, markerLayerParams: {}, nucleiLayerParams: {}, artifactRuns: {},
      breadcrumb: [...filtered, { ...item, _type: 'item' }],
      currentPage: 'viewer',
      caseContext: null,        // clear case context when opening a slide outside a case
      leftPanelOpen: autoCollapseViewerPanels ? false : get().leftPanelOpen,
      rightPanelOpen: autoCollapseViewerPanels ? false : get().rightPanelOpen,
      rightRailVisible: autoCollapseViewerPanels ? true : get().rightRailVisible,
    });
  },

  // ── Case Context ──────────────────────────────────────────────────────────
  // Set when opening a Second Opinion case — restricts sidebar to case images only.
  caseContext: null, // { caseId, folderId, items: [{ _id, name }] } | null
  setCaseContext: (ctx) => set({ caseContext: ctx }),
  clearCaseContext: () => set({ caseContext: null }),

  // Open a case: sets both caseContext and activeItem without clearing caseContext.
  openCaseItem: (item, ctx) => {
    const { breadcrumb, autoCollapseViewerPanels } = get();
    const filtered = breadcrumb.filter((b) => b._type !== 'item');
    set({
      activeItem: item,
      annotations: [],
      visibleAnnotations: {},
      selectedAnnotation: null,
      drawingMode: null,
      copilotMessages: [], copilotConversationId: null, copilotStreaming: false, copilotError: null,
      copilotRoi: null, shownRoi: null, roiSelectResult: null, copilotNuclei: null, copilotPhenotypes: null, copilotRegions: [], tissueContours: {}, taskHeatmap: null,   // drop grounded/shown region + overlay from the old slide
      visibleArtifacts: {},      // the new slide's artifacts are its own; nothing carries over
      tissueLayerParams: {}, markerLayerParams: {}, nucleiLayerParams: {}, artifactRuns: {},
      breadcrumb: [...filtered, { ...item, _type: 'item' }],
      currentPage: 'viewer',
      caseContext: ctx,
      leftPanelOpen: autoCollapseViewerPanels ? false : get().leftPanelOpen,
      rightPanelOpen: autoCollapseViewerPanels ? false : get().rightPanelOpen,
      rightRailVisible: autoCollapseViewerPanels ? true : get().rightRailVisible,
    });
  },

  // ── Viewer ───────────────────────────────────────────────────────────────
  viewer: null,
  setViewer: (v) => set({ viewer: v }),
  tilesInfo: null,
  setTilesInfo: (info) => set({ tilesInfo: info }),

  // ── Annotations ──────────────────────────────────────────────────────────
  annotations: [],         // full annotation objects (with elements loaded)
  setAnnotations: (anns) => set({ annotations: anns }),

  // visibleAnnotations: { [annId]: bool } — true = visible, undefined = visible (default)
  visibleAnnotations: {},
  setAnnotationVisible: (id, visible) => {
    const { visibleAnnotations } = get();
    set({ visibleAnnotations: { ...visibleAnnotations, [id]: visible } });
  },
  toggleAnnotationVisibility: (id) => {
    const { visibleAnnotations } = get();
    const current = visibleAnnotations[id] !== false; // default visible
    set({ visibleAnnotations: { ...visibleAnnotations, [id]: !current } });
  },
  showAllAnnotations: () => set({ visibleAnnotations: {} }),
  hideAllAnnotations: () => {
    const { annotations } = get();
    const hidden = {};
    annotations.forEach(a => { hidden[a._id] = false; });
    set({ visibleAnnotations: hidden });
  },

  // Selected annotation (highlighted in list + on canvas)
  selectedAnnotation: null,
  setSelectedAnnotation: (ann) => set({ selectedAnnotation: ann }),

  // Drawing state
  drawingMode: null,  // null | 'point' | 'rectangle' | 'polygon' | 'polyline' | 'ellipse'
  setDrawingMode: (mode) => set({ drawingMode: mode }),
  drawColor: '#4da6ff',
  setDrawColor: (c) => set({ drawColor: c }),
  drawLineWidth: 2,
  setDrawLineWidth: (w) => set({ drawLineWidth: w }),
  drawLabel: '',
  setDrawLabel: (l) => set({ drawLabel: l }),
  drawGroup: 'default',
  setDrawGroup: (g) => set({ drawGroup: g }),

  // ROI selection: triggered by Analysis panel "Draw ROI" button;
  // AnnotationCanvas captures the rectangle and calls setRoiSelectResult.
  // This is a transient handoff mailbox — "a box was just drawn" — consumed once.
  roiSelectResult: null,                             // { x, y, width, height } in image pixels
  setRoiSelectResult: (r) => set({ roiSelectResult: r }),
  clearRoiSelectResult: () => set({ roiSelectResult: null }),

  // Copilot region state, split into two concerns:
  //  - copilotRoi: the region attached to the NEXT message (the composer chip). STICKY —
  //                it survives sends, page refreshes, and re-opening the slide until the
  //                user clears it (✕ / New) or draws a new box. Persisted per slide in
  //                localStorage (key `pathassist_copilot_roi_<itemId>`) so a hard refresh
  //                (which resets activeItem) still brings it back. Sentinel semantics:
  //                a stored '' means "explicitly cleared" (stay empty on reload); an absent
  //                key means "never set" (fall back to the conversation's last region).
  //  - shownRoi:   the region currently PAINTED on the viewer overlay (AnnotationCanvas). Driven
  //                by clicking a coordinate chip to reveal a region; independent of attachment.
  // Both are in image pixels. shownRoi is dropped on slide change; copilotRoi persists per slide.
  copilotRoi: null,                                  // { x, y, width, height } | null
  setCopilotRoi: (r) => {
    const item = get().activeItem?._id;
    if (item) {
      try { localStorage.setItem(`pathassist_copilot_roi_${item}`, r ? JSON.stringify(r) : ''); }
      catch { /* localStorage unavailable */ }
    }
    set({ copilotRoi: r });
  },
  // Restore the sticky region when a slide becomes active. localStorage wins (it holds the
  // user's staged box + explicit-clear intent for this slide); `fallbackRoi` (the loaded
  // conversation's last region) is adopted only when the slide has no stored value yet.
  restoreCopilotRoi: (itemId, fallbackRoi = null) => {
    if (!itemId) { set({ copilotRoi: null }); return; }
    const key = `pathassist_copilot_roi_${itemId}`;
    let roi = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) {                 // never set on this slide → adopt the conversation's region
        roi = fallbackRoi || null;
        if (roi) localStorage.setItem(key, JSON.stringify(roi));
      } else if (raw !== '') {            // '' = explicitly cleared → stay empty
        roi = JSON.parse(raw);
      }
    } catch { roi = null; }
    set({ copilotRoi: roi });
  },
  shownRoi: null,                                    // { x, y, width, height } | null
  setShownRoi: (r) => set({ shownRoi: r }),

  // Copilot nuclei overlay (increment 5): the geometry a plan run produced, painted by
  // NucleiOverlay and toggled from the viewer toolbar. Setting new nuclei shows them.
  copilotNuclei: null,                               // { points:[[x,y]], level0, count, ... } | null
  showNucleiOverlay: true,
  setCopilotNuclei: (n) => set({ copilotNuclei: n, showNucleiOverlay: true }),
  clearCopilotNuclei: () => set({ copilotNuclei: null }),
  toggleNucleiOverlay: () => set((s) => ({ showNucleiOverlay: !s.showNucleiOverlay })),

  // Copilot cell-phenotype overlay (increment 3a): the per-cell phenotypes a phenotype_cells run
  // produced ({ points, classes:lineage, cells:[{phenotype,flags,markers}] }), painted by
  // PhenotypeOverlay. Setting new phenotypes shows them.
  copilotPhenotypes: null,
  showPhenotypeOverlay: true,
  setCopilotPhenotypes: (p) => set({ copilotPhenotypes: p, showPhenotypeOverlay: true }),
  clearCopilotPhenotypes: () => set({ copilotPhenotypes: null }),
  togglePhenotypeOverlay: () => set((s) => ({ showPhenotypeOverlay: !s.showPhenotypeOverlay })),

  // Copilot region overlay (increment 2c): the regions a describe_region call read, painted
  // as labelled rectangles by RegionOverlay. Each is { bbox:{x,y,width,height}, magnification }.
  // Accumulated across a turn (a Perceptor may describe several regions), keyed by bbox so a
  // re-described region doesn't duplicate. Adding a region reveals the overlay.
  copilotRegions: [],
  showRegionsOverlay: true,
  addCopilotRegion: (r) => set((s) => {
    if (!r?.bbox) return {};
    const key = (b) => `${b.x},${b.y},${b.width},${b.height}`;
    const k = key(r.bbox);
    const rest = s.copilotRegions.filter((x) => key(x.bbox) !== k);
    return { copilotRegions: [...rest, r], showRegionsOverlay: true };
  }),
  clearCopilotRegions: () => set({ copilotRegions: [] }),
  toggleRegionsOverlay: () => set((s) => ({ showRegionsOverlay: !s.showRegionsOverlay })),

  // Tissue segmentation overlay (Inc 2b-3): the tissue contours a segmentation stage produced,
  // painted as outlined polygons by TissueOverlay and toggled from the Preprocess panel. GeoJSON
  // FeatureCollection of Polygons in level-0 px. Setting contours reveals the overlay; dropped on
  // slide change (like the copilot region overlays).
  // Keyed by the segmentation artifact it came from, so switching the outline back on is free —
  // and so the cache can never paint one segmentation's contours under another's name. Whether it
  // is drawn is not recorded here: that is `visibleArtifacts`, like every other overlay
  // (Inc 5 · 03b removed the `showTissueOverlay` boolean that used to be a second answer).
  tissueContours: {},                                // { [seg_hash]: GeoJSON FeatureCollection }
  cacheTissueContours: (hash, gj) =>
    set((s) => ({ tissueContours: { ...s.tissueContours, [hash]: gj } })),

  // ── Artifact visibility (Inc 5 · D7) ──────────────────────────────────────
  // Which of the slide's artifacts are on the viewer, keyed by artifact hash. The Workspace's eye
  // is the only thing that writes here, and ArtifactLayers is the only thing that reads it to
  // mount a layer, so "what is on screen" has exactly one answer.
  //
  // The value is `{ kind }` rather than D7's bare boolean: the reader needs to know what to mount
  // and the writer is the only place that knows, so carrying it avoids a second lookup of the
  // artifact list from inside the viewer.
  //
  // Absent = not shown. Nothing defaults to visible — a slide with a tissue map opens without it
  // until its eye is clicked, which is the whole point of the workspace.
  visibleArtifacts: {},                              // { [art_hash]: { kind } }
  setArtifactVisible: (hash, kind, visible) => {
    if (!hash) return;
    const next = { ...get().visibleArtifacts };
    if (!visible) {
      delete next[hash];
    } else {
      // One layer slot per kind, so switching on a second tissue map has to switch off the first.
      // Without this the second row's eye would be open over a map that is not drawn.
      for (const [h, v] of Object.entries(next)) if (v?.kind === kind) delete next[h];
      next[hash] = { kind };
    }
    set({ visibleArtifacts: next });
  },
  toggleArtifactVisible: (hash, kind) => {
    const on = !!get().visibleArtifacts[hash];
    get().setArtifactVisible(hash, kind, !on);
  },

  // Which artifacts are being built right now (Inc 5 · 07). Written by whichever panel is polling
  // the slide's rows, read by the layers — because a picture that is still being written has to be
  // asked for again as it grows, and only a poller knows it is still growing. The layers do not
  // poll for themselves: that would be a third timer for a fact two of them already have.
  //
  // Every writer polls the same full list for the same slide, so this is replaced wholesale
  // rather than merged.
  artifactRuns: {},                                  // { [art_hash]: true }
  noteArtifactRuns: (rows) => {
    const next = {};
    for (const r of rows || []) {
      if (r?.art_hash && (r.status === 'queued' || r.status === 'running')) next[r.art_hash] = true;
    }
    const prev = get().artifactRuns;
    const same = Object.keys(next).length === Object.keys(prev).length
      && Object.keys(next).every((k) => prev[k]);
    if (!same) set({ artifactRuns: next });          // a poll that changed nothing re-renders nothing
  },

  // The tissue layer's render parameters, held here rather than in TissuePanel because the layer
  // keeps rendering while that panel is closed — the right panel unmounts a panel on every tab
  // switch. A patch over tissueUtils' defaults, not a full object, so the defaults have one home.
  tissueLayerParams: {},
  setTissueLayerParams: (patch) =>
    set((s) => ({ tissueLayerParams: { ...s.tissueLayerParams, ...patch } })),

  // The same, for the marker/phenotype layer. Patches markerUtils' MARKER_LAYER_DEFAULTS.
  markerLayerParams: {},
  setMarkerLayerParams: (patch) =>
    set((s) => ({ markerLayerParams: { ...s.markerLayerParams, ...patch } })),

  // The same, for the nuclei mask. Patches workspace/nuclei.js' NUCLEI_LAYER_DEFAULTS.
  // Since Inc 7 it also holds `taxonomy` — which of the artifact's namings the mask is coloured by
  // — and `hidden` is keyed by taxonomy first, because a class name hidden in one naming is not a
  // class name in another.
  nucleiLayerParams: {},
  setNucleiLayerParams: (patch) =>
    set((s) => ({ nucleiLayerParams: { ...s.nucleiLayerParams, ...patch } })),

  // ── Task evidence map (Inc 2c; the controls moved to the Workspace in Inc 6 · 07) ─────────
  // The per-patch signed class evidence a downstream task produced, plus how the viewer shows it.
  // `taskHeatmap` holds the prediction document ({coords, evidence, attention, patch_px, ...});
  // the overlay bakes it into a grid canvas. 'split' renders a second synced pane (CLAM's
  // "Side By Side"); 'overlay' blends it into the single pane.
  //
  // `taskLayerParams` is the fourth of these slices, and it is here for the same reason as the
  // other three: the layer outlives the row that edits it, because the right panel unmounts a
  // panel on every tab switch. Patches `workspace/prediction.js`' PREDICTION_LAYER_DEFAULTS.
  taskHeatmap: null,
  taskLayerParams: {},
  setTaskHeatmap: (doc) => set({ taskHeatmap: doc }),
  clearTaskHeatmap: () => set({ taskHeatmap: null }),
  setTaskLayerParams: (patch) =>
    set((s) => ({ taskLayerParams: { ...s.taskLayerParams, ...patch } })),

  // ── Projects ──────────────────────────────────────────────────────────────
  activeProject: null,
  setActiveProject: (project) => set({ activeProject: project }),

  // ── Compare ───────────────────────────────────────────────────────────────
  compareItems: (() => {
    try { return JSON.parse(localStorage.getItem('pathassist_compare_items') || '[]'); }
    catch { return []; }
  })(),
  setCompareItems: (items) => {
    localStorage.setItem('pathassist_compare_items', JSON.stringify(items));
    set({ compareItems: items });
  },
  clearCompare: () => {
    localStorage.removeItem('pathassist_compare_items');
    set({ compareItems: [] });
  },

  // The AI tab's state — a global localStorage queue of the last 20 Ki67 / tumour-grid results, plus
  // the four flags that drove the draw-then-analyze handshake — went with that tab on 2026-08-03.
  // The results were the problem: one browser's localStorage, not per slide, so a second reader saw
  // nothing and the reader who ran it saw the previous slide's cards on the next slide. Every run is
  // a Girder job now, and a job's numbers live on its artifact. See docs/ai-panel-technical-report.md.
  // (`pathassist_ki67_results` may still sit in a returning user's localStorage; it is inert.)

  // AskPA's chat state — thread, model choice, pending viewport attachment — went with the tab on
  // 2026-08-03, one commit earlier. It was the last browser-direct *chat* path; the AI tab above was
  // the last browser-direct path of any kind. See docs/askpa-technical-report.md.
  // (The old `pathassist_chat_model` key may still sit in a returning user's localStorage; inert.)

  // ── Copilot ──────────────────────────────────────────────────────────────────
  // Conversational thread with the greenfield services/agent gateway. Per-slide;
  // persisted in Postgres (increment 1) keyed by (girder user, slide item). The panel
  // hydrates copilotConversationId + copilotMessages from the store on mount.
  // Live turn: { role:'assistant', trace } (see copilotTurn.js). Persisted/reloaded turns:
  // { role:'user'|'assistant', text, roi } — the trace is ephemeral, only the answer persists.
  copilotMessages: [],
  copilotConversationId: null,  // active server conversation id (null → lazy-create on send)
  copilotStreaming: false,
  copilotError: null,
  addCopilotMessage:        (m)    => set((s) => ({ copilotMessages: [...s.copilotMessages, m] })),
  setCopilotMessages:       (msgs) => set({ copilotMessages: msgs }),
  // Replace the last message wholesale — used to fold each streamed event into the in-flight
  // assistant turn's trace (and to swap the empty placeholder for it).
  setLastCopilotMessage:    (msg)  => set((s) => {
    if (!s.copilotMessages.length) return {};
    const msgs = s.copilotMessages.slice();
    msgs[msgs.length - 1] = msg;
    return { copilotMessages: msgs };
  }),
  setCopilotConversationId: (id)   => set({ copilotConversationId: id }),
  setCopilotStreaming:      (v)    => set({ copilotStreaming: v }),
  setCopilotError:          (e)    => set({ copilotError: e }),
  resetCopilot:             ()     => set({ copilotMessages: [], copilotConversationId: null,
                                            copilotStreaming: false, copilotError: null }),

  // Panel state — the localStorage cart of captured viewport ROIs — went with the Panels tab. Its
  // one action was a batch Ki67 call whose region was squashed to 512 px however large the capture
  // was, so the counts it produced could not mean anything. Single-ROI Ki67 outlived it by a day and
  // then went too; the camera button still uploads its capture to Girder `Captures`.
  // (The old `pathassist_panels` key may still sit in a returning user's localStorage; it is inert.)

  // Theme state was removed with the light/clinical/H&E variants: the app now has one palette,
  // defined once in src/styles/index.css. There is nothing to switch between, so there is nothing
  // to hold. (The old `theme` key may still sit in a returning user's localStorage; it is inert.)

  // ── Viewer UI ────────────────────────────────────────────────────────────
  leftPanelOpen: false,
  rightPanelOpen: false,
  rightRailVisible: true,
  leftPanelTab: 'slides',
  // null = the user has not picked one yet, so the landing tab is whatever their role should open
  // on (Inc 5 · 03b: the Workspace, for ai-users). A click sets it and it stays set.
  rightPanelTab: null,
  autoCollapseViewerPanels: (() => {
    const raw = localStorage.getItem('pathassist_auto_collapse_panels');
    return raw == null ? true : raw === 'true';
  })(),
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  setRightPanelOpen: (open) => set({
    rightPanelOpen: open,
    // Keep the icon rail available whenever the panel is closed so tabs stay reachable.
    ...(open ? {} : { rightRailVisible: true }),
  }),
  setRightRailVisible: (visible) => set({ rightRailVisible: visible }),
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleRightPanel: () => set((s) => {
    const open = !s.rightPanelOpen;
    return open
      ? { rightPanelOpen: true }
      : { rightPanelOpen: false, rightRailVisible: true };
  }),
  toggleRightRail: () => set((s) => ({ rightRailVisible: !s.rightRailVisible })),
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setAutoCollapseViewerPanels: (enabled) => {
    localStorage.setItem('pathassist_auto_collapse_panels', String(enabled));
    set({ autoCollapseViewerPanels: enabled });
  },
}));

// Dev-only test handle (guarded by import.meta.env.DEV; stripped from prod builds).
// Lets an E2E harness open a slide deterministically without navigating the sidebar UI.
if (typeof window !== 'undefined' && import.meta.env?.DEV) window.__pathStore = useStore;
