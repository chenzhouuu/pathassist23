// src/components/panels/MetadataPanel.jsx
import React, { useState, useEffect } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getItem, getThumbnailUrl, updateItemMetadata } from '../../api/index.js';

function SectionLabel({ children }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--muted)', fontSize: 10 }}>
      {children}
    </div>
  );
}


export default function MetadataPanel() {
  const { activeItem, tilesInfo } = useStore();
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
    <div className="p-2 flex flex-col gap-2">

      {/* Thumbnail */}
      <div className="rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <img
          src={thumbUrl}
          alt="Slide thumbnail"
          className="w-full object-contain"
          style={{ maxHeight: 130, background: 'var(--bg-viewer)' }}
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      </div>

      {/* Slide name */}
      <div className="text-xs font-medium break-all leading-tight" style={{ color: 'var(--text)' }}>
        {activeItem.name}
      </div>

      {/* ── Dr. Notes ── */}
      <div className="rounded p-2" style={{ background: 'var(--highlight)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-1">
          <SectionLabel>Dr. Notes</SectionLabel>
          <div className="flex items-center gap-2">
            {notesSaved && <span style={{ color: '#4caf82', fontSize: 10 }}>✓ Saved</span>}
            {!notesEditing && (
              <button
                onClick={() => setNotesEditing(true)}
                className="text-xs px-1.5 py-0.5 rounded transition-all"
                style={{ color: 'var(--accent)', background: 'rgba(77,166,255,0.1)', border: '1px solid rgba(77,166,255,0.25)', fontSize: 10 }}>
                Edit
              </button>
            )}
          </div>
        </div>

        {notesEditing ? (
          <>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Write clinical notes, observations, or comments…"
              rows={4}
              className="login-input resize-none w-full"
              style={{ fontFamily: 'IBM Plex Sans', lineHeight: 1.6, fontSize: 11 }}
            />
            <div className="flex gap-2 mt-1.5 justify-end">
              <button
                onClick={() => { setNotes(item?.meta?.notes || ''); setNotesEditing(false); }}
                className="btn-ghost px-2 text-xs" style={{ fontSize: 10 }}>
                Cancel
              </button>
              <button
                onClick={handleSaveNotes}
                disabled={notesSaving}
                className="flex items-center gap-1 px-2 py-1 rounded font-medium transition-all"
                style={{ background: 'rgba(77,166,255,0.15)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.3)', fontSize: 10 }}>
                {notesSaving && <div className="spinner" style={{ width: 9, height: 9 }} />}
                {notesSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <div
            className="whitespace-pre-wrap cursor-pointer"
            style={{ color: notes ? 'var(--text)' : 'var(--muted)', lineHeight: 1.6, fontSize: 11, minHeight: 32 }}
            onClick={() => setNotesEditing(true)}
            title="Click to edit notes">
            {notes || 'No notes yet. Click to add…'}
          </div>
        )}
      </div>

      {/* ── Image Info ── */}
      {tilesInfo && (
        <div className="rounded p-2" style={{ background: 'var(--highlight)', border: '1px solid var(--border)' }}>
          <SectionLabel>Image Info</SectionLabel>
          {/* Dimensions — prominent single line */}
          {tilesInfo.sizeX && tilesInfo.sizeY && (
            <div className="font-mono font-semibold mb-1.5" style={{ color: 'var(--text)', fontSize: 12 }}>
              {tilesInfo.sizeX.toLocaleString()} <span style={{ color: 'var(--muted)' }}>×</span> {tilesInfo.sizeY.toLocaleString()}
              <span className="font-normal ml-1" style={{ color: 'var(--muted)', fontSize: 10 }}>px</span>
            </div>
          )}
          {/* Detail chips */}
          <div className="flex flex-wrap gap-1">
            {tilesInfo.magnification && (
              <span className="tag">{tilesInfo.magnification}×</span>
            )}
            {tilesInfo.tileWidth && (
              <span className="tag">Tile {tilesInfo.tileWidth}px</span>
            )}
            {tilesInfo.levels && (
              <span className="tag">{tilesInfo.levels} levels</span>
            )}
            {tilesInfo.mm_x && (
              <span className="tag">{(tilesInfo.mm_x * 1000).toFixed(3)} μm/px</span>
            )}
            {tilesInfo.tilesource && (
              <span className="tag truncate max-w-[120px]" title={tilesInfo.tilesource}>{tilesInfo.tilesource}</span>
            )}
          </div>
        </div>
      )}

      {/* ── File Info ── */}
      {item && (
        <div className="rounded p-2" style={{ background: 'var(--highlight)', border: '1px solid var(--border)' }}>
          <SectionLabel>File Info</SectionLabel>
          {/* Size prominent */}
          {item.size && (
            <div className="font-semibold mb-1.5" style={{ color: 'var(--text)', fontSize: 12 }}>
              {(item.size / 1024 / 1024 / 1024).toFixed(2)}
              <span className="font-normal ml-1" style={{ color: 'var(--muted)', fontSize: 10 }}>GB</span>
            </div>
          )}
          {/* ID */}
          <div className="font-mono mb-1.5 truncate" style={{ color: 'var(--muted)', fontSize: 10 }} title={item._id}>
            {item._id}
          </div>
          {/* Dates */}
          <div className="flex gap-3">
            {item.created && (
              <div>
                <div style={{ color: 'var(--muted)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Created</div>
                <div style={{ color: 'var(--text)', fontSize: 10 }}>{new Date(item.created).toLocaleDateString()}</div>
              </div>
            )}
            {item.updated && (
              <div>
                <div style={{ color: 'var(--muted)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Updated</div>
                <div style={{ color: 'var(--text)', fontSize: 10 }}>{new Date(item.updated).toLocaleDateString()}</div>
              </div>
            )}
          </div>
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
          <div className="rounded p-2" style={{ background: 'var(--highlight)', border: '1px solid var(--border)' }}>
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
