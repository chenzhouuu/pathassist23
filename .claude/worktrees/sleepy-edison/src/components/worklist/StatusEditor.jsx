// src/components/worklist/StatusEditor.jsx
// Standalone status/metadata editor modal for an item
import React, { useState } from 'react';
import { updateItemMetadata } from '../../api/index.js';

const STATUS_OPTIONS = ['For Review','Pending','QC','Completed','STAT'];
const PRIORITY_OPTIONS = ['Routine','Consult','STAT'];

export default function StatusEditor({ item, onClose, onSave }) {
  const [meta, setMeta] = useState({
    status: item.meta?.status || '',
    priority: item.meta?.priority || 'Routine',
    diagnosis: item.meta?.diagnosis || '',
    assignedTo: item.meta?.assignedTo || '',
    notes: item.meta?.notes || '',
    stainType: item.meta?.stainType || '',
    organ: item.meta?.organ || '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateItemMetadata(item._id, meta);
      setSaved(true);
      setTimeout(() => { setSaved(false); onSave && onSave({ ...item, meta }); onClose && onClose(); }, 800);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background:'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)' }}>
      <div className="rounded-2xl w-full max-w-md mx-4" style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', boxShadow:'0 24px 80px rgba(0,0,0,0.8)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom:'1px solid var(--border)' }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Edit Image Metadata</div>
            <div className="text-xs mt-0.5 font-mono truncate max-w-xs" style={{ color: 'var(--muted)' }}>{item.name}</div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--muted)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Status */}
          <div>
            <label className="text-xs font-medium block mb-2" style={{ color: 'var(--muted)' }}>Status</label>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map(s => (
                <button key={s} onClick={() => setMeta(m => ({...m, status: m.status===s ? '' : s}))}
                  className="px-3 py-1 rounded-full text-xs transition-all"
                  style={{ background: meta.status===s ? 'rgba(77,166,255,0.15)' : 'var(--highlight)',
                    color: meta.status===s ? '#4da6ff' : 'var(--muted)',
                    border: meta.status===s ? '1px solid rgba(77,166,255,0.3)' : '1px solid var(--border)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="text-xs font-medium block mb-2" style={{ color: 'var(--muted)' }}>Priority</label>
            <div className="flex gap-2">
              {PRIORITY_OPTIONS.map(p => (
                <button key={p} onClick={() => setMeta(m => ({...m, priority:p}))}
                  className="px-3 py-1 rounded-full text-xs transition-all"
                  style={{ background: meta.priority===p ? 'rgba(245,166,35,0.15)' : 'var(--highlight)',
                    color: meta.priority===p ? '#f5a623' : 'var(--muted)',
                    border: meta.priority===p ? '1px solid rgba(245,166,35,0.3)' : '1px solid var(--border)' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Fields */}
          {[
            { key:'diagnosis', label:'Diagnosis', placeholder:'e.g. Diffuse Large B-Cell Lymphoma' },
            { key:'organ', label:'Organ / Tissue', placeholder:'e.g. Lymph node, Spleen' },
            { key:'stainType', label:'Stain Type', placeholder:'e.g. H&E, IHC, CD20' },
            { key:'assignedTo', label:'Assigned Pathologist', placeholder:'e.g. Dr. Smith' },
          ].map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--muted)' }}>{label}</label>
              <input value={meta[key]} onChange={e => setMeta(m => ({...m, [key]:e.target.value}))}
                placeholder={placeholder} className="login-input text-xs"/>
            </div>
          ))}

          {/* Notes */}
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--muted)' }}>Notes</label>
            <textarea value={meta.notes} onChange={e => setMeta(m => ({...m, notes:e.target.value}))}
              placeholder="Any clinical notes, special instructions…"
              rows={3} className="login-input text-xs resize-none w-full"
              style={{ fontFamily:'IBM Plex Sans' }}/>
          </div>
        </div>

        <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop:'1px solid var(--border)' }}>
          <button onClick={onClose} className="btn-ghost px-4">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-2 px-4 py-1.5 rounded text-xs font-medium transition-all"
            style={{ background: saved ? 'rgba(76,175,130,0.2)' : 'rgba(77,166,255,0.15)',
              color: saved ? '#4caf82' : '#4da6ff',
              border: saved ? '1px solid rgba(76,175,130,0.3)' : '1px solid rgba(77,166,255,0.3)' }}>
            {saving && <div className="spinner" style={{ width:12, height:12 }}/>}
            {saved ? '✓ Saved!' : saving ? 'Saving…' : 'Save Metadata'}
          </button>
        </div>
      </div>
    </div>
  );
}
