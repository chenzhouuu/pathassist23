// src/components/share/SharePatientModal.jsx
// Generates a patient-accessible link for an entire folder (patient case).
// All slides in the folder are accessible after OTP verification.
// Share data is base64-encoded in the URL hash — no backend required for MVP.
import React, { useState, useEffect } from 'react';
import { GIRDER_BASE } from '../../config/girder.js';

const EXPIRY_OPTIONS = [
  { label: '24 hours', ms: 86_400_000 },
  { label: '48 hours', ms: 172_800_000 },
  { label: '7 days',   ms: 604_800_000 },
];

function generateOtp() {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

// folder: { _id, name, nItems, ... } — the patient's case folder
export default function SharePatientModal({ folder, onClose }) {
  const [patientName, setPatientName] = useState(folder?.name || '');
  const [phone, setPhone]             = useState('');
  const [expiryIdx, setExpiryIdx]     = useState(0);
  const [step, setStep]               = useState('form'); // 'form' | 'share'
  const [shareUrl, setShareUrl]       = useState('');
  const [otp, setOtp]                 = useState('');
  const [copied, setCopied]           = useState('');
  const smsEndpoint                   = import.meta.env?.VITE_SMS_WEBHOOK_URL || '';
  const [smsSending, setSmsSending]   = useState(false);
  const [smsSent, setSmsSent]         = useState(false);
  const [smsError, setSmsError]       = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleGenerate = () => {
    if (!patientName.trim()) return;
    const generatedOtp = generateOtp();
    const expiry = Date.now() + EXPIRY_OPTIONS[expiryIdx].ms;
    const shareData = {
      folderId:    folder._id,
      folderName:  folder.name,
      patientName: patientName.trim(),
      phone:       phone.trim(),
      otp:         generatedOtp,
      expiry,
      gt:          localStorage.getItem('girderToken') || '',
      api:         GIRDER_BASE,
    };
    const encoded = btoa(JSON.stringify(shareData));
    const url = `${window.location.origin}${window.location.pathname}#/patient/${encoded}`;
    setOtp(generatedOtp);
    setShareUrl(url);
    setStep('share');
  };

  const smsBody =
    `Hi ${patientName.trim() || 'there'},\n` +
    `Your pathology slides are ready to view securely.\n\n` +
    `Link: ${shareUrl}\n\n` +
    `Your access code: ${otp}\n\n` +
    `Enter this code when you open the link.\n` +
    `(Expires in ${EXPIRY_OPTIONS[expiryIdx].label})`;

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text).catch(() => {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    });
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  const sendViaSmsApi = async () => {
    if (!smsEndpoint || !phone.trim()) return;
    setSmsSending(true);
    setSmsError('');
    try {
      const res = await fetch(smsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: phone.trim(), body: smsBody }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSmsSent(true);
    } catch (e) {
      setSmsError(e.message || 'Failed to send SMS');
    }
    setSmsSending(false);
  };

  const inputStyle = {
    width: '100%', padding: '7px 10px', borderRadius: 7, fontSize: 12,
    background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', outline: 'none',
  };
  const labelStyle = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, display: 'block' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="rounded-xl p-5 w-full max-w-md flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.55)' }}>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--text)' }}>
              Share Case with Patient
            </h2>
            <div className="flex items-center gap-1.5 mt-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                {folder.name}
                {folder.nItems > 0 && <span className="ml-1 text-gray-700">({folder.nItems} slides)</span>}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700/50 transition-colors ml-3" style={{ color: 'var(--muted)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {step === 'form' ? (
          <>
            <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-xs"
              style={{ background: 'rgba(77,166,255,0.08)', border: '1px solid rgba(77,166,255,0.2)', color: 'var(--muted)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2" className="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Patient receives a link via SMS. They enter a 6-digit OTP to view all slides in this folder on their mobile device — no login required.
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label style={labelStyle}>Patient Name *</label>
                <input value={patientName} onChange={e => setPatientName(e.target.value)}
                  placeholder="e.g. John Doe" style={inputStyle}
                  onFocus={e => e.target.style.borderColor = '#4da6ff'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}/>
              </div>
              <div>
                <label style={labelStyle}>Patient Mobile Number</label>
                <input value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="+1 555 123 4567" type="tel" style={inputStyle}
                  onFocus={e => e.target.style.borderColor = '#4da6ff'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}/>
              </div>
              <div>
                <label style={labelStyle}>Link Expiry</label>
                <div className="flex gap-2">
                  {EXPIRY_OPTIONS.map((opt, i) => (
                    <button key={i} onClick={() => setExpiryIdx(i)}
                      className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                      style={{
                        background: expiryIdx === i ? 'rgba(77,166,255,0.15)' : 'var(--bg)',
                        color: expiryIdx === i ? '#4da6ff' : 'var(--muted)',
                        border: `1px solid ${expiryIdx === i ? 'rgba(77,166,255,0.35)' : 'var(--border)'}`,
                      }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <button onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
              <button onClick={handleGenerate} disabled={!patientName.trim()}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                style={{ background: '#4da6ff', color: '#fff', opacity: !patientName.trim() ? 0.5 : 1 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                  <polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                </svg>
                Generate Link
              </button>
            </div>
          </>
        ) : (
          <>
            {/* OTP display */}
            <div className="flex items-center justify-between px-4 py-3 rounded-xl"
              style={{ background: 'rgba(76,175,130,0.08)', border: '1px solid rgba(76,175,130,0.25)' }}>
              <div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>Patient Access Code (OTP)</div>
                <div className="text-3xl font-bold font-mono tracking-widest mt-0.5"
                  style={{ color: '#4caf82', letterSpacing: '0.25em' }}>
                  {otp}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  Expires in {EXPIRY_OPTIONS[expiryIdx].label}
                </div>
              </div>
              <button onClick={() => copyText(otp, 'otp')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs"
                style={{ background: 'rgba(76,175,130,0.15)', color: '#4caf82', border: '1px solid rgba(76,175,130,0.3)' }}>
                {copied === 'otp' ? '✓ Copied' : (
                  <>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                    Copy
                  </>
                )}
              </button>
            </div>

            {/* Test viewer button — prominent, full width */}
            <button
              onClick={() => window.open(shareUrl, '_blank')}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all"
              style={{ background: 'linear-gradient(135deg,#4da6ff22,#7c3aed22)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.4)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              Preview as Patient (opens new tab)
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 0 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>

            {/* Link */}
            <div>
              <label style={labelStyle}>Patient Link</label>
              <div className="flex gap-2 items-center">
                <div className="flex-1 px-3 py-2 rounded-lg text-xs font-mono truncate"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
                  {shareUrl.length > 80 ? shareUrl.slice(0, 80) + '…' : shareUrl}
                </div>
                <button onClick={() => copyText(shareUrl, 'link')}
                  className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg text-xs"
                  style={{ background: 'var(--highlight)', color: 'var(--text)', border: '1px solid var(--border)' }}>
                  {copied === 'link' ? '✓' : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* SMS preview */}
            <div>
              <label style={labelStyle}>SMS Message Preview</label>
              <div className="px-3 py-2 rounded-lg text-xs whitespace-pre-wrap"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', lineHeight: 1.6 }}>
                {smsBody}
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <button onClick={() => copyText(smsBody, 'sms')}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all"
                style={{
                  background: copied === 'sms' ? 'rgba(76,175,130,0.15)' : 'var(--highlight)',
                  color: copied === 'sms' ? '#4caf82' : 'var(--text)',
                  border: `1px solid ${copied === 'sms' ? 'rgba(76,175,130,0.3)' : 'var(--border)'}`,
                }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                {copied === 'sms' ? '✓ Copied to clipboard' : 'Copy Full SMS to Send'}
              </button>

              {smsEndpoint && phone.trim() && (
                <button onClick={sendViaSmsApi} disabled={smsSending || smsSent}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold"
                  style={{
                    background: smsSent ? 'rgba(76,175,130,0.15)' : '#4da6ff',
                    color: smsSent ? '#4caf82' : '#fff',
                    border: smsSent ? '1px solid rgba(76,175,130,0.3)' : 'none',
                  }}>
                  {smsSending && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"/>}
                  {smsSent ? '✓ SMS Sent Successfully' : smsSending ? 'Sending…' : `Send SMS to ${phone.trim()}`}
                </button>
              )}

              {smsError && (
                <div className="text-xs px-3 py-1.5 rounded-lg" style={{ background: '#e9456018', color: '#e94560', border: '1px solid #e9456033' }}>
                  {smsError}
                </div>
              )}

              {!smsEndpoint && phone.trim() && (
                <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
                  Copy the SMS above and send to {phone.trim()}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setStep('form')}
                className="text-xs flex items-center gap-1"
                style={{ color: 'var(--muted)' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Edit details
              </button>
              <button onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: '#4da6ff', color: '#fff' }}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
