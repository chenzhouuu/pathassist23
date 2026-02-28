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
      <div className="rounded-2xl w-full max-w-md mx-4" style={{ background:'#13151f', border:'1px solid rgba(255,255,255,0.1)', boxShadow:'0 24px 80px rgba(0,0,0,0.8)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
          <div>
            <div className="text-sm font-semibold text-white">Edit Image Metadata</div>
            <div className="text-xs text-gray-600 mt-0.5 font-mono truncate max-w-xs">{item.name}</div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Status */}
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-2">Status</label>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map(s => (
                <button key={s} onClick={() => setMeta(m => ({...m, status: m.status===s ? '' : s}))}
                  className="px-3 py-1 rounded-full text-xs transition-all"
                  style={{ background: meta.status===s ? 'rgba(77,166,255,0.15)' : 'rgba(255,255,255,0.04)',
                    color: meta.status===s ? '#4da6ff' : '#6b7280',
                    border: meta.status===s ? '1px solid rgba(77,166,255,0.3)' : '1px solid rgba(255,255,255,0.08)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-2">Priority</label>
            <div className="flex gap-2">
              {PRIORITY_OPTIONS.map(p => (
                <button key={p} onClick={() => setMeta(m => ({...m, priority:p}))}
                  className="px-3 py-1 rounded-full text-xs transition-all"
                  style={{ background: meta.priority===p ? 'rgba(245,166,35,0.15)' : 'rgba(255,255,255,0.04)',
                    color: meta.priority===p ? '#f5a623' : '#6b7280',
                    border: meta.priority===p ? '1px solid rgba(245,166,35,0.3)' : '1px solid rgba(255,255,255,0.08)' }}>
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
              <label className="text-xs text-gray-500 font-medium block mb-1.5">{label}</label>
              <input value={meta[key]} onChange={e => setMeta(m => ({...m, [key]:e.target.value}))}
                placeholder={placeholder} className="login-input text-xs"/>
            </div>
          ))}

          {/* Notes */}
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1.5">Notes</label>
            <textarea value={meta.notes} onChange={e => setMeta(m => ({...m, notes:e.target.value}))}
              placeholder="Any clinical notes, special instructions…"
              rows={3} className="login-input text-xs resize-none w-full"
              style={{ fontFamily:'IBM Plex Sans' }}/>
          </div>
        </div>

        <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop:'1px solid rgba(255,255,255,0.07)' }}>
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
