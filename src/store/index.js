// src/store/index.js
import { create } from 'zustand';

export const useStore = create((set, get) => ({
  // ── Auth ────────────────────────────────────────────────────────────────
  token: localStorage.getItem('girderToken') || null,
  user: JSON.parse(localStorage.getItem('girderUser') || 'null'),
  setAuth: (token, user) => {
    localStorage.setItem('girderToken', token);
    localStorage.setItem('girderUser', JSON.stringify(user));
    set({ token, user });
  },
  clearAuth: () => {
    localStorage.removeItem('girderToken');
    localStorage.removeItem('girderUser');
    set({ token: null, user: null });
  },

  // ── Page routing: 'dashboard' | 'worklist' | 'viewer' ──────────────────
  currentPage: 'dashboard',
  setPage: (page) => set({ currentPage: page }),

  // ── Navigation ──────────────────────────────────────────────────────────
  activeCollection: null,
  activeFolder: null,
  activeItem: null,
  breadcrumb: [],
  setActiveCollection: (col) =>
    set({ activeCollection: col, activeFolder: null, activeItem: null, breadcrumb: [col] }),
  setActiveFolder: (folder) => {
    const { breadcrumb } = get();
    const idx = breadcrumb.findIndex((b) => b._id === folder._id);
    const newCrumb = idx >= 0 ? breadcrumb.slice(0, idx + 1) : [...breadcrumb, folder];
    set({ activeFolder: folder, activeItem: null, breadcrumb: newCrumb });
  },
  setActiveItem: (item, fromPage = 'viewer') => {
    const { breadcrumb } = get();
    const filtered = breadcrumb.filter((b) => b._type !== 'item');
    set({
      activeItem: item,
      breadcrumb: [...filtered, { ...item, _type: 'item' }],
      currentPage: 'viewer',
    });
  },

  // ── Viewer ──────────────────────────────────────────────────────────────
  viewer: null,
  setViewer: (v) => set({ viewer: v }),
  tilesInfo: null,
  setTilesInfo: (info) => set({ tilesInfo: info }),

  // ── Annotations ─────────────────────────────────────────────────────────
  annotations: [],
  setAnnotations: (anns) => set({ annotations: anns }),
  visibleAnnotations: {},
  toggleAnnotationVisibility: (id) => {
    const { visibleAnnotations } = get();
    set({ visibleAnnotations: { ...visibleAnnotations, [id]: !visibleAnnotations[id] } });
  },
  selectedAnnotation: null,
  setSelectedAnnotation: (ann) => set({ selectedAnnotation: ann }),
  drawingMode: null,
  setDrawingMode: (mode) => set({ drawingMode: mode }),

  // ── Viewer UI ────────────────────────────────────────────────────────────
  leftPanelOpen: true,
  rightPanelOpen: true,
  rightPanelTab: 'metadata',
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
}));
