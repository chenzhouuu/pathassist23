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

// POST body is the annotation document directly: { name, description, elements: [...] }
export const createAnnotation = (itemId, annotationDoc) =>
  client.post(`/annotation?itemId=${itemId}`, annotationDoc).then((r) => r.data);

// PUT to update an existing annotation
export const updateAnnotation = (annId, annotationDoc) =>
  client.put(`/annotation/${annId}`, annotationDoc).then((r) => r.data);

export const deleteAnnotation = (id) =>
  client.delete(`/annotation/${id}`).then((r) => r.data);

// ─── Item Metadata ────────────────────────────────────────────────────────────
export const updateItemMetadata = (itemId, meta) =>
  client.put(`/item/${itemId}/metadata`, meta).then((r) => r.data);

// Recursively count ALL items in a folder tree.
// Stops recursing into a folder only when it has no sub-folders (nFolders === 0).
async function countItemsRecursive(folderId) {
  const subFolders = await client.get(
    `/folder?parentType=folder&parentId=${folderId}&limit=500`
  ).then(r => r.data);
  let count = subFolders.reduce((s, f) => s + (f.nItems || 0), 0);
  const withChildren = subFolders.filter(f => (f.nFolders || 0) > 0);
  if (withChildren.length > 0) {
    const subCounts = await Promise.all(withChildren.map(f => countItemsRecursive(f._id)));
    count += subCounts.reduce((s, c) => s + c, 0);
  }
  return count;
}

export const getCollectionStats = async (collectionId) => {
  try {
    // Get top-level folders (case folders) in the collection
    const folders = await client.get(
      `/folder?parentType=collection&parentId=${collectionId}&limit=500&sort=name`
    ).then(r => r.data);

    // For each top-level folder: count its direct items, then recursively
    // traverse any sub-folder tree to count all nested items too.
    const counts = await Promise.all(folders.map(async (f) => {
      let count = f.nItems || 0;
      if ((f.nFolders || 0) > 0) {
        count += await countItemsRecursive(f._id);
      }
      return count;
    }));

    return {
      folders: folders.length,
      items: counts.reduce((s, c) => s + c, 0),
    };
  } catch(e) { return { folders: 0, items: 0 }; }
};

export const getAllItemsInFolder = (folderId, limit = 50, offset = 0) =>
  client.get(`/item?folderId=${folderId}&limit=${limit}&offset=${offset}&sort=name`).then((r) => r.data);

export const getFolderDetails = (folderId) =>
  client.get(`/folder/${folderId}`).then((r) => r.data);

// ─── Large Image tile creation ────────────────────────────────────────────────
// POST creates a large_image tile source for the item (async job).
// Returns the created job object with a _id.
export const createItemTiles = (itemId) =>
  client.post(`/item/${itemId}/tiles`).then((r) => r.data);

// ─── Jobs / Tasks ─────────────────────────────────────────────────────────────
export const getDockerImages = () =>
  client.get('/slicer_cli_web/docker_image').then((r) => r.data);
export const getJobs = () =>
  client.get('/job?limit=50&sort=created&sortdir=-1').then((r) => r.data);
export const getJob = (id) => client.get(`/job/${id}`).then((r) => r.data);

// ─── Slicer CLI execution ─────────────────────────────────────────────────────
// GET the CLI's XML descriptor (describes parameters)
// NOTE: imageName (e.g. "dsarchive/histomicstk") contains a real path slash —
// the Slicer CLI Web route is /<namespace>/<image>/<cli>/xml so the slash must
// NOT be percent-encoded (encodeURIComponent would turn it into %2F which breaks routing).
export const getCliXml = (imageName, cliName) =>
  client.get(`/slicer_cli_web/${imageName}/${cliName}/xml`, { responseType: 'text' })
    .then((r) => r.data);

// POST to submit a Slicer CLI job. params is a plain object of parameter values.
export const runCliJob = (imageName, cliName, params) =>
  client.post(`/slicer_cli_web/${imageName}/${cliName}/run`, params)
    .then((r) => r.data);

// POST using the exact run path from the docker_image response (val.run).
// Slicer CLI Web expects application/x-www-form-urlencoded (not JSON).
// URLSearchParams serialises the plain-object params as form fields automatically.
export const runCliByPath = (runPath, params) => {
  const path = runPath.startsWith('/') ? runPath : `/${runPath}`;
  return client.post(path, new URLSearchParams(params)).then((r) => r.data);
};

// GET CLI XML using the xmlspec path from the docker_image response (val.xmlspec).
export const getCliXmlByPath = (xmlPath) => {
  const path = (xmlPath || '').startsWith('/') ? xmlPath : `/${xmlPath}`;
  return client.get(path, { responseType: 'text' }).then((r) => r.data);
};
