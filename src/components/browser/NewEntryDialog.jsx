// src/components/browser/NewEntryDialog.jsx
// "New" for whichever level the browser is on: a collection at the root, a folder inside one.
//
// The Dashboard had a separate "New Organization" button that existed regardless of where you
// were, which meant it could only ever create at the top. Making the action read the current
// level is what lets one button replace two and still do the more useful thing — most of the
// time what is wanted is a folder in the case you are already looking at.
import React, { useEffect, useState } from 'react';
import { createCollection, createFolder } from '../../api/index.js';
import { Button } from '../ui/button.tsx';

export default function NewEntryDialog({ collection, folder, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Escape closes it. Not decoration: this is a role="dialog" over a page whose own keyboard
  // shortcuts are suspended while it is open, so without this there is no key that gets out.
  // Ignored mid-request, where dismissing would leave the outcome of the write unknown.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const kind = collection ? 'folder' : 'collection';
  const parentLabel = folder?.name || collection?.name || null;

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'collection') {
        await createCollection(trimmed, description.trim());
      } else {
        const parentType = folder ? 'folder' : 'collection';
        const parentId = folder ? folder._id : collection._id;
        await createFolder(parentType, parentId, trimmed, description.trim());
      }
      onCreated();
      onClose();
    } catch (err) {
      // Girder rejects a duplicate name at the same level; say so rather than closing silently.
      setError(err?.response?.data?.message || err?.message || 'Could not create it.');
      setBusy(false);
    }
  };

  return (
    <div className="browser-modal-scrim" role="dialog" aria-modal="true" aria-label={`New ${kind}`}>
      <form className="browser-modal" onSubmit={submit}>
        <h2 className="browser-modal-title">New {kind}</h2>
        {parentLabel && <p className="browser-modal-sub">in {parentLabel}</p>}

        <label className="browser-modal-label">
          Name
          <input
            className="browser-modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </label>

        <label className="browser-modal-label">
          Description <span className="browser-modal-optional">optional</span>
          <input
            className="browser-modal-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {error && <p className="browser-modal-error">{error}</p>}

        <div className="browser-modal-actions">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </div>
  );
}
