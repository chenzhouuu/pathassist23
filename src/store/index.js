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
    'projects-users':       ['lab-manager', 'pathologist'],
    'second-opinion-users': ['lab-manager', 'pathologist', 'fellow', 'second-opinion-reviewer', 'referring-physician'],
    'annotation-users':     ['lab-manager', 'pathologist', 'fellow', 'researcher', 'second-opinion-reviewer'],
    'import-users':         ['lab-manager', 'lab-technician'],
    'worklist-users':       ['lab-manager', 'pathologist', 'fellow', 'researcher', 'lab-technician'],
  },
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
  currentPage: 'dashboard',
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
    set({ activeCollection: null, activeFolder: null, activeItem: null, breadcrumb: [] }),
  setActiveItem: (item) => {
    const { breadcrumb } = get();
    const filtered = breadcrumb.filter((b) => b._type !== 'item');
    set({
      activeItem: item,
      annotations: [],          // clear stale annotations on item change
      visibleAnnotations: {},
      selectedAnnotation: null,
      drawingMode: null,
      breadcrumb: [...filtered, { ...item, _type: 'item' }],
      currentPage: 'viewer',
      caseContext: null,        // clear case context when opening a slide outside a case
    });
  },

  // ── Case Context ──────────────────────────────────────────────────────────
  // Set when opening a Second Opinion case — restricts sidebar to case images only.
  caseContext: null, // { caseId, folderId, items: [{ _id, name }] } | null
  setCaseContext: (ctx) => set({ caseContext: ctx }),
  clearCaseContext: () => set({ caseContext: null }),

  // Open a case: sets both caseContext and activeItem without clearing caseContext.
  openCaseItem: (item, ctx) => {
    const { breadcrumb } = get();
    const filtered = breadcrumb.filter((b) => b._type !== 'item');
    set({
      activeItem: item,
      annotations: [],
      visibleAnnotations: {},
      selectedAnnotation: null,
      drawingMode: null,
      breadcrumb: [...filtered, { ...item, _type: 'item' }],
      currentPage: 'viewer',
      caseContext: ctx,
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
  roiSelectResult: null,                             // { x, y, width, height } in image pixels
  setRoiSelectResult: (r) => set({ roiSelectResult: r }),
  clearRoiSelectResult: () => set({ roiSelectResult: null }),

  // ── Projects ──────────────────────────────────────────────────────────────
  activeProject: null,
  setActiveProject: (project) => set({ activeProject: project }),

  // ── Compare ───────────────────────────────────────────────────────────────
  compareItems: [],
  setCompareItems: (items) => set({ compareItems: items, currentPage: 'compare' }),
  clearCompare: () => set({ compareItems: [], currentPage: 'worklist' }),

  // ── Theme ────────────────────────────────────────────────────────────────
  theme: localStorage.getItem('theme') || 'he',
  setTheme: (theme) => {
    localStorage.setItem('theme', theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  // ── Viewer UI ────────────────────────────────────────────────────────────
  leftPanelOpen: true,
  rightPanelOpen: true,
  rightPanelTab: 'metadata',
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
}));
