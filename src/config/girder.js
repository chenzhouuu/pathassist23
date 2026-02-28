// src/config/girder.js
// Configuration for Girder 5 / DSA v5 server

export const GIRDER_BASE = 'https://lymphoma.dev.pathassist.health/api/v1';

export const endpoints = {
  // Auth
  login: () => `${GIRDER_BASE}/user/authentication`,
  me: () => `${GIRDER_BASE}/user/me`,

  // Collections & folders
  collections: () => `${GIRDER_BASE}/collection`,
  collection: (id) => `${GIRDER_BASE}/collection/${id}`,
  folders: (parentType, parentId) =>
    `${GIRDER_BASE}/folder?parentType=${parentType}&parentId=${parentId}&limit=200&sort=name`,
  items: (folderId) =>
    `${GIRDER_BASE}/item?folderId=${folderId}&limit=200&sort=name`,
  item: (id) => `${GIRDER_BASE}/item/${id}`,

  // Large image / tiles
  tilesInfo: (id) => `${GIRDER_BASE}/item/${id}/tiles`,
  dzi: (id, token) =>
    `${GIRDER_BASE}/item/${id}/tiles/dzi${token ? `?token=${token}` : ''}`,
  thumbnail: (id, w = 256, h = 256) =>
    `${GIRDER_BASE}/item/${id}/tiles/thumbnail?width=${w}&height=${h}`,
  tileRegion: (id) => `${GIRDER_BASE}/item/${id}/tiles/region`,

  // Annotations
  annotations: (itemId) => `${GIRDER_BASE}/annotation?itemId=${itemId}&limit=500`,
  annotation: (id) => `${GIRDER_BASE}/annotation/${id}`,
  createAnnotation: (itemId) => `${GIRDER_BASE}/annotation?itemId=${itemId}`,
  annotationElements: (id) => `${GIRDER_BASE}/annotation/${id}/elements`,

  // Jobs / Tasks
  dockerImages: () => `${GIRDER_BASE}/slicer_cli_web/docker_image`,
  jobs: () => `${GIRDER_BASE}/job?limit=50&sort=created&sortdir=-1`,
  job: (id) => `${GIRDER_BASE}/job/${id}`,
};

export const getThumbnailUrl = (itemId, token, w = 256, h = 256) =>
  `${GIRDER_BASE}/item/${itemId}/tiles/thumbnail?width=${w}&height=${h}${token ? `&token=${token}` : ''}`;
