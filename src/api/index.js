// src/api/index.js
import client from './client.js';
import { GIRDER_BASE } from '../config/girder.js';

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const login = async (username, password) => {
  const res = await client.get('/user/authentication', {
    headers: { Authorization: 'Basic ' + btoa(`${username}:${password}`) },
  });
  return res.data;
};
export const logout = () => client.delete('/user/authentication');
export const getMe = () => client.get('/user/me').then((r) => r.data);

// ─── Collections ─────────────────────────────────────────────────────────────
export const getCollections = () =>
  client.get('/collection?limit=200&sort=name').then((r) => r.data);
export const getCollection = (id) =>
  client.get(`/collection/${id}`).then((r) => r.data);

// ─── Folders ─────────────────────────────────────────────────────────────────
export const getFolders = (parentType, parentId) =>
  client.get(`/folder?parentType=${parentType}&parentId=${parentId}&limit=200&sort=name`).then((r) => r.data);

// ─── Items ────────────────────────────────────────────────────────────────────
export const getItems = (folderId, offset = 0, limit = 200) =>
  client.get(`/item?folderId=${folderId}&limit=${limit}&offset=${offset}&sort=name`).then((r) => r.data);
export const getItem = (id) => client.get(`/item/${id}`).then((r) => r.data);

// ─── Large Image / Tiles ──────────────────────────────────────────────────────
export const getTilesInfoSafe = async (itemId) => {
  try { return await client.get(`/item/${itemId}/tiles`).then((r) => r.data); }
  catch (e) { return null; }
};

export const getThumbnailUrl = (itemId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/item/${itemId}/tiles/thumbnail?width=256&height=256${token ? `&token=${token}` : ''}`;
};
export const getDziUrl = (itemId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/item/${itemId}/tiles/dzi${token ? `?token=${token}` : ''}`;
};
export const getItemFiles = (itemId) =>
  client.get(`/item/${itemId}/files?limit=10`).then((r) => r.data);
export const getFileDownloadUrl = (fileId) => {
  const token = localStorage.getItem('girderToken');
  return `${GIRDER_BASE}/file/${fileId}/download${token ? `?token=${token}` : ''}`;
};

// ─── Annotations ─────────────────────────────────────────────────────────────
// GET /annotation?itemId=X returns an array of annotation headers (no elements by default)
// Each item: { _id, annotation: { name, description, elements?: [...] }, ... }
// elements may be truncated — use GET /annotation/:id to get full elements

export const getAnnotationList = (itemId) =>
  client.get(`/annotation?itemId=${itemId}&limit=500&sort=updated&sortdir=-1`).then((r) => r.data);

// Fetch ONE annotation with all its elements
export const getAnnotationFull = (annId) =>
  client.get(`/annotation/${annId}`).then((r) => r.data);

// POST body MUST be: { annotation: { name, description, elements: [...] } }
// This is the correct Girder large_image schema
export const createAnnotation = (itemId, annotationDoc) =>
  client.post(`/annotation?itemId=${itemId}`, { annotation: annotationDoc }).then((r) => r.data);

// PUT to update an existing annotation
export const updateAnnotation = (annId, annotationDoc) =>
  client.put(`/annotation/${annId}`, { annotation: annotationDoc }).then((r) => r.data);

export const deleteAnnotation = (id) =>
  client.delete(`/annotation/${id}`).then((r) => r.data);

// ─── Item Metadata ────────────────────────────────────────────────────────────
export const updateItemMetadata = (itemId, meta) =>
  client.put(`/item/${itemId}/metadata`, meta).then((r) => r.data);

export const getCollectionStats = async (collectionId) => {
  try {
    const folders = await client.get(`/folder?parentType=collection&parentId=${collectionId}&limit=200`).then(r => r.data);
    let totalItems = 0;
    folders.forEach(f => { totalItems += (f.nItems || 0); });
    return { folders: folders.length, items: totalItems };
  } catch(e) { return { folders: 0, items: 0 }; }
};

export const getAllItemsInFolder = (folderId, limit = 50, offset = 0) =>
  client.get(`/item?folderId=${folderId}&limit=${limit}&offset=${offset}&sort=name`).then((r) => r.data);

export const getFolderDetails = (folderId) =>
  client.get(`/folder/${folderId}`).then((r) => r.data);

// ─── Jobs / Tasks ─────────────────────────────────────────────────────────────
export const getDockerImages = () =>
  client.get('/slicer_cli_web/docker_image').then((r) => r.data);
export const getJobs = () =>
  client.get('/job?limit=50&sort=created&sortdir=-1').then((r) => r.data);
export const getJob = (id) => client.get(`/job/${id}`).then((r) => r.data);
