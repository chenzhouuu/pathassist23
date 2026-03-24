// src/components/panels/MetadataPanel.jsx
import React, { useState, useEffect } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getItem, getThumbnailUrl, getFileDownloadUrl, updateItemMetadata } from '../../api/index.js';

function SectionLabel({ children }) {
  return (
    <div style={{ color: 'var(--muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
      {children}
    </div>
  );
}


export default function MetadataPanel() {
  const { activeItem } = useStore();
  const qc = useQueryClient();

  const { data: item } = useQuery({
    queryKey: ['item', activeItem?._id],
    queryFn: () => getItem(activeItem._id),
    enabled: !!activeItem?._id,
  });

  const [notes, setNotes] = useState('');
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  const [selectedStatus, setSelectedStatus] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusSaved, setStatusSaved] = useState(false);

  useEffect(() => {
    setNotes(item?.meta?.notes || '');
    setNotesEditing(false);
    setSelectedStatus(item?.meta?.status || '');
  }, [item?._id]);

  const handleSaveStatus = async () => {
    setStatusSaving(true);
    try {
      await updateItemMetadata(activeItem._id, { ...(item?.meta || {}), status: selectedStatus });
      await qc.invalidateQueries({ queryKey: ['item', activeItem._id] });
      setStatusSaved(true);
      setTimeout(() => setStatusSaved(false), 2000);
    } catch (e) { console.error(e); }
    setStatusSaving(false);
  };

  const handleSaveNotes = async () => {
    setNotesSaving(true);
    try {
      await updateItemMetadata(activeItem._id, { ...(item?.meta || {}), notes });
      await qc.invalidateQueries({ queryKey: ['item', activeItem._id] });
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
      setNotesEditing(false);
    } catch (e) { console.error(e); }
    setNotesSaving(false);
  };

  if (!activeItem) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-xs gap-2" style={{ color: 'var(--muted)' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
        </svg>
        No slide selected
      </div>
    );
  }

  const thumbUrl = getThumbnailUrl(activeItem._id);
  const meta = item?.meta || {};

  return (
    <div className="viewer-meta-panel">

      <div className="viewer-meta-hero">
        <div className="viewer-meta-thumb">
          <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => { e.target.style.display = 'none'; }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="viewer-meta-name">
            {activeItem.name}
          </div>
          {item?.size && (
            <div className="viewer-meta-subtext">
              {(item.size / 1024 / 1024 / 1024).toFixed(2)} GB
            </div>
          )}
          {item?.created && (
            <div className="viewer-meta-subtext" style={{ marginTop: 4 }}>
              {new Date(item.created).toLocaleDateString()}
            </div>
          )}
        </div>
      </div>

      <div className="viewer-meta-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
          <SectionLabel>Dr. Notes</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {notesSaved && <span style={{ color: '#4caf82', fontSize: 9 }}>✓ Saved</span>}
            {!notesEditing && (
              <button onClick={() => setNotesEditing(true)}
                style={{ fontSize: 9, color: 'var(--accent)', background: 'rgba(77,166,255,0.1)', border: '1px solid rgba(77,166,255,0.25)', borderRadius: 3, padding: '1px 6px', cursor: 'pointer' }}>
                Edit
              </button>
            )}
          </div>
        </div>
        {notesEditing ? (
          <>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Clinical notes…" rows={3}
              className="login-input resize-none w-full"
              style={{ fontSize: 10, lineHeight: 1.5 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'flex-end' }}>
              <button onClick={() => { setNotes(item?.meta?.notes || ''); setNotesEditing(false); }}
                className="btn-ghost px-2" style={{ fontSize: 9 }}>Cancel</button>
              <button onClick={handleSaveNotes} disabled={notesSaving}
                style={{ fontSize: 9, background: 'rgba(77,166,255,0.15)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.3)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                {notesSaving && <div className="spinner" style={{ width: 8, height: 8 }} />}
                {notesSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <div onClick={() => setNotesEditing(true)} title="Click to edit"
            style={{ fontSize: 10, color: notes ? 'var(--text)' : 'var(--muted)', lineHeight: 1.5, minHeight: 22, cursor: 'pointer', whiteSpace: 'pre-wrap' }}>
            {notes || 'No notes. Click to add…'}
          </div>
        )}
      </div>

      {/* ── Associated Images (label / macro / thumbnail) ── */}
      {meta?.associated_images && (
        <div className="viewer-meta-card">
          <SectionLabel>Slide Images</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { key: 'label',     label: 'Label' },
              { key: 'macro',     label: 'Macro' },
              { key: 'thumbnail', label: 'Thumbnail' },
            ].map(({ key, label }) => {
              const fileId = meta.associated_images[key];
              if (!fileId) return null;
              const url = getFileDownloadUrl(fileId);
              return (
                <div key={key}>
                  <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
                  <a href={url} target="_blank" rel="noreferrer" title={`Open ${label} full size`}>
                    <img
                      src={url}
                      alt={label}
                      style={{ width: '100%', borderRadius: 4, border: '1px solid var(--border)', display: 'block', cursor: 'zoom-in', transform: key === 'label' ? 'rotate(180deg)' : 'none' }}
                      onError={(e) => { e.target.parentElement.style.display = 'none'; }}
                    />
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── File Info (compact) ── */}
      {item && (
        <div className="viewer-meta-card">
          <SectionLabel>File Info</SectionLabel>
          <div style={{ fontFamily: 'monospace', fontSize: 9, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item._id}>
            {item._id}
          </div>
          {item.updated && (
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>
              Updated: {new Date(item.updated).toLocaleDateString()}
            </div>
          )}
        </div>
      )}

      {/* ── Status ── */}
      {(() => {
        const STATUS_OPTIONS = ['For Review','Pending','QC','Completed','STAT'];
        const STATUS_COLORS = {
          'For Review': { bg:'rgba(77,166,255,0.15)',  color:'#4da6ff', border:'rgba(77,166,255,0.35)' },
          'Pending':    { bg:'rgba(245,166,35,0.15)',  color:'#f5a623', border:'rgba(245,166,35,0.35)' },
          'QC':         { bg:'rgba(155,89,182,0.15)',  color:'#9b59b6', border:'rgba(155,89,182,0.35)' },
          'Completed':  { bg:'rgba(76,175,80,0.15)',   color:'#4caf50', border:'rgba(76,175,80,0.35)'  },
          'STAT':       { bg:'rgba(233,69,96,0.15)',   color:'#e94560', border:'rgba(233,69,96,0.35)'  },
        };
        const otherMeta = Object.entries(meta).filter(([k]) => !['notes','status'].includes(k) && (meta[k] || meta[k] === 0));
        return (
          <div className="viewer-meta-card">
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <SectionLabel>Status</SectionLabel>
              {statusSaved && <span style={{ color: '#4caf82', fontSize: 10 }}>✓ Saved</span>}
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1 mb-2">
              {STATUS_OPTIONS.map(s => {
                const active = selectedStatus === s;
                const c = STATUS_COLORS[s];
                return (
                  <button key={s}
                    onClick={() => setSelectedStatus(prev => prev === s ? '' : s)}
                    className="rounded-full font-medium transition-all"
                    style={{
                      fontSize: 10, padding: '2px 8px',
                      background: active ? c.bg : 'var(--bg)',
                      color:      active ? c.color : 'var(--muted)',
                      border:     active ? `1px solid ${c.border}` : '1px solid var(--border)',
                    }}>
                    {s}
                  </button>
                );
              })}
            </div>

            {/* Save button */}
            <button
              onClick={handleSaveStatus}
              disabled={statusSaving || selectedStatus === (item?.meta?.status || '')}
              className="flex items-center gap-1 px-3 py-1 rounded font-medium transition-all w-full justify-center"
              style={{
                fontSize: 10,
                background: 'rgba(77,166,255,0.15)', color: '#4da6ff',
                border: '1px solid rgba(77,166,255,0.3)',
                opacity: selectedStatus === (item?.meta?.status || '') ? 0.45 : 1,
              }}>
              {statusSaving && <div className="spinner" style={{ width: 9, height: 9 }} />}
              {statusSaving ? 'Saving…' : 'Save Status'}
            </button>

            {/* Other metadata as read-only rows */}
            {otherMeta.length > 0 && (
              <div className="flex flex-col gap-1 mt-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                {otherMeta.map(([k, v]) => {
                  const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
                  const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
                  return (
                    <div key={k} className="flex items-start justify-between gap-2">
                      <span style={{ color: 'var(--muted)', fontSize: 10, paddingTop: 1, flexShrink: 0 }}>{label}</span>
                      <span className="rounded px-1.5 py-0.5 font-medium text-right"
                        style={{ fontSize: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', maxWidth: 130, wordBreak: 'break-word' }}>
                        {val}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

    </div>
  );
}
