import { useEffect, useState } from 'react';
import { GIRDER_BASE } from '../../config/girder.js';

const EXPIRY_OPTIONS = [
  { label: '24 hours', days: 1 },
  { label: '48 hours', days: 2 },
  { label: '7 days', days: 7 },
];

async function createShareToken(itemId, durationDays) {
  const sessionToken = localStorage.getItem('girderToken') || '';
  try {
    const keyRes = await fetch(`${GIRDER_BASE}/api_key`, {
      method: 'POST',
      headers: { 'Girder-Token': sessionToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: `image-share-${itemId}-${Date.now()}`,
        active: 'true',
        tokenDuration: String(durationDays),
      }),
    });
    if (!keyRes.ok) return sessionToken;
    const keyData = await keyRes.json();
    if (!keyData?.key) return sessionToken;

    const tokenRes = await fetch(`${GIRDER_BASE}/api_key/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: keyData.key, duration: String(durationDays) }),
    });
    if (!tokenRes.ok) return sessionToken;
    const tokenData = await tokenRes.json();
    return tokenData?.authToken?.token || sessionToken;
  } catch (_) {
    return sessionToken;
  }
}

export default function ShareImageModal({ item, onClose }) {
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleGenerate = async () => {
    if (!item?._id) return;
    setGenerating(true);
    setError('');
    try {
      const opt = EXPIRY_OPTIONS[expiryIdx];
      const token = await createShareToken(item._id, opt.days);
      const payload = {
        itemId: item._id,
        itemName: item.name,
        gt: token,
        api: GIRDER_BASE,
        expiry: Date.now() + (opt.days * 86_400_000),
      };
      const encoded = btoa(JSON.stringify(payload));
      setShareUrl(`${window.location.origin}${window.location.pathname}#/shared-image/${encoded}`);
    } catch (e) {
      setError('Could not generate image link.');
    }
    setGenerating(false);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-xl p-5 w-full max-w-md flex flex-col gap-4"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.55)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold" style={{ color: 'var(--text)' }}>Share Single Image</h2>
            <div className="text-xs mt-1 break-all" style={{ color: 'var(--muted)' }}>{item?.name}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700/50 transition-colors" style={{ color: 'var(--muted)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(77,166,255,0.08)', border: '1px solid rgba(77,166,255,0.2)', color: 'var(--muted)' }}>
          This creates a temporary public link for this image only. No login is required to open it.
        </div>

        <div>
          <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>Link expiry</div>
          <div className="flex gap-2">
            {EXPIRY_OPTIONS.map((opt, i) => (
              <button key={opt.label} onClick={() => setExpiryIdx(i)}
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

        {!shareUrl ? (
          <button onClick={handleGenerate} disabled={generating}
            className="w-full py-2 rounded-lg text-sm font-medium"
            style={{ background: 'rgba(77,166,255,0.18)', color: '#4da6ff', border: '1px solid rgba(77,166,255,0.3)' }}>
            {generating ? 'Generating...' : 'Generate Image Link'}
          </button>
        ) : (
          <>
            <textarea readOnly value={shareUrl} rows={4}
              className="login-input resize-none w-full"
              style={{ fontSize: 11, lineHeight: 1.4, fontFamily: 'IBM Plex Mono, monospace' }}/>
            <button onClick={copyLink}
              className="w-full py-2 rounded-lg text-sm font-medium"
              style={{ background: 'rgba(76,175,130,0.18)', color: '#4caf82', border: '1px solid rgba(76,175,130,0.3)' }}>
              {copied ? 'Copied' : 'Copy Link'}
            </button>
          </>
        )}

        {error && <div className="text-xs" style={{ color: '#e94560' }}>{error}</div>}
      </div>
    </div>
  );
}
