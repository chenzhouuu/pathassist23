// src/components/browser/ImportModal.jsx
import React, { useState, useEffect, useRef } from 'react';
import { getFolders, createFolder, importFromAssetstore, getCollection, getCollectionAccess, setFolderAccess, prewarmThumbnails } from '../../api/index.js';
import { useStore } from '../../store/index.js';

const JOB_STATUS_LABEL = { 0: 'inactive', 1: 'queued', 2: 'running', 3: 'success', 4: 'error', 5: 'cancelled' };

export default function ImportModal({ collections, onClose, onImported }) {
  const { setActiveCollection, setActiveFolder, setPage } = useStore();
  const [storeInfo, setStoreInfo]         = useState(null);   // { id, name, type, bucket }
  const [storeError, setStoreError]       = useState('');
  const [path, setPath]                   = useState('');
  const [collectionId, setCollectionId]   = useState(collections[0]?._id || '');
  const [folders, setFolders]             = useState([]);
  const [folderId, setFolderId]           = useState('__new__');
  const [newFolderName, setNewFolderName] = useState('');
  const [status, setStatus]               = useState('idle');
  const [jobData, setJobData]             = useState(null);
  const [error, setError]                 = useState('');
  const pollRef                           = useRef(null);
  const [destFolderId, setDestFolderId]   = useState(null);  // resolved folder id after import
  const [prewarm, setPrewarm]             = useState({ done: 0, total: 0 }); // thumbnail pre-gen progress

  // Load assetstore from collection metadata (non-admin safe)
  useEffect(() => {
    if (!collectionId) return;
    getCollection(collectionId)
      .then((col) => {
        const m = col.meta || {};
        if (m.assetstoreId) {
          setStoreInfo({ id: m.assetstoreId, name: m.assetstoreName || m.assetstoreId, type: m.assetstoreType || 'S3', bucket: m.assetstoreBucket || '' });
          setStoreError('');
        } else {
          setStoreInfo(null);
          setStoreError('No assetstore configured for this collection. Ask an admin to set it up.');
        }
      })
      .catch(() => setStoreError('Failed to load collection info.'));
  }, [collectionId]);

  // Load folders when collection changes
  useEffect(() => {
    if (!collectionId) return;
    setFolderId('__new__');
    getFolders('collection', collectionId).then(setFolders).catch(() => setFolders([]));
  }, [collectionId]);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const handleImport = async () => {
    setError('');
    if (!storeInfo)   return setError('No assetstore available for this collection.');
    if (!path.trim()) return setError('Enter a path or S3 prefix.');

    setStatus('importing');
    try {
      let destId = folderId;

      if (folderId === '__new__') {
        if (!newFolderName.trim()) { setStatus('idle'); return setError('Enter a folder name.'); }
        const folder = await createFolder('collection', collectionId, newFolderName.trim());
        if (!folder?._id) { setStatus('idle'); return setError('Failed to create folder.'); }
        destId = folder._id;
      } else if (folderId === '__collection__') {
        const folder = await createFolder('collection', collectionId, 'Imports');
        if (!folder?._id) { setStatus('idle'); return setError('Failed to create Imports folder.'); }
        destId = folder._id;
      }

      // Girder v5 import is synchronous — returns { success, _id, ... } not a job
      const result = await importFromAssetstore(storeInfo.id, {
        destinationType:    'folder',
        destinationId:      destId,
        path:               path.trim(),
        leafFoldersAsItems: false,
      });

      if (result?.success === true || result?.success === 'true') {
        // After import: copy collection group ACL to the dest folder + all subfolders
        try {
          const acl = await getCollectionAccess(collectionId);
          if (acl?.groups?.length) {
            await setFolderAccess(destId, { groups: acl.groups, users: acl.users ?? [] });
          }
        } catch (_) { /* non-fatal */ }

        // Pre-generate thumbnails so worklist browsing is instant (no on-demand JP2 decode)
        setStatus('prewarm');
        try {
          await prewarmThumbnails(destId, {
            onProgress: (done, total) => setPrewarm({ done, total }),
          });
        } catch (_) { /* non-fatal — thumbnails will generate on first access */ }

        setDestFolderId(destId);
        setStatus('done');
        if (onImported) onImported();
      } else {
        const msg = result?.log?.slice(-1)[0] || result?.message || 'Import completed but no files were found at that path.';
        setError(msg);
        setStatus('error');
      }
    } catch (e) {
      setError(e?.response?.data?.message || 'Import failed.');
      setStatus('error');
    }
  };

  const isS3 = storeInfo?.type === 'S3' || storeInfo?.type === 2;

  return (
    // The scrim, the corner, the edge and the shadow are the page's now, in _dialogs.css, and all
    // three dialogs read the same four. What stays inline is only what is this dialog's own: it is
    // wider than the other two, and its content is long enough to scroll. The hard-coded
    // `fontFamily: 'IBM Plex Sans'` that stood here went with the rest — it made this the one
    // element on the landing page not following `--font-ui`, in a dialog opened from it.
    <div className="browser-modal-scrim" onClick={onClose}>
      <div
        className="browser-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 500, maxWidth: '92vw', padding: 24, gap: 0 }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Import from Assetstore</h2>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted-hex)' }}>
              Import existing files from a Girder assetstore into a collection
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} style={{ marginLeft: 12, flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {status === 'idle' || status === 'error' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Destination collection */}
            <Field label="Destination Collection" required>
              <select
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                className="input-field"
              >
                {collections.map((c) => (
                  <option key={c._id} value={c._id}>{c.name}</option>
                ))}
              </select>
            </Field>

            {/* Assetstore info (read from collection metadata) */}
            <Field label="Assetstore">
              {storeError ? (
                <p style={{ fontSize: 12, color: 'var(--sem-flag-ink)', margin: 0 }}>{storeError}</p>
              ) : storeInfo ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  background: 'color-mix(in oklab, var(--sem-read) var(--sem-mix), var(--surface))',
                  border: '1px solid color-mix(in oklab, var(--sem-read) 28%, transparent)',
                  borderRadius: 'var(--radius-2)',
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--sem-read-ink)" strokeWidth="2">
                    <ellipse cx="12" cy="5" rx="9" ry="3"/>
                    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                  </svg>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{storeInfo.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted-hex)', marginLeft: 6 }}>[{storeInfo.type}]</span>
                    {storeInfo.bucket && (
                      <div style={{ fontSize: 11, color: 'var(--muted-hex)', fontFamily: 'monospace', marginTop: 1 }}>
                        {isS3 ? `s3://${storeInfo.bucket}` : storeInfo.bucket}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ height: 38, background: 'var(--sunken)', borderRadius: 'var(--radius-2)', display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
                  <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  <span style={{ fontSize: 12, color: 'var(--muted-hex)', marginLeft: 8 }}>Loading…</span>
                </div>
              )}
            </Field>

            {/* Path / prefix */}
            <Field label={isS3 ? 'S3 Key Prefix' : 'Path'} required>
              <input
                className="input-field"
                style={{ fontFamily: 'monospace', fontSize: 12 }}
                placeholder={isS3 ? 'e.g.  bmjh/patient-001/' : 'e.g.  /data/slides/bmjh/'}
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
              <p style={{ fontSize: 11, color: 'var(--muted-hex)', margin: '4px 0 0' }}>
                {isS3 ? 'All objects under this prefix will be imported.' : 'Absolute path on the filesystem to import from.'}
              </p>
            </Field>

            {/* Destination folder */}
            <Field label="Destination Folder">
              <select
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                className="input-field"
              >
                <option value="__collection__">— Collection root —</option>
                <option value="__new__">+ Create new folder…</option>
                {folders.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
              </select>
              {folderId === '__new__' && (
                <input
                  className="input-field"
                  style={{ marginTop: 6, fontSize: 12 }}
                  placeholder="New folder name"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                />
              )}
            </Field>

            {error && (
              <p style={{ fontSize: 12, padding: '8px 12px', borderRadius: 'var(--radius-2)', background: 'color-mix(in oklab, var(--sem-flag) var(--sem-mix), var(--surface))',
                color: 'var(--sem-flag-ink)',
                border: '1px solid color-mix(in oklab, var(--sem-flag) 28%, transparent)', margin: 0 }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
              <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>Cancel</button>
              <button
                className="btn-primary"
                style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={handleImport}
                disabled={!storeInfo || !path.trim()}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Start Import
              </button>
            </div>
          </div>
        ) : (
          /* Progress */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '12px 0' }}>
            {status === 'prewarm' && (
              <>
                <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3, borderTopColor: 'var(--brand)' }} />
                <div style={{ textAlign: 'center' }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>Pre-generating thumbnails…</p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted-hex)' }}>
                    {prewarm.total > 0 ? `${prewarm.done} / ${prewarm.total} slides` : 'Starting…'}
                  </p>
                  {prewarm.total > 0 && (
                    <div style={{ width: 220, height: 4, background: 'var(--sunken)', borderRadius: 'var(--radius-1)', marginTop: 10 }}>
                      <div style={{ height: '100%', borderRadius: 'var(--radius-1)', background: 'var(--brand)', width: `${Math.round((prewarm.done / prewarm.total) * 100)}%`, transition: 'width 0.3s' }} />
                    </div>
                  )}
                  <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted-hex)' }}>This makes worklist browsing instant. You can close and it will continue in the background.</p>
                </div>
                <button className="btn-secondary" style={{ fontSize: 12 }} onClick={() => { setStatus('done'); if (onImported) onImported(); }}>Skip & Close</button>
              </>
            )}
            {status === 'importing' && (
              <>
                <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
                <div style={{ textAlign: 'center' }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>Import running…</p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted-hex)' }}>
                    Status: {JOB_STATUS_LABEL[jobData?.status] ?? '—'}
                  </p>
                </div>
              </>
            )}
            {status === 'done' && (
              <>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'color-mix(in oklab, var(--sem-read) var(--sem-mix), var(--surface))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--sem-read-ink)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Import complete</p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted-hex)' }}>Files are now available in the collection.</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>Done</button>
                  {destFolderId && (
                    <button
                      className="btn-primary"
                      style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                      onClick={() => {
                        const col = collections.find(c => c._id === collectionId);
                        setActiveCollection(col);
                        setActiveFolder({ _id: destFolderId, name: newFolderName || 'Imported folder', parentId: collectionId });
                        setPage('browse');
                        onClose();
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <rect x="2" y="3" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="3"/>
                      </svg>
                      View Slides
                    </button>
                  )}
                </div>
              </>
            )}
            {status === 'error' && (
              <>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'color-mix(in oklab, var(--sem-flag) var(--sem-mix), var(--surface))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--sem-flag-ink)" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--sem-flag-ink)' }}>Import failed</p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted-hex)' }}>
                    {jobData?.log?.slice(-1)[0] || error || 'Check Girder job logs for details.'}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>Close</button>
                  <button className="btn-primary" style={{ fontSize: 12 }} onClick={() => { setStatus('idle'); setJobData(null); setError(''); }}>Try again</button>
                </div>
              </>
            )}

            {/* Job log tail */}
            {jobData?.log?.length > 0 && (
              <div style={{
                width: '100%', fontFamily: 'monospace', fontSize: 11, padding: '10px 12px',
                borderRadius: 'var(--radius-2)', overflowY: 'auto', maxHeight: 110,
                background: 'var(--sunken)', color: 'var(--ink-2)', border: 0,
              }}>
                {jobData.log.slice(-8).map((line, i) => <div key={i}>{line}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
        {label}{required && <span style={{ color: 'var(--sem-flag-ink)', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}
