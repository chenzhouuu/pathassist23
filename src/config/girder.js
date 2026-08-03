// src/config/girder.js
// Configuration for Girder 5 / DSA v5 server

// In dev: Vite proxy rewrites /api → https://lymphoma.dev.pathassist.health (see vite.config.js)
// In production (CloudFront): browser calls Girder directly — VITE_GIRDER_BASE must be set.
export const GIRDER_BASE = import.meta.env.VITE_GIRDER_BASE || '/api/v1';

// Girder v5 OAuth: GET /oauth/provider?redirect=<url> returns { "Keycloak": "<auth_url>" }
// The UI fetches this to get the state-embedded Keycloak URL, then redirects the browser.
// Set to null to hide the SSO button entirely (username/password only mode).
export const KEYCLOAK_OAUTH_PROVIDERS_URL = `${GIRDER_BASE}/oauth/provider`;

// Keycloak logout — clears the Keycloak session so SSO doesn't auto-login again.
// post_logout_redirect_uri must be registered in Keycloak client "Valid post logout redirect URIs".
const _KC_BASE = import.meta.env.VITE_KC_BASE || 'https://auth.pathassist.health';
const _KC_REALM = import.meta.env.VITE_KC_REALM || 'pathassist';
const _APP_URL = import.meta.env.VITE_APP_URL || window.location.origin;
export const KEYCLOAK_LOGOUT_URL =
  `${_KC_BASE}/realms/${_KC_REALM}/protocol/openid-connect/logout` +
  `?client_id=pathassist-girder` +
  `&post_logout_redirect_uri=${encodeURIComponent(_APP_URL)}`;

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
  jobs: () => `${GIRDER_BASE}/job?limit=50&sort=created&sortdir=-1`,
  job: (id) => `${GIRDER_BASE}/job/${id}`,
};

export const getThumbnailUrl = (itemId, token, w = 256, h = 256) =>
  `${GIRDER_BASE}/item/${itemId}/tiles/thumbnail?width=${w}&height=${h}${token ? `&token=${token}` : ''}`;
