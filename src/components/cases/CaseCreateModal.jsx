import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getCollections,
  getFolders,
  getItems,
  getFolderDetails,
  updateFolderMetadata,
} from '../../api/index.js';

function buildCaseId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `SO-${y}${m}${day}-${rand}`;
}

export default function CaseCreateModal({ initialCollectionId = '', onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    caseId: buildCaseId(),
    patientId: '',
    age: '',
    sex: '',
    anatomicalSite: '',
    urgency: 'Routine',
    cancerType: '',
    biopsyType: '',
    clinicalHistory: '',
    provisionalDiagnosis: '',
    diseaseInfo: '',
    originalReportText: '',
    collectionId: initialCollectionId || '',
    folderId: '',
    reportItemId: '',
  });
  const [selectedItemIds, setSelectedItemIds] = useState([]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: getCollections,
    staleTime: 60_000,
  });

  const { data: folders = [] } = useQuery({
    queryKey: ['folders-collection', form.collectionId],
    queryFn: () => getFolders('collection', form.collectionId),
    enabled: !!form.collectionId,
    staleTime: 60_000,
  });

  const { data: folderItems = [] } = useQuery({
    queryKey: ['items-folder', form.folderId, 'case-create'],
    queryFn: () => getItems(form.folderId, 0, 500),
    enabled: !!form.folderId,
    staleTime: 30_000,
  });

  useEffect(() => {
    setSelectedItemIds(folderItems.map((i) => i._id));
  }, [form.folderId, folderItems]);

  const pdfItems = useMemo(
    () => folderItems.filter((i) => (i.name || '').toLowerCase().endsWith('.pdf')),
    [folderItems]
  );

  const imageItems = useMemo(
    () => folderItems.filter((i) => !(i.name || '').toLowerCase().endsWith('.pdf')),
    [folderItems]
  );

  const toggleItem = (itemId) => {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  };

  const handleSubmit = async () => {
    if (!form.collectionId) return setError('Select a collection.');
    if (!form.folderId) return setError('Select a patient folder.');
    if (!form.patientId.trim()) return setError('Patient ID is required.');
    if (selectedItemIds.length === 0) return setError('Select at least one image item.');

    setSaving(true);
    setError('');
    try {
      const folder = await getFolderDetails(form.folderId);
      const existing = folder?.meta?.pathassist || {};
      const now = new Date().toISOString();

      const secondOpinion = {
        ...(existing.secondOpinion || {}),
        schemaVersion: 1,
        caseId: form.caseId.trim() || buildCaseId(),
        caseType: 'second_opinion',
        status: existing.secondOpinion?.status || 'Submitted',
        createdAt: existing.secondOpinion?.createdAt || now,
        updatedAt: now,
        patient: {
          patientId: form.patientId.trim(),
          age: form.age ? Number(form.age) : null,
          sex: form.sex || '',
        },
        clinical: {
          anatomicalSite: form.anatomicalSite.trim(),
          urgency: form.urgency,
          cancerType: form.cancerType.trim(),
          biopsyType: form.biopsyType.trim(),
          provisionalDiagnosis: form.provisionalDiagnosis.trim(),
          clinicalHistory: form.clinicalHistory.trim(),
          diseaseInfo: form.diseaseInfo.trim(),
        },
        source: {
          collectionId: form.collectionId,
          folderId: form.folderId,
          imageItemIds: selectedItemIds,
          originalReport: {
            itemId: form.reportItemId || null,
            text: form.originalReportText.trim(),
          },
        },
      };

      await updateFolderMetadata(form.folderId, {
        pathassist: {
          ...existing,
          secondOpinion,
        },
      });

      if (onSaved) onSaved({ folderId: form.folderId, collectionId: form.collectionId });
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Failed to create case');
      setSaving(false);
    }
  };

  const labelStyle = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, display: 'block' };
  const inputStyle = {
    width: '100%',
    padding: '7px 10px',
    borderRadius: 7,
    fontSize: 12,
    background: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    outline: 'none',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-xl p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.55)' }}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--text)' }}>Create Second Opinion Case</h2>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
              Link existing large images from assetstore folders and save structured case metadata.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700/50 transition-colors" style={{ color: 'var(--muted)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label style={labelStyle}>Case ID</label>
            <input value={form.caseId} onChange={(e) => setForm((f) => ({ ...f, caseId: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Patient ID *</label>
            <input value={form.patientId} onChange={(e) => setForm((f) => ({ ...f, patientId: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Age</label>
            <input type="number" min="0" max="120" value={form.age} onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Sex</label>
            <select value={form.sex} onChange={(e) => setForm((f) => ({ ...f, sex: e.target.value }))} style={inputStyle}>
              <option value="">Select</option>
              <option>Female</option>
              <option>Male</option>
              <option>Other</option>
              <option>Unknown</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Anatomical Site</label>
            <input value={form.anatomicalSite} onChange={(e) => setForm((f) => ({ ...f, anatomicalSite: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Urgency</label>
            <select value={form.urgency} onChange={(e) => setForm((f) => ({ ...f, urgency: e.target.value }))} style={inputStyle}>
              <option>Routine</option>
              <option>Urgent</option>
              <option>STAT</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Cancer / Disease</label>
            <input value={form.cancerType} onChange={(e) => setForm((f) => ({ ...f, cancerType: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Biopsy Type</label>
            <input value={form.biopsyType} onChange={(e) => setForm((f) => ({ ...f, biopsyType: e.target.value }))} style={inputStyle} />
          </div>
          <div className="md:col-span-3">
            <label style={labelStyle}>Provisional Diagnosis</label>
            <input value={form.provisionalDiagnosis} onChange={(e) => setForm((f) => ({ ...f, provisionalDiagnosis: e.target.value }))} style={inputStyle} />
          </div>
          <div className="md:col-span-3">
            <label style={labelStyle}>Clinical History</label>
            <textarea rows={2} value={form.clinicalHistory} onChange={(e) => setForm((f) => ({ ...f, clinicalHistory: e.target.value }))} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div className="md:col-span-3">
            <label style={labelStyle}>Additional Disease Information</label>
            <textarea rows={2} value={form.diseaseInfo} onChange={(e) => setForm((f) => ({ ...f, diseaseInfo: e.target.value }))} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label style={labelStyle}>Collection *</label>
            <select
              value={form.collectionId}
              onChange={(e) => setForm((f) => ({ ...f, collectionId: e.target.value, folderId: '', reportItemId: '' }))}
              style={inputStyle}
            >
              <option value="">Select collection</option>
              {collections.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Patient Folder (images already uploaded) *</label>
            <select
              value={form.folderId}
              onChange={(e) => setForm((f) => ({ ...f, folderId: e.target.value, reportItemId: '' }))}
              style={inputStyle}
              disabled={!form.collectionId}
            >
              <option value="">Select folder</option>
              {folders.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
            </select>
          </div>
        </div>

        {form.folderId && (
          <>
            <div>
              <label style={labelStyle}>Original Report PDF (optional, from same folder)</label>
              <select
                value={form.reportItemId}
                onChange={(e) => setForm((f) => ({ ...f, reportItemId: e.target.value }))}
                style={inputStyle}
              >
                <option value="">None</option>
                {pdfItems.map((i) => <option key={i._id} value={i._id}>{i.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Original Report Notes / Summary</label>
              <textarea rows={2} value={form.originalReportText} onChange={(e) => setForm((f) => ({ ...f, originalReportText: e.target.value }))} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label style={{ ...labelStyle, marginBottom: 0 }}>Select WSI/Image Items *</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedItemIds(imageItems.map((i) => i._id))}
                    className="text-xs px-2 py-1 rounded"
                    style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setSelectedItemIds([])}
                    className="text-xs px-2 py-1 rounded"
                    style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-44 overflow-y-auto rounded-lg p-2" style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}>
                {imageItems.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>No image items found in this folder.</div>
                ) : imageItems.map((item) => (
                  <label key={item._id} className="flex items-center gap-2 py-1.5 text-xs cursor-pointer" style={{ color: 'var(--text)' }}>
                    <input type="checkbox" checked={selectedItemIds.includes(item._id)} onChange={() => toggleItem(item._id)} />
                    <span className="truncate flex-1">{item.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="text-xs px-3 py-2 rounded-lg" style={{ background: '#e9456018', color: '#e94560', border: '1px solid #e9456033' }}>
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
            style={{ background: '#4da6ff', color: '#fff' }}
          >
            {saving && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {saving ? 'Saving...' : 'Create Case'}
          </button>
        </div>
      </div>
    </div>
  );
}
