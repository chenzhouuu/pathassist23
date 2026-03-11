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

const STAIN_OPTIONS = ['H&E', 'IHC', 'PAS', 'AFB', 'Trichrome', 'Giemsa', 'Other'];
const TREATMENT_OPTIONS = ['Chemotherapy', 'Radiation', 'Surgery', 'Immunotherapy', 'None'];

// ── Step indicator ────────────────────────────────────────────────────────────
function StepIndicator({ step }) {
  const steps = [
    { n: 1, label: 'Patient & Case' },
    { n: 2, label: 'Pathology Details' },
    { n: 3, label: 'Attach Slides' },
  ];
  return (
    <div className="flex items-center gap-0 mb-5">
      {steps.map((s, i) => (
        <React.Fragment key={s.n}>
          <div className="flex flex-col items-center gap-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
              style={{
                background: step >= s.n ? '#4da6ff' : 'var(--bg)',
                color: step >= s.n ? '#fff' : 'var(--muted)',
                border: step >= s.n ? '2px solid #4da6ff' : '2px solid var(--border)',
              }}
            >
              {step > s.n ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : s.n}
            </div>
            <span className="text-xs whitespace-nowrap" style={{ color: step >= s.n ? 'var(--text)' : 'var(--muted)', fontSize: 10 }}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className="flex-1 h-px mx-2 mb-4 transition-all" style={{ background: step > s.n ? '#4da6ff' : 'var(--border)' }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export default function CaseCreateModal({ initialCollectionId = '', onClose, onSaved }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    // Step 1
    caseId: buildCaseId(),
    patientId: '',
    age: '',
    sex: '',
    referringInstitution: '',
    reasonForSecondOpinion: '',
    urgency: 'Routine',
    // Step 2
    anatomicalSite: '',
    specimenType: '',
    biopsyType: '',
    cancerType: '',
    stainTypes: [],
    priorTreatment: [],
    ihcSummary: '',
    clinicalHistory: '',
    provisionalDiagnosis: '',
    diseaseInfo: '',
    relevantLabFindings: '',
    // Step 3
    collectionId: initialCollectionId || '',
    folderId: '',
    reportItemId: '',
    originalReportText: '',
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

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const toggleArray = (key, val) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(val) ? f[key].filter((v) => v !== val) : [...f[key], val],
    }));

  const toggleItem = (itemId) =>
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );

  const validateStep = (s) => {
    if (s === 1) {
      if (!form.patientId.trim()) return 'Patient ID is required.';
    }
    if (s === 3) {
      if (!form.collectionId) return 'Select a collection.';
      if (!form.folderId) return 'Select a patient folder.';
      if (selectedItemIds.length === 0) return 'Select at least one image item.';
    }
    return '';
  };

  const handleNext = () => {
    const err = validateStep(step);
    if (err) { setError(err); return; }
    setError('');
    setStep((s) => s + 1);
  };

  const handleBack = () => { setError(''); setStep((s) => s - 1); };

  const handleSubmit = async () => {
    const err = validateStep(3);
    if (err) { setError(err); return; }

    setSaving(true);
    setError('');
    try {
      const folder = await getFolderDetails(form.folderId);
      const existing = folder?.meta?.pathassist || {};
      const now = new Date().toISOString();

      const secondOpinion = {
        ...(existing.secondOpinion || {}),
        schemaVersion: 2,
        caseId: form.caseId.trim() || buildCaseId(),
        caseType: 'second_opinion',
        status: existing.secondOpinion?.status || 'Submitted',
        createdAt: existing.secondOpinion?.createdAt || now,
        updatedAt: now,
        patient: {
          patientId: form.patientId.trim(),
          age: form.age ? Number(form.age) : null,
          sex: form.sex || '',
          referringInstitution: form.referringInstitution.trim(),
        },
        clinical: {
          anatomicalSite: form.anatomicalSite.trim(),
          urgency: form.urgency,
          cancerType: form.cancerType.trim(),
          specimenType: form.specimenType,
          biopsyType: form.biopsyType.trim(),
          stainTypes: form.stainTypes,
          priorTreatment: form.priorTreatment,
          provisionalDiagnosis: form.provisionalDiagnosis.trim(),
          clinicalHistory: form.clinicalHistory.trim(),
          diseaseInfo: form.diseaseInfo.trim(),
          ihcSummary: form.ihcSummary.trim(),
          relevantLabFindings: form.relevantLabFindings.trim(),
          reasonForSecondOpinion: form.reasonForSecondOpinion,
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
        pathassist: { ...existing, secondOpinion },
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
    width: '100%', padding: '7px 10px', borderRadius: 7, fontSize: 12,
    background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', outline: 'none',
  };
  const checkboxGroupStyle = {
    display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: 4,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.55)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--text)' }}>Create Second Opinion Case</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              {step === 1 && 'Enter patient and case information'}
              {step === 2 && 'Provide pathology and clinical details'}
              {step === 3 && 'Select slides and attach the original report'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700/50 transition-colors" style={{ color: 'var(--muted)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <StepIndicator step={step} />

        {/* ── Step 1: Patient & Case ─────────────────────────────────────────── */}
        {step === 1 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Case ID</label>
              <input value={form.caseId} onChange={(e) => set('caseId', e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Patient ID *</label>
              <input value={form.patientId} onChange={(e) => set('patientId', e.target.value)} style={inputStyle} placeholder="Internal patient reference" />
            </div>
            <div>
              <label style={labelStyle}>Age</label>
              <input type="number" min="0" max="120" value={form.age} onChange={(e) => set('age', e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Biological Sex</label>
              <select value={form.sex} onChange={(e) => set('sex', e.target.value)} style={inputStyle}>
                <option value="">Select</option>
                <option>Female</option>
                <option>Male</option>
                <option>Other</option>
                <option>Unknown</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Referring Institution</label>
              <input value={form.referringInstitution} onChange={(e) => set('referringInstitution', e.target.value)} style={inputStyle} placeholder="Hospital or lab name" />
            </div>
            <div>
              <label style={labelStyle}>Reason for Second Opinion</label>
              <select value={form.reasonForSecondOpinion} onChange={(e) => set('reasonForSecondOpinion', e.target.value)} style={inputStyle}>
                <option value="">Select</option>
                <option>Diagnostic Difficulty</option>
                <option>Rare Tumor</option>
                <option>Treatment Planning</option>
                <option>Medicolegal</option>
                <option>Quality Assurance</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Urgency</label>
              <select value={form.urgency} onChange={(e) => set('urgency', e.target.value)} style={inputStyle}>
                <option>Routine</option>
                <option>Urgent</option>
                <option>STAT</option>
              </select>
            </div>
          </div>
        )}

        {/* ── Step 2: Pathology Details ──────────────────────────────────────── */}
        {step === 2 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Anatomical Site</label>
              <input value={form.anatomicalSite} onChange={(e) => set('anatomicalSite', e.target.value)} style={inputStyle} placeholder="e.g. Breast, Lung, Skin" />
            </div>
            <div>
              <label style={labelStyle}>Specimen Type</label>
              <select value={form.specimenType} onChange={(e) => set('specimenType', e.target.value)} style={inputStyle}>
                <option value="">Select</option>
                <option>Surgical Excision</option>
                <option>Core Biopsy</option>
                <option>Fine Needle Aspiration</option>
                <option>Cytology</option>
                <option>Resection</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Biopsy Type</label>
              <input value={form.biopsyType} onChange={(e) => set('biopsyType', e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Cancer / Disease Type</label>
              <input value={form.cancerType} onChange={(e) => set('cancerType', e.target.value)} style={inputStyle} />
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Stain Types</label>
              <div style={checkboxGroupStyle}>
                {STAIN_OPTIONS.map((s) => (
                  <label key={s} className="flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded"
                    style={{ border: '1px solid var(--border)', background: form.stainTypes.includes(s) ? 'rgba(77,166,255,0.12)' : 'var(--bg)', color: form.stainTypes.includes(s) ? '#4da6ff' : 'var(--muted)' }}>
                    <input type="checkbox" checked={form.stainTypes.includes(s)} onChange={() => toggleArray('stainTypes', s)} className="hidden" />
                    {s}
                  </label>
                ))}
              </div>
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Prior Treatment</label>
              <div style={checkboxGroupStyle}>
                {TREATMENT_OPTIONS.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded"
                    style={{ border: '1px solid var(--border)', background: form.priorTreatment.includes(t) ? 'rgba(194,122,255,0.12)' : 'var(--bg)', color: form.priorTreatment.includes(t) ? '#c27aff' : 'var(--muted)' }}>
                    <input type="checkbox" checked={form.priorTreatment.includes(t)} onChange={() => toggleArray('priorTreatment', t)} className="hidden" />
                    {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>IHC Results Summary</label>
              <textarea rows={2} value={form.ihcSummary} onChange={(e) => set('ihcSummary', e.target.value)}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                placeholder="e.g. ER+, PR+, HER2-, Ki-67 30%" />
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Clinical History</label>
              <textarea rows={2} value={form.clinicalHistory} onChange={(e) => set('clinicalHistory', e.target.value)}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Provisional Diagnosis</label>
              <input value={form.provisionalDiagnosis} onChange={(e) => set('provisionalDiagnosis', e.target.value)} style={inputStyle} />
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Additional Disease Information</label>
              <textarea rows={2} value={form.diseaseInfo} onChange={(e) => set('diseaseInfo', e.target.value)}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div className="md:col-span-2">
              <label style={labelStyle}>Relevant Lab / Imaging Findings (de-identified)</label>
              <textarea rows={2} value={form.relevantLabFindings} onChange={(e) => set('relevantLabFindings', e.target.value)}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                placeholder="CBC summary, imaging impressions — no patient identifiers" />
            </div>
          </div>
        )}

        {/* ── Step 3: Attach Slides & Report ────────────────────────────────── */}
        {step === 3 && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label style={labelStyle}>Collection *</label>
                <select value={form.collectionId}
                  onChange={(e) => setForm((f) => ({ ...f, collectionId: e.target.value, folderId: '', reportItemId: '' }))}
                  style={inputStyle}>
                  <option value="">Select collection</option>
                  {collections.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Patient Folder *</label>
                <select value={form.folderId}
                  onChange={(e) => setForm((f) => ({ ...f, folderId: e.target.value, reportItemId: '' }))}
                  style={inputStyle} disabled={!form.collectionId}>
                  <option value="">Select folder</option>
                  {folders.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
                </select>
              </div>
            </div>

            {form.folderId && (
              <>
                <div>
                  <label style={labelStyle}>Original Report PDF (optional)</label>
                  <select value={form.reportItemId}
                    onChange={(e) => set('reportItemId', e.target.value)} style={inputStyle}>
                    <option value="">None</option>
                    {pdfItems.map((i) => <option key={i._id} value={i._id}>{i.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Original Report Notes / Summary</label>
                  <textarea rows={2} value={form.originalReportText} onChange={(e) => set('originalReportText', e.target.value)}
                    style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label style={{ ...labelStyle, marginBottom: 0 }}>Select WSI / Image Items *</label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setSelectedItemIds(imageItems.map((i) => i._id))}
                        className="text-xs px-2 py-1 rounded"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
                        Select All
                      </button>
                      <button onClick={() => setSelectedItemIds([])}
                        className="text-xs px-2 py-1 rounded"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="max-h-44 overflow-y-auto rounded-lg p-2"
                    style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}>
                    {imageItems.length === 0 ? (
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>No image items found in this folder.</div>
                    ) : imageItems.map((item) => (
                      <label key={item._id} className="flex items-center gap-2 py-1.5 text-xs cursor-pointer"
                        style={{ color: 'var(--text)' }}>
                        <input type="checkbox" checked={selectedItemIds.includes(item._id)} onChange={() => toggleItem(item._id)} />
                        <span className="truncate flex-1">{item.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-xs px-3 py-2 rounded-lg" style={{ background: '#e9456018', color: '#e94560', border: '1px solid #e9456033' }}>
            {error}
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between pt-1">
          <button onClick={handleBack} disabled={step === 1}
            className="px-4 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'var(--bg)', color: step === 1 ? 'var(--border)' : 'var(--muted)', border: '1px solid var(--border)', cursor: step === 1 ? 'default' : 'pointer' }}>
            Back
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              Cancel
            </button>
            {step < 3 ? (
              <button onClick={handleNext}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: '#4da6ff', color: '#fff' }}>
                Next →
              </button>
            ) : (
              <button onClick={handleSubmit} disabled={saving}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                style={{ background: '#4da6ff', color: '#fff' }}>
                {saving && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {saving ? 'Saving...' : 'Create Case'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
