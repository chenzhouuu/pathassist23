// src/api/index.js
import client from './client.js';
import { GIRDER_BASE } from '../config/girder.js';

// ─── Auth ────────────────────────────────────────────────────────────────────
export const login = async (username, password) => {
  const res = await client.get('/user/authentication', {
    headers: {
      Authorization: 'Basic ' + btoa(`${username}:${password}`),
    },
  });
  return res.data; // { authToken: { token }, user: {...} }
};

export const logout = () => client.delete('/user/authentication');
export const getMe = () => client.get('/user/me').then((r) => r.data);

// ─── Collections ─────────────────────────────────────────────────────────────
export const getCollections = () =>
  client.get('/collection?limit=200&sort=name').then((r) => r.data);

export const getCollection = (id) =>
  client.get(`/collection/${id}`).then((r) => r.data);

// ─── Folders ──────────────────────────────────────────────────────────────────
export const getFolders = (parentType, parentId) =>
  client
    .get(`/folder?parentType=${parentType}&parentId=${parentId}&limit=200&sort=name`)
    .then((r) => r.data);

// ─── Items (Slides) ───────────────────────────────────────────────────────────
export const getItems = (folderId, offset = 0, limit = 200) =>
  client
    .get(`/item?folderId=${folderId}&limit=${limit}&offset=${offset}&sort=name`)
    .then((r) => r.data);

export const getItem = (id) => client.get(`/item/${id}`).then((r) => r.data);

// ─── Large Image / Tiles ──────────────────────────────────────────────────────

// Check if item has large_image tiles — returns null if not a large image
export const getTilesInfo = async (itemId) => {
  const r = await client.get(`/item/${itemId}/tiles`);
  return r.data;
};

// Safe version — returns null instead of throwing if not a large image
export const getTilesInfoSafe = async (itemId) => {
  try {
    const r = await client.get(`/item/${itemId}/tiles`);
    return r.data;
  } catch (e) {
    return null;
  }
};

export const getThumbnailUrl = (itemId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/item/${itemId}/tiles/thumbnail?width=256&height=256${token ? `&token=${token}` : ''}`;
};

// Returns the DZI XML URL — used as tileSources in OpenSeadragon
export const getDziUrl = (itemId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/item/${itemId}/tiles/dzi${token ? `?token=${token}` : ''}`;
};

// ZXY tile URL template for OpenSeadragon custom tile source
export const getZXYTileUrl = (itemId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/item/${itemId}/tiles/zxy/{z}/{x}/{y}${token ? `?token=${token}` : ''}`;
};

// Get files attached to an item (for non-large-image fallback)
export const getItemFiles = (itemId) =>
  client.get(`/item/${itemId}/files?limit=10`).then((r) => r.data);

// Direct file download URL
export const getFileDownloadUrl = (fileId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/file/${fileId}/download${token ? `?token=${token}` : ''}`;
};

// Thumbnail URL via large_image — safe for non-tile items too
export const getItemThumbnailUrl = (itemId, w = 256, h = 256) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/item/${itemId}/tiles/thumbnail?width=${w}&height=${h}${token ? `&token=${token}` : ''}`;
};

// ─── Annotations ─────────────────────────────────────────────────────────────
export const getAnnotations = (itemId) =>
  client.get(`/annotation?itemId=${itemId}&limit=500`).then((r) => r.data);

export const getAnnotation = (id) =>
  client.get(`/annotation/${id}`).then((r) => r.data);

export const createAnnotation = (itemId, data) =>
  client.post(`/annotation?itemId=${itemId}`, data).then((r) => r.data);

export const updateAnnotation = (id, data) =>
  client.put(`/annotation/${id}`, data).then((r) => r.data);

export const deleteAnnotation = (id) =>
  client.delete(`/annotation/${id}`).then((r) => r.data);

export const getAnnotationElements = (id, limit = 10000) =>
  client
    .get(`/annotation/${id}/elements?limit=${limit}`)
    .then((r) => r.data);

// ─── Jobs / Tasks ─────────────────────────────────────────────────────────────
export const getDockerImages = () =>
  client.get('/slicer_cli_web/docker_image').then((r) => r.data);

export const getJobs = () =>
  client
    .get('/job?limit=50&sort=created&sortdir=-1')
    .then((r) => r.data);

export const getJob = (id) =>
  client.get(`/job/${id}`).then((r) => r.data);

// ─── Item metadata management (Girder metadata API) ──────────────────────────
// Girder stores arbitrary JSON metadata on items via PUT /item/{id}/metadata
// This is how you add status, priority, diagnosis, reviewer etc. to any image

export const updateItemMetadata = (itemId, meta) =>
  client.put(`/item/${itemId}/metadata`, meta).then((r) => r.data);

// Fetch all items recursively from a folder tree
// Returns flat array of {item, folderPath, collectionName}
export const getAllItemsInFolder = (folderId, limit = 50, offset = 0, sort = 'name', sortdir = 1) =>
  client.get(`/item?folderId=${folderId}&limit=${limit}&offset=${offset}&sort=${sort}&sortdir=${sortdir}`).then((r) => r.data);

// Search items across the whole server
export const searchItems = (query, limit = 50, offset = 0) =>
  client.get(`/resource/search?q=${encodeURIComponent(query)}&types=item&limit=${limit}&offset=${offset}`).then((r) => r.data);

// Get folder details including nItems count  
export const getFolderDetails = (folderId) =>
  client.get(`/folder/${folderId}`).then((r) => r.data);

// Get all items in a collection recursively via folder tree walk
export const getCollectionStats = async (collectionId) => {
  try {
    const folders = await client.get(`/folder?parentType=collection&parentId=${collectionId}&limit=200`).then(r => r.data);
    let totalItems = 0;
    folders.forEach(f => { totalItems += (f.nItems || 0); });
    return { folders: folders.length, items: totalItems };
  } catch(e) { return { folders: 0, items: 0 }; }
};
