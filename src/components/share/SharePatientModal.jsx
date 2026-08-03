// src/components/share/SharePatientModal.jsx
// Generates a patient-accessible link for an entire folder (patient case).
// All slides in the folder are accessible after OTP verification.
// Share data is base64-encoded in the URL hash — no backend required for MVP.
import { useState, useEffect } from 'react';
import { GIRDER_BASE } from '../../config/girder.js';

const EXPIRY_OPTIONS = [
  { label: '24 hours', ms: 86_400_000 },
  { label: '48 hours', ms: 172_800_000 },
  { label: '7 days',   ms: 604_800_000 },
];

function generateOtp() {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

async function fetchShareItems(folderId, token, depth = 0) {
  const headers = { 'Girder-Token': token };
  const itemsRes = await fetch(`${GIRDER_BASE}/item?folderId=${folderId}&limit=500&sort=name`, { headers });
  const directItems = itemsRes.ok ? await itemsRes.json() : [];
  const collected = (Array.isArray(directItems) ? directItems : []).map((item) => ({
    _id: item._id,
    name: item.name,
  }));

  if (depth < 2) {
    const foldersRes = await fetch(`${GIRDER_BASE}/folder?parentType=folder&parentId=${folderId}&limit=200&sort=name`, { headers });
    const subFolders = foldersRes.ok ? await foldersRes.json() : [];
    if (Array.isArray(subFolders) && subFolders.length > 0) {
      const nested = await Promise.all(subFolders.map((sf) => fetchShareItems(sf._id, token, depth + 1)));
      collected.push(...nested.flat());
    }
  }

  collected.sort((a, b) => a.name.localeCompare(b.name));
  return collected;
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
  const [generating, setGenerating]   = useState(false);
  const smsEndpoint                   = import.meta.env?.VITE_SMS_WEBHOOK_URL || '';
  const [smsSending, setSmsSending]   = useState(false);
  const [smsSent, setSmsSent]         = useState(false);
  const [smsError, setSmsError]       = useState('');
  const [generateError, setGenerateError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Creates a Girder API key and exchanges it for a token with the share's exact expiry duration.
  // Patient-share links should only be created from a dedicated expiring token.
  async function createShareToken(durationDays) {
    const sessionToken = localStorage.getItem('girderToken') || '';
    if (!sessionToken) throw new Error('No active Girder session found.');
    try {
      const keyRes = await fetch(`${GIRDER_BASE}/api_key`, {
        method: 'POST',
        headers: { 'Girder-Token': sessionToken, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          name:          `patient-share-${folder._id}-${Date.now()}`,
          active:        'true',
          tokenDuration: String(durationDays),
        }),
      });
      if (!keyRes.ok) throw new Error(`API key creation failed (${keyRes.status})`);
      const keyData = await keyRes.json();
      if (!keyData?.key) throw new Error('API key creation did not return a key.');

      const tokenRes = await fetch(`${GIRDER_BASE}/api_key/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key: keyData.key, duration: String(durationDays) }),
      });
      if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
      const tokenData = await tokenRes.json();
      const token = tokenData?.authToken?.token;
      if (!token) throw new Error('Token exchange did not return an auth token.');
      return token;
    } catch (e) {
      console.warn('[SharePatientModal] Dedicated patient share token failed:', e);
      throw e;
    }
  }

  const handleGenerate = async () => {
    if (!patientName.trim()) return;
    setGenerating(true);
    setGenerateError('');

    const expiryOpt = EXPIRY_OPTIONS[expiryIdx];
    const expiry = Date.now() + expiryOpt.ms;
    const durationDays = expiryOpt.ms / 86_400_000;
    try {
      const shareToken = await createShareToken(durationDays);
      const sharedItems = await fetchShareItems(folder._id, shareToken);
      if (sharedItems.length === 0) {
        throw new Error('No slides were found in this case folder.');
      }

      const generatedOtp = generateOtp();
      const shareData = {
        folderId:    folder._id,
        folderName:  folder.name,
        patientName: patientName.trim(),
        phone:       phone.trim(),
        otp:         generatedOtp,
        expiry,
        gt:          shareToken,
        api:         GIRDER_BASE,
        items:       sharedItems,
      };
      const encoded = btoa(JSON.stringify(shareData));
      const url = `${window.location.origin}${window.location.pathname}#/patient/${encoded}`;
      setOtp(generatedOtp);
      setShareUrl(url);
      setStep('share');
    } catch (e) {
      setGenerateError(e?.message || 'Could not create a patient share link.');
    } finally {
      setGenerating(false);
    }
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

  // A well, like every other input on the page: sunken ground, no border, a brand ring only while
  // focused. `borderRadius: 7` was on no scale in the system at all.
  const inputStyle = {
    width: '100%', padding: '7px 10px', borderRadius: 'var(--radius-2)', fontSize: 12,
    background: 'var(--sunken)', color: 'var(--ink)', border: 0, outline: 'none',
    boxShadow: 'inset 0 0 0 1px transparent', transition: 'box-shadow .12s',
  };
  const FOCUS_RING = 'inset 0 0 0 1px var(--brand)';
  const labelStyle = { fontSize: 11, color: 'var(--ink-2)', marginBottom: 4, display: 'block' };

  return (
    // The scrim, the corner, the edge and the shadow come from _dialogs.css, the same four the other
    // two dialogs read. The 60px black plume that stood here was drawn for the Viewer's dark ground;
    // `--elev-2` is the page's answer and it is theme-aware.
    <div className="browser-modal-scrim"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="browser-modal" style={{ width: 'min(28rem, 100%)', padding: 20, gap: 16 }}>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--ink)' }}>
              Share Case with Patient
            </h2>
            <div className="flex items-center gap-1.5 mt-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="text-xs" style={{ color: 'var(--ink-2)' }}>
                {folder.name}
                {folder.nItems > 0 && <span className="ml-1" style={{ color: 'var(--ink-3)' }}>({folder.nItems} slides)</span>}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded transition-colors ml-3" style={{ color: 'var(--ink-2)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {step === 'form' ? (
          <>
            <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-xs"
              style={{ background: 'hsl(var(--brand-hsl) / .08)', border: '1px solid hsl(var(--brand-hsl) / .2)', color: 'var(--ink-2)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" className="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Patient receives a link via SMS. They enter a 6-digit OTP to view all slides in this folder on their mobile device — no login required.
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label style={labelStyle}>Patient Name *</label>
                <input value={patientName} onChange={e => setPatientName(e.target.value)}
                  placeholder="e.g. John Doe" style={inputStyle}
                  onFocus={e => { e.target.style.boxShadow = FOCUS_RING; }}
                  onBlur={e => { e.target.style.boxShadow = 'inset 0 0 0 1px transparent'; }}/>
              </div>
              <div>
                <label style={labelStyle}>Patient Mobile Number</label>
                <input value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="+1 555 123 4567" type="tel" style={inputStyle}
                  onFocus={e => { e.target.style.boxShadow = FOCUS_RING; }}
                  onBlur={e => { e.target.style.boxShadow = 'inset 0 0 0 1px transparent'; }}/>
              </div>
              <div>
                <label style={labelStyle}>Link Expiry</label>
                <div className="flex gap-2">
                  {EXPIRY_OPTIONS.map((opt, i) => (
                    <button key={i} onClick={() => setExpiryIdx(i)}
                      className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                      style={{
                        background: expiryIdx === i ? 'var(--wash)' : 'var(--sunken)',
                        color: expiryIdx === i ? 'var(--brand)' : 'var(--ink-2)',
                        border: 0,
                        boxShadow: expiryIdx === i ? 'inset 0 0 0 1px hsl(var(--brand-hsl) / .35)' : 'none',
                      }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {generateError && (
              <div className="text-xs px-3 py-2 rounded-lg"
                style={{ background: 'color-mix(in oklab, var(--sem-flag) var(--sem-mix), var(--surface))', color: 'var(--sem-flag-ink)', border: '1px solid color-mix(in oklab, var(--sem-flag) 28%, transparent)' }}>
                {generateError}
              </div>
            )}

            <div className="flex gap-2 justify-end pt-1">
              <button onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: 'transparent', color: 'var(--ink-2)', border: 0, boxShadow: 'inset 0 0 0 1px var(--line-2)' }}>
                Cancel
              </button>
              <button onClick={handleGenerate} disabled={!patientName.trim() || generating}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                style={{ background: 'var(--brand)', color: 'var(--brand-ink)', opacity: (!patientName.trim() || generating) ? 0.6 : 1 }}>
                {generating ? (
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"/>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                    <polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                  </svg>
                )}
                {generating ? 'Creating secure token…' : 'Generate Link'}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* OTP display */}
            <div className="flex items-center justify-between px-4 py-3" style={{ borderRadius: 'var(--radius-3)' }}
              style={{ background: 'color-mix(in oklab, var(--sem-read) var(--sem-mix), var(--surface))', border: '1px solid color-mix(in oklab, var(--sem-read) 28%, transparent)' }}>
              <div>
                <div className="text-xs" style={{ color: 'var(--ink-2)' }}>Patient Access Code (OTP)</div>
                <div className="text-3xl font-bold font-mono tracking-widest mt-0.5"
                  style={{ color: 'var(--sem-read-ink)', letterSpacing: '0.25em' }}>
                  {otp}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--ink-2)' }}>
                  Expires in {EXPIRY_OPTIONS[expiryIdx].label}
                </div>
              </div>
              <button onClick={() => copyText(otp, 'otp')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs"
                style={{ background: 'color-mix(in oklab, var(--sem-read) var(--sem-mix), var(--surface))', color: 'var(--sem-read-ink)', border: '1px solid color-mix(in oklab, var(--sem-read) 30%, transparent)' }}>
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
              className="w-full flex items-center justify-center gap-2 py-2.5 text-xs font-semibold transition-all"
              style={{
                borderRadius: 'var(--radius-3)',
                background: 'var(--wash)', color: 'var(--brand)',
                border: '1px solid hsl(var(--brand-hsl) / .4)',
              }}>
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
                  style={{ background: 'var(--sunken)', border: 0, color: 'var(--ink-2)' }}>
                  {shareUrl.length > 80 ? shareUrl.slice(0, 80) + '…' : shareUrl}
                </div>
                <button onClick={() => copyText(shareUrl, 'link')}
                  className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg text-xs"
                  style={{ background: 'var(--sunken)', color: 'var(--ink)', border: 0 }}>
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
                style={{ background: 'var(--sunken)', border: 0, color: 'var(--ink)', lineHeight: 1.6 }}>
                {smsBody}
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <button onClick={() => copyText(smsBody, 'sms')}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all"
                style={{
                  background: copied === 'sms' ? 'color-mix(in oklab, var(--sem-read) var(--sem-mix), var(--surface))' : 'var(--sunken)',
                  color: copied === 'sms' ? 'var(--sem-read-ink)' : 'var(--ink)',
                  border: `1px solid ${copied === 'sms' ? 'color-mix(in oklab, var(--sem-read) 30%, transparent)' : 'transparent'}`,
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
                    background: smsSent ? 'color-mix(in oklab, var(--sem-read) var(--sem-mix), var(--surface))' : 'var(--brand)',
                    color: smsSent ? 'var(--sem-read-ink)' : 'var(--brand-ink)',
                    border: smsSent ? '1px solid rgba(76,175,130,0.3)' : 'none',
                  }}>
                  {smsSending && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"/>}
                  {smsSent ? '✓ SMS Sent Successfully' : smsSending ? 'Sending…' : `Send SMS to ${phone.trim()}`}
                </button>
              )}

              {smsError && (
                <div className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'color-mix(in oklab, var(--sem-flag) var(--sem-mix), var(--surface))', color: 'var(--sem-flag-ink)', border: '1px solid color-mix(in oklab, var(--sem-flag) 28%, transparent)' }}>
                  {smsError}
                </div>
              )}

              {!smsEndpoint && phone.trim() && (
                <p className="text-xs text-center" style={{ color: 'var(--ink-2)' }}>
                  Copy the SMS above and send to {phone.trim()}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid var(--line)' }}>
              <button onClick={() => setStep('form')}
                className="text-xs flex items-center gap-1"
                style={{ color: 'var(--ink-2)' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Edit details
              </button>
              <button onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: 'var(--brand)', color: 'var(--brand-ink)' }}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
